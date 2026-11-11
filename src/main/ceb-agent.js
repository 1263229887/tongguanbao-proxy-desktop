import fs from 'node:fs/promises'
import path from 'node:path'
import { effectiveApiUrl, loadConfig } from './config.js'
import {
  BIZ_CODE,
  formatDateTime,
  maskKey,
  missingAccess,
  parseDateTime,
  pullCebTasks,
  reportCebTaskStatus,
  sha256Hex,
  uploadCebReceipt
} from './backend.js'
import {
  cebDeliveredWithoutReceipt,
  cebPendingTaskCount,
  getCebReceiptRecord,
  getCebRoundRecord,
  getCebTaskRecord,
  initLedger,
  unreportedCebTasks,
  upsertCebReceipt,
  upsertCebTask
} from './ledger.js'
import { debug, error, info, warn } from './logger.js'
import { reportAnomaly } from './log-upload.js'
import { getLink, nowWithOffset, setLinkPatch } from './link-state.js'
import { CEB_ROUTES, CEB_TRADE_MODES, cebChannelDeliverable } from '../shared/biz-types.js'

// 跨境电商（CEB）代理引擎（CB-AGENT-01）：按路由拉取 CEB303/505/603 → 按报文 dxpId 匹配渠道目录
// → 原子写发送目录 → 回报 OUTBOX_DROPPED → 轮询各渠道接收目录上传回执。
// 与 DEC（agent.js）各用各的接口族、账本与轮询；连接级事实（鉴权/通道/时钟）经 link-state 共享，
// 心跳由 DEC 侧统一持有（本引擎经注入的 hooks 启停），两族任一运行即保持心跳。
//
// 渠道：现场每个渠道一个独立传输客户端（深圳公服只是其中之一），各有自己的收发目录。
// 任务归属按报文 BaseTransfer.dxpId 匹配本地渠道配置；dxpId 留空的渠道作为该路由兜底目录。
// 回执只读不移动；CEB 回执文件名与原报文的对应关系现场未确认，不做本地 taskId 关联，
// 统一带 route 上传原始字节，由后端按回执 XML 内容匹配（CEB304/506/604 各有匹配键）。

const state = {
  running: false,
  enabled: false,
  polling: false,
  connected: null,
  processed: 0,
  delivered: 0,
  receipts: 0,
  lastTickAt: null,
  lastError: null,
  tickCount: 0,
  instanceName: ''
}

let broadcast = () => {}
let taskTimer = null
let inboxTimer = null
let taskBusy = false
let inboxBusy = false

// 心跳归 DEC 侧（agent.js）统一持有；本引擎启停时经注入的 hooks 申请/释放心跳，避免引入循环依赖
let heartbeatHooks = { ensure: () => {}, release: () => {} }
export function setCebHeartbeatHooks(hooks) {
  heartbeatHooks = { ...heartbeatHooks, ...hooks }
}

// 路由被后端拒绝（未开通/实例不在名单，1050004000）时的低频重试冷却，避免每 10s 刷屏
const ROUTE_COOLDOWN_MS = 5 * 60_000
const routeCooldownUntil = new Map()

function patch(values) {
  Object.assign(state, values)
  broadcast({ ...state })
  return { ...state }
}

export function onCebStateChange(fn) {
  broadcast = fn
}

export function getCebState() {
  return { ...state }
}

export function isCebRunning() {
  return state.enabled
}

function activeChannels(cfg) {
  return (cfg.cebChannels || []).filter((c) => c && c.enabled !== false)
}

/** 有可投递渠道（启用且配了发送目录）的路由集合——只领这些路由的任务，领了无法投递的任务只会空耗租约 */
function deliverableRoutes(cfg) {
  const routes = new Set()
  for (const ch of activeChannels(cfg)) {
    if (cebChannelDeliverable(ch)) routes.add(ch.route)
  }
  return [...routes]
}

/** 按报文 dxpId 匹配渠道：先精确匹配，再回落到该路由 dxpId 留空的兜底渠道 */
function matchChannel(cfg, route, dxpId) {
  const channels = activeChannels(cfg).filter((c) => c.route === route && cebChannelDeliverable(c))
  if (dxpId) {
    const exact = channels.find((c) => String(c.dxpId || '').trim() === dxpId)
    if (exact) return exact
  }
  return channels.find((c) => !String(c.dxpId || '').trim()) || null
}

function routeLabel(route) {
  return CEB_ROUTES.find((r) => r.id === route)?.label || route
}

function isLeaseValid(leaseExpireAt) {
  const t = parseDateTime(leaseExpireAt)
  if (t == null) return true
  return nowWithOffset() < t
}

async function ensureWritableDir(dir, label) {
  if (!dir) throw new Error(`${label}未配置`)
  await fs.mkdir(dir, { recursive: true })
  await fs.access(dir)
}

function tempNameFor(fileName, taskId) {
  return `.${fileName}.${taskId}.tmp`
}

/**
 * 从 CEB 报文原始字节提取 BaseTransfer.dxpId（渠道匹配键）。
 * 与 DEC 提取 ClientSeqNo 同法：不引 XML 解析器，在 latin1 上正则匹配，
 * 不解析实体/DTD/命名空间（天然满足 XXE 防护），允许命名空间前缀；结果不回写文件。
 */
function extractDxpId(buf) {
  const m = buf
    .toString('latin1')
    .match(/<(?:[A-Za-z_][\w.-]*:)?dxpId>\s*([^<]*?)\s*<\/(?:[A-Za-z_][\w.-]*:)?dxpId>/)
  const v = m ? m[1].trim() : ''
  return v || null
}

/** 文件名防穿越：后端指定的 fileName 不得带路径分隔符/上级引用，且必须是 .xml */
function safeFileName(fileName) {
  const name = String(fileName || '')
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return /\.xml$/i.test(name)
}

/**
 * 投递单个 CEB 任务。顺序与 DEC 一致：
 * 路由/报文类型核对 → 渠道匹配 → 账本查重 → 校验哈希/租约/大小 → 临时文件 → PREPARED → 原子 rename → DELIVERED → 回报。
 * 只有确认文件未进入发送目录时才报 FAILED；已落盘但回报失败只重试同一 OUTBOX_DROPPED（交给 reconcile）。
 */
async function deliverCebTask(cfg, task, pulledRoute) {
  const {
    taskId,
    tenantId,
    orderId,
    tradeMode,
    messageType,
    route,
    operation,
    messageGuid,
    fileName,
    xmlSha256,
    dispatchToken,
    leaseExpireAt,
    decXmlBase64
  } = task

  const summary = `taskId=${taskId}${tenantId != null ? ` tenant=${tenantId}` : ''} order=${orderId ?? '-'} mode=${tradeMode} type=${messageType} route=${route} file=${fileName} sha=${String(xmlSha256).slice(0, 12)}…`

  const fail = async (message, { anomaly } = {}) => {
    warn(`${message}。${summary}`, 'deliver')
    if (anomaly) reportAnomaly(anomaly.type, `${anomaly.detail}（${summary}）`)
    await reportCebTaskStatus(cfg, taskId, { dispatchToken, status: 'FAILED', message })
    return { ok: false, reason: message }
  }

  if (route !== pulledRoute || !CEB_ROUTES.some((r) => r.id === route)) {
    return fail(`任务路由 ${route} 与领取路由 ${pulledRoute} 不一致，停止投递`)
  }
  const routeDef = CEB_ROUTES.find((r) => r.id === route)
  if (!routeDef.messageTypes.includes(messageType)) {
    return fail(`路由 ${route} 不支持报文类型 ${messageType}，停止投递`)
  }
  if (!messageGuid) {
    return fail('任务缺少 messageGuid（CEB 投递轮次标识），停止投递')
  }
  if (!safeFileName(fileName)) {
    return fail(`文件名非法（须为不含路径的 .xml）：${fileName}`)
  }

  let xml
  try {
    xml = Buffer.from(String(decXmlBase64 || ''), 'base64')
  } catch {
    xml = Buffer.alloc(0)
  }
  if (!xml.length) return fail('CEB XML 解码失败或为空')
  if (xml.length > 3 * 1024 * 1024) return fail('CEB XML 超过 3MiB 限制')

  const actualSha = sha256Hex(xml)
  if (actualSha !== String(xmlSha256 || '').toLowerCase()) {
    warn(`XML SHA-256 不一致，拒绝写盘。${summary} actual=${actualSha.slice(0, 12)}…`, 'deliver')
    return fail('CEB XML 校验失败')
  }

  // 渠道匹配：dxpId 精确 → 路由兜底；都没有则报 FAILED（前端可见原因，配好渠道后可重投）
  const dxpId = extractDxpId(xml)
  const channel = matchChannel(cfg, route, dxpId)
  if (!channel) {
    return fail(`未配置渠道目录（dxpId=${dxpId || '报文未携带'}，路由 ${route}），请在「目录配置」添加对应渠道`, {
      anomaly: {
        type: 'ceb-channel-unmatched',
        detail: `跨境电商任务找不到对应渠道目录（dxpId=${dxpId || '报文未携带'}，路由 ${route}），已回报失败；请在「目录配置」添加该渠道并填写发送目录后，在平台页面重投`
      }
    })
  }
  const sendDir = String(channel.sendDir || '').trim()
  const channelTag = `渠道=${channel.name || channel.id}${dxpId ? ` dxp=${dxpId}` : ''}`

  try {
    await ensureWritableDir(sendDir, '发送目录')
  } catch (e) {
    warn(`发送目录不可写：${e.message}。${summary} ${channelTag}`, 'deliver')
    reportAnomaly('ceb-outbox-unwritable', `跨境电商渠道「${channel.name || channel.id}」发送目录不可写，任务无法投递：${e.message}，请检查目录配置与磁盘/权限`)
    await reportCebTaskStatus(cfg, taskId, { dispatchToken, status: 'FAILED', message: '渠道发送目录不可写' })
    return { ok: false, reason: e.message }
  }

  // messageGuid 是 CEB 投递轮次标识：同 taskId 新 messageGuid + xmlSha256 = 重投新轮次，正常投递；
  // 只有同一 messageGuid 对应不同 xmlSha256 才属协议异常
  const existing = getCebTaskRecord(route, taskId, messageGuid, xmlSha256)
  const priorRound = getCebRoundRecord(route, taskId, messageGuid)
  if (priorRound && priorRound.xmlSha256 !== xmlSha256) {
    const msg = `同一 messageGuid=${messageGuid} 对应不同 xmlSha256，属协议异常，停止处理。${summary}`
    error(msg, 'deliver')
    patch({ lastError: msg })
    return { ok: false, reason: msg, needManual: true }
  }

  const ledgerBase = {
    route,
    taskId,
    messageGuid,
    xmlSha256,
    tenantId: tenantId ?? null,
    orderId: orderId ?? null,
    tradeMode: tradeMode ?? null,
    messageType,
    operation: operation ?? null,
    channelId: channel.id,
    dxpId,
    fileName,
    tempName: tempNameFor(fileName, taskId),
    sendDir,
    dispatchToken,
    leaseExpireAt: parseDateTime(leaseExpireAt),
    firstAt: existing?.firstAt || Date.now()
  }

  if (existing?.status === 'DELIVERED') {
    debug(`账本已 DELIVERED，仅回报状态。${summary}`, 'deliver')
    const rep = await reportCebTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: '本地账本已记录投递，直接回报'
    })
    if (rep.ok) {
      await upsertCebTask({ route, taskId, messageGuid, xmlSha256, reportOk: true })
      info(`状态回报成功（账本去重回补）taskId=${taskId}`, 'deliver')
      patch({ processed: state.processed + 1 })
    }
    return { ok: true, dedup: true }
  }

  if (!isLeaseValid(leaseExpireAt)) {
    warn(`租约已过期，跳过写盘，等待后端裁决。${summary}`, 'deliver')
    patch({ lastError: `任务 ${taskId} 租约已过期` })
    return { ok: false, reason: '租约已过期' }
  }

  const temp = path.join(sendDir, tempNameFor(fileName, taskId))
  const finalPath = path.join(sendDir, fileName)

  try {
    const finalStat = await fs.stat(finalPath).catch(() => null)
    if (finalStat) {
      const finalSha = sha256Hex(await fs.readFile(finalPath))
      if (finalSha === xmlSha256) {
        info(`正式文件已存在且哈希一致，补记 DELIVERED。${summary} ${channelTag}`, 'deliver')
        await upsertCebTask({ ...ledgerBase, status: 'DELIVERED' })
        const rep = await reportCebTaskStatus(cfg, taskId, {
          dispatchToken,
          status: 'OUTBOX_DROPPED',
          message: '正式文件已在发送目录，账本补记 DELIVERED'
        })
        if (rep.ok) {
          await upsertCebTask({ route, taskId, messageGuid, xmlSha256, reportOk: true })
          patch({ processed: state.processed + 1, delivered: state.delivered + 1 })
        }
        return { ok: true }
      }
      warn(`目标文件已存在但哈希不同，禁止覆盖。${summary}`, 'deliver')
      patch({ lastError: `目标文件已存在且内容不同：${fileName}` })
      return { ok: false, reason: '目标文件已存在且内容不同' }
    }

    const fh = await fs.open(temp, 'w')
    try {
      await fh.writeFile(xml)
      await fh.sync()
    } finally {
      await fh.close()
    }

    if (!isLeaseValid(leaseExpireAt)) {
      await fs.unlink(temp).catch(() => {})
      warn(`rename 前租约过期，已删除临时文件。${summary}`, 'deliver')
      patch({ lastError: `任务 ${taskId} 在 rename 前租约过期` })
      return { ok: false, reason: 'rename 前租约过期' }
    }

    await upsertCebTask({ ...ledgerBase, status: 'PREPARED' })
    await fs.rename(temp, finalPath)
    await upsertCebTask({ route, taskId, messageGuid, xmlSha256, status: 'DELIVERED', dispatchToken })

    info(`已写入发送目录：${summary} ${channelTag}`, 'deliver')
    const rep = await reportCebTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: `已写入${routeLabel(route)}发送目录，投递账本已落库`
    })
    if (!rep.ok) {
      // 文件已进发送目录，只能重试同一 OUTBOX_DROPPED，绝不能改报 FAILED；补报交给 reconcileCebReports
      warn(`状态回报失败（文件已投递）：${rep.msg}。${summary}`, 'deliver')
      patch({ lastError: `任务 ${taskId} 已投递但回报失败：${rep.msg}` })
      return { ok: false, deliveredButReportFailed: true, reason: rep.msg }
    }
    await upsertCebTask({ route, taskId, messageGuid, xmlSha256, reportOk: true })
    info(`状态回报成功 OUTBOX_DROPPED taskId=${taskId}`, 'deliver')
    patch({ processed: state.processed + 1, delivered: state.delivered + 1, lastError: null })
    return { ok: true }
  } catch (e) {
    error(`投递异常：${e.message}。${summary}`, 'deliver')
    patch({ lastError: e.message })
    return { ok: false, reason: e.message }
  }
}

/** 补报：已 DELIVERED 但回报未确认的任务，只重试同一个 OUTBOX_DROPPED（文档 §落盘与结果上报） */
async function reconcileCebReports(cfg) {
  for (const rec of unreportedCebTasks()) {
    if (!state.enabled) return
    const rep = await reportCebTaskStatus(cfg, rec.taskId, {
      dispatchToken: rec.dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: '补报：文件已投递，此前回报未获确认'
    })
    const key = { route: rec.route, taskId: rec.taskId, messageGuid: rec.messageGuid, xmlSha256: rec.xmlSha256 }
    if (rep.ok) {
      await upsertCebTask({ ...key, reportOk: true })
      info(`补报成功 taskId=${rec.taskId}`, 'deliver')
    } else if (rep.code === BIZ_CODE.TASK_NOT_FOUND || rep.code === BIZ_CODE.STATUS_CONFLICT || rep.code === BIZ_CODE.CEB_BIZ_REJECTED) {
      await upsertCebTask({ ...key, reportOk: true, reportConflictCode: rep.code })
      warn(`补报被拒绝 taskId=${rec.taskId} code=${rep.code} ${rep.msg}，已停止重复回报，需双方核查`, 'deliver')
      patch({ lastError: `任务 ${rec.taskId} 状态回报冲突（code=${rep.code}），需双方核查` })
    } else {
      debug(`补报未成功，等待下轮 taskId=${rec.taskId} ${rep.msg}`, 'deliver')
    }
  }
}

async function tickCebTasks() {
  if (taskBusy || !state.enabled) return
  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) return patch({ lastError: `缺少 ${miss.join('、')}`, connected: false })
  const link = getLink()
  if (link.authFailed || link.channelClosed) return

  taskBusy = true
  patch({ lastTickAt: Date.now() })
  try {
    const routes = deliverableRoutes(cfg)
    if (!routes.length) {
      return patch({ lastError: '跨境电商渠道未配置：请先在「目录配置」添加渠道并填写发送目录' })
    }

    let anyOk = false
    for (const route of routes) {
      if (!state.enabled) break
      if (Date.now() < (routeCooldownUntil.get(route) || 0)) continue

      const res = await pullCebTasks(cfg, { route, tradeModes: CEB_TRADE_MODES, batchSize: cfg.batchSize })
      if (!res.ok) {
        if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
          setLinkPatch({ authFailed: true })
          patch({ connected: false, lastError: res.msg })
          warn(`企业鉴权密钥无效：${res.msg}`, 'pull')
          reportAnomaly('auth-failed', `企业鉴权密钥无效，已暂停拉取任务：${res.msg}，请在「权限配置」核对密钥`)
          return
        }
        if (res.code === BIZ_CODE.CHANNEL_CLOSED || res.httpStatus === 503) {
          setLinkPatch({ channelClosed: true })
          patch({ connected: false, lastError: res.msg })
          warn(`前置机通道关闭：${res.msg}`, 'pull')
          reportAnomaly('channel-closed', `前置机通道被平台关闭：${res.msg}，请联系平台处理`)
          return
        }
        if (res.code === BIZ_CODE.CEB_BIZ_REJECTED) {
          // 未开通路由/实例不在名单：低频重试，告警一次，不影响其他路由
          routeCooldownUntil.set(route, Date.now() + ROUTE_COOLDOWN_MS)
          warn(`CEB 路由 ${route} 暂不可用（${res.msg}），${ROUTE_COOLDOWN_MS / 60_000} 分钟后重试`, 'pull')
          patch({ lastError: `路由 ${routeLabel(route)}：${res.msg}` })
          continue
        }
        patch({ connected: false, lastError: res.msg })
        continue
      }

      anyOk = true
      setLinkPatch({ authFailed: false, channelClosed: false })
      patch({ connected: true, lastError: null, tickCount: state.tickCount + 1 })

      for (const task of res.tasks || []) {
        if (!state.enabled) break
        debug(`领取 CEB 任务入队 taskId=${task.taskId} route=${route} type=${task.messageType} file=${task.fileName}`, 'pull')
        await deliverCebTask(cfg, task, route)
      }
    }

    if (state.enabled && anyOk) await reconcileCebReports(cfg)
  } catch (e) {
    patch({ connected: false, lastError: e.message })
  } finally {
    taskBusy = false
    broadcast({ ...state })
  }
}

// ---------- 回执扫描（各渠道接收目录，只读不移动） ----------

const inboxStable = new Map()
const shaCache = new Map()
/** 已终态（ACKED_* 与 PERMANENT_REJECTED）或非 CEB 文件的内存跳过表：内容变化后自动失效 */
const settled = new Map()

async function scanInboxOnce(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!/\.xml$/i.test(name)) continue
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    try {
      const st = await fs.stat(full)
      if (!st.isFile()) continue
      out.push({ full, name, size: st.size, mtime: st.mtimeMs })
    } catch {
      // ignore
    }
  }
  return out
}

async function fileSha(file) {
  const hit = shaCache.get(file.full)
  if (hit && hit.size === file.size && hit.mtime === file.mtime) return hit.sha
  const buf = await fs.readFile(file.full)
  const sha = sha256Hex(buf)
  shaCache.set(file.full, { size: file.size, mtime: file.mtime, sha })
  return sha
}

function backoffMs(retryCount) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, retryCount))
  return Math.round(base * (1 + Math.random() * 0.2))
}

/** 是否 CEB 报文（回执 CEB304/506/604 等）：原始字节上匹配根节点，不解析 XML */
function isCebMessage(buf) {
  return /<(?:[A-Za-z_][\w.-]*:)?CEB\d{3}Message/.test(buf.toString('latin1'))
}

/**
 * 处理单个回执文件：稳定后按原始字节读取 → SHA-256 查重 → 大小预检 → 带 route 上传 → 按响应矩阵入账本。
 * 不做本地 taskId 关联（CEB 回执文件名对应关系现场未确认），由后端按 XML 内容匹配；
 * matched=false 留档告警，非法/超大永久拒绝，网络/临时错误指数退避，文件始终留在接收目录。
 */
async function processCebReceipt(cfg, channel, file) {
  const sha = await fileSha(file)
  const rec = getCebReceiptRecord(channel.route, sha)
  if (rec) {
    if (rec.state !== 'RETRY_PENDING') {
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      debug(`CEB 回执已处理（${rec.state}），跳过 ${file.name} sha=${sha.slice(0, 12)}`, 'receipt')
      return
    }
    if (Date.now() < (rec.nextRetryAt ?? 0)) return
  }

  const buf = await fs.readFile(file.full)
  // 非 CEB 报文（其他系统/历史文件）不属本引擎：不传不入库，内容不变期间跳过
  if (!isCebMessage(buf)) {
    settled.set(file.full, { size: file.size, mtime: file.mtime })
    return
  }

  const common = {
    route: channel.route,
    xmlSha256: sha,
    fullPath: file.full,
    fileName: file.name,
    size: file.size,
    mtime: file.mtime,
    channelId: channel.id,
    lastAttemptAt: Date.now(),
    firstSeenAt: rec?.firstSeenAt ?? Date.now(),
    retryCount: rec?.retryCount ?? 0
  }

  const b64 = buf.length > 3 * 1024 * 1024 ? null : buf.toString('base64')
  if (!b64 || b64.length > 4 * 1024 * 1024) {
    warn(`CEB 回执超过大小限制（解码 3MiB / Base64 4MiB），记为永久拒绝，文件保留：${file.name}`, 'receipt')
    await upsertCebReceipt({ ...common, state: 'PERMANENT_REJECTED', message: '本地预检：回执超过大小限制' })
    settled.set(file.full, { size: file.size, mtime: file.mtime })
    patch({ lastError: `回执 ${file.name} 超过大小限制，待客户处理` })
    return
  }

  const receivedAt = formatDateTime(new Date(file.mtime))
  debug(`上传 CEB 回执 ${file.name} size=${buf.length} route=${channel.route} retry=${common.retryCount}`, 'receipt')
  const res = await uploadCebReceipt(cfg, { route: channel.route, fileName: file.name, receivedAt, receiptXmlBase64: b64 })

  if (!res.ok) {
    if (res.code === BIZ_CODE.RECEIPT_INVALID || res.code === BIZ_CODE.RECEIPT_TOO_LARGE || res.code === BIZ_CODE.CEB_BIZ_REJECTED) {
      warn(`CEB 回执被后端拒绝（code=${res.code}），记为永久拒绝，文件保留：${file.name} ${res.msg}`, 'receipt')
      await upsertCebReceipt({ ...common, state: 'PERMANENT_REJECTED', message: res.msg })
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      patch({ lastError: `回执 ${file.name} 被拒绝：${res.msg}` })
      return
    }
    if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
      setLinkPatch({ authFailed: true })
      patch({ lastError: res.msg })
      reportAnomaly('auth-failed', `上传回执时鉴权失败，已暂停：${res.msg}，请在「权限配置」核对密钥`)
      return
    }
    const retryCount = common.retryCount + 1
    const delay = backoffMs(retryCount)
    warn(`CEB 回执上传失败，约 ${Math.round(delay / 1000)}s 后重试（第 ${retryCount} 次）：${file.name} ${res.msg}`, 'receipt')
    await upsertCebReceipt({ ...common, retryCount, state: 'RETRY_PENDING', message: res.msg, nextRetryAt: Date.now() + delay })
    patch({ lastError: `回执上传失败：${res.msg}` })
    return
  }

  const data = res.data || {}
  if (data.matched) {
    await upsertCebReceipt({
      ...common,
      state: 'ACKED_MATCHED',
      taskId: data.taskId ?? null,
      returnStatus: data.returnStatus ?? null,
      receiptId: data.receiptId ?? null,
      message: data.duplicate ? 'duplicate' : 'matched',
      nextRetryAt: null
    })
    settled.set(file.full, { size: file.size, mtime: file.mtime })
    info(`CEB 回执已确认 taskId=${data.taskId} returnStatus=${data.returnStatus} duplicate=${!!data.duplicate} ${file.name}`, 'receipt')
    patch({ receipts: state.receipts + 1, lastError: null })
    return
  }

  warn(`CEB 回执未匹配到任务（ACKED_UNMATCHED），文件保留待人工核查：${file.name}`, 'receipt')
  await upsertCebReceipt({ ...common, state: 'ACKED_UNMATCHED', message: 'matched=false', nextRetryAt: null })
  settled.set(file.full, { size: file.size, mtime: file.mtime })
  patch({ lastError: `回执未匹配：${file.name}` })
}

async function tickCebInbox() {
  if (inboxBusy || !state.enabled) return
  const link = getLink()
  if (link.authFailed || link.channelClosed) return
  const cfg = await loadConfig()
  const channels = activeChannels(cfg).filter((c) => String(c.receiveDir || '').trim())
  if (!channels.length) return

  inboxBusy = true
  try {
    checkCebReceiptsMissing()
    const now = Date.now()
    const ready = []
    const live = new Set()
    for (const channel of channels) {
      const files = await scanInboxOnce(String(channel.receiveDir).trim())
      for (const f of files) {
        live.add(f.full)
        const done = settled.get(f.full)
        if (done && done.size === f.size && done.mtime === f.mtime) continue
        const prev = inboxStable.get(f.full)
        if (prev && prev.size === f.size && prev.mtime === f.mtime && now - prev.seenAt >= 1500) {
          ready.push({ channel, file: f })
        } else {
          inboxStable.set(f.full, { size: f.size, mtime: f.mtime, seenAt: now })
        }
      }
    }
    for (const k of inboxStable.keys()) if (!live.has(k)) inboxStable.delete(k)
    for (const k of shaCache.keys()) if (!live.has(k)) shaCache.delete(k)
    for (const k of settled.keys()) if (!live.has(k)) settled.delete(k)

    for (const { channel, file } of ready) {
      if (!state.enabled) break
      try {
        await processCebReceipt(cfg, channel, file)
      } catch (e) {
        error(`处理 CEB 回执异常 ${file.name}：${e.message}`, 'receipt')
      }
    }
  } finally {
    inboxBusy = false
  }
}

// ---------- 回执缺失粗检：整条路由投递后长时间静默 → 疑似传输客户端没跑/接收目录配错 ----------
const RECEIPT_GRACE_MS = 30 * 60_000
const RECEIPT_CHECK_INTERVAL_MS = 5 * 60_000
let lastReceiptCheckAt = 0

function checkCebReceiptsMissing() {
  if (Date.now() - lastReceiptCheckAt < RECEIPT_CHECK_INTERVAL_MS) return
  lastReceiptCheckAt = Date.now()
  try {
    for (const route of CEB_ROUTES.map((r) => r.id)) {
      const stuck = cebDeliveredWithoutReceipt(route, RECEIPT_GRACE_MS)
      if (!stuck.length) continue
      const oldestMin = Math.round((Date.now() - Math.min(...stuck.map((r) => r.firstAt || Date.now()))) / 60_000)
      reportAnomaly(
        'ceb-receipt-missing',
        `${routeLabel(route)}回执疑似异常：${stuck.length} 个任务已投递超过 ${Math.round(RECEIPT_GRACE_MS / 60_000)} 分钟，整条路由未再收到任何回执（最早 ${oldestMin} 分钟前投递）。请检查对应传输客户端（如深圳公服客户端）是否运行、接收目录配置是否与对方一致`,
        { minIntervalMs: 30 * 60_000 }
      )
      patch({ lastError: '已投递任务长时间未收到回执，请检查对应传输客户端' })
    }
  } catch (e) {
    debug(`CEB 回执缺失检测异常：${e.message}`, 'receipt')
  }
}

/** 心跳用：各路由渠道目录健康（tradeMode 字段仅展示，填路由标识） */
export async function getCebDirHealth() {
  const cfg = await loadConfig()
  const channels = activeChannels(cfg)
  const out = []
  for (const route of CEB_ROUTES.map((r) => r.id)) {
    const chs = channels.filter((c) => c.route === route)
    if (!chs.length) continue
    let outboxOk = true
    let inboxOk = true
    for (const c of chs) {
      if (c.sendDir) {
        try {
          await fs.access(c.sendDir)
        } catch {
          outboxOk = false
        }
      } else outboxOk = false
      if (c.receiveDir) {
        try {
          await fs.access(c.receiveDir)
        } catch {
          inboxOk = false
        }
      } else inboxOk = false
    }
    out.push({ tradeMode: route, outboxOk, inboxOk })
  }
  return out
}

export { cebPendingTaskCount }

function clearTimers() {
  for (const t of [taskTimer, inboxTimer]) if (t) clearInterval(t)
  taskTimer = inboxTimer = null
}

export async function startCebAgent() {
  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) return patch({ enabled: false, running: false, lastError: `缺少 ${miss.join('、')}` })
  if (!deliverableRoutes(cfg).length) {
    return patch({ enabled: false, running: false, lastError: '请先在「目录配置」添加跨境电商渠道并填写发送目录' })
  }

  await initLedger()
  clearTimers()
  state.enabled = true
  patch({ instanceName: cfg.instanceName, running: true, polling: true, lastError: null })

  // 措辞避开「代理已启动/已停止」：upgrade-restore 的旧版本兜底推断按这两个子串识别 DEC 启停，
  // CEB 日志若含同样子串会被误算成货物申报在运行
  info(
    `跨境电商引擎已启动 instance=${cfg.instanceName} api=${effectiveApiUrl(cfg)} key=${maskKey(cfg.agentKey)} 渠道=${activeChannels(cfg).length} 路由=${deliverableRoutes(cfg).join(',')} 任务间隔=${cfg.pollIntervalSeconds}s 回执间隔=${cfg.inboxIntervalSeconds}s`,
    'agent'
  )

  void tickCebTasks()
  void tickCebInbox()
  heartbeatHooks.ensure()

  taskTimer = setInterval(tickCebTasks, Math.max(1, cfg.pollIntervalSeconds) * 1000)
  inboxTimer = setInterval(tickCebInbox, Math.max(1, cfg.inboxIntervalSeconds) * 1000)
  return getCebState()
}

export function stopCebAgent() {
  state.enabled = false
  clearTimers()
  heartbeatHooks.release()
  info('跨境电商引擎已停止', 'agent')
  return patch({ running: false, polling: false })
}

export async function resumeCebAgent() {
  if (!state.enabled) {
    clearTimers()
    return patch({ running: false, polling: false })
  }
  return startCebAgent()
}

/** 睡眠恢复后立即跑一轮（仅在已启动时；未启动不拉起，避免改变用户的启停选择） */
export async function runCebOnce() {
  if (!state.enabled) return getCebState()
  await initLedger()
  await tickCebTasks()
  await tickCebInbox()
  checkCebReceiptsMissing()
  return getCebState()
}

/** 安装更新/退出前收尾：等待在途的任务投递与回执上传 */
export async function waitCebIdle(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while ((taskBusy || inboxBusy) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
  }
}