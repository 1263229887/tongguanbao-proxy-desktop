import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { loadConfig } from './config.js'
import {
  BIZ_CODE,
  formatDateTime,
  maskKey,
  missingAccess,
  parseDateTime,
  pullTasks,
  reportTaskStatus,
  sendHeartbeat,
  sha256Hex,
  uploadReceipt
} from './backend.js'
import {
  findTaskByTaskId,
  getReceiptRecord,
  getTaskRecord,
  initLedger,
  pendingTaskCount,
  unreportedTasks,
  upsertReceipt,
  upsertTask
} from './ledger.js'
import { debug, error, info, warn } from './logger.js'

// 真实代理引擎（文档 v1.3）：拉取 DECCUS001 → 原子写 OutBox → 回报状态 → 轮询 InBox 上传回执 → 心跳。
// 回执只读不移动：以 SHA-256 为唯一标识，处理状态入 SQLite 账本（ACKED_MATCHED/ACKED_UNMATCHED/RETRY_PENDING/PERMANENT_REJECTED）。

const SUPPORTED_MODULE = 'DECCUS001'
const TRADE_MODES = ['export', 'import', '9610']

const state = {
  running: false,
  enabled: false,
  polling: false,
  connected: null,
  processed: 0,
  delivered: 0,
  receipts: 0,
  lastTickAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  tickCount: 0,
  clockOffsetMs: 0,
  instanceName: '',
  module: SUPPORTED_MODULE
}

let broadcast = () => {}
let taskTimer = null
let inboxTimer = null
let heartbeatTimer = null
let taskBusy = false
let inboxBusy = false
let heartbeatBusy = false
let ledgerReady = false
let clockOffsetWarned = false

function patch(values) {
  Object.assign(state, values)
  broadcast({ ...state })
  return { ...state }
}

export function onStateChange(fn) {
  broadcast = fn
}

export function getAgentState() {
  return { ...state }
}

function goodsDirs(cfg) {
  const d = cfg.bizDirs?.goods
  return {
    outBox: d?.outBox || '',
    sentBox: d?.sentBox || '',
    inBox: d?.inBox || '',
    failBox: d?.failBox || ''
  }
}

function nowWithOffset() {
  return Date.now() + (state.clockOffsetMs || 0)
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

async function atomicRename(from, to) {
  await fs.rename(from, to)
}

/**
 * 投递单个任务。严格按文档顺序：
 * 账本查重 → 校验哈希/租约 → 临时文件 → PREPARED → 原子 rename → DELIVERED → 回报
 */
async function deliverTask(cfg, task) {
  const dirs = goodsDirs(cfg)
  const {
    taskId,
    orderId,
    tradeMode,
    businessModuleCode,
    clientSeqNo,
    fileName,
    xmlSha256,
    dispatchToken,
    leaseExpireAt,
    decXmlBase64
  } = task

  const summary = `taskId=${taskId} order=${orderId} mode=${tradeMode} file=${fileName} sha=${String(xmlSha256).slice(0, 12)}…`

  if (businessModuleCode && businessModuleCode !== SUPPORTED_MODULE) {
    warn(`不支持的业务模块 ${businessModuleCode}，停止投递并告警。${summary}`, 'deliver')
    return { ok: false, reason: `不支持的业务模块 ${businessModuleCode}` }
  }

  try {
    await ensureWritableDir(dirs.outBox, 'OutBox')
  } catch (e) {
    warn(`OutBox 不可写：${e.message}`, 'deliver')
    await reportTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'FAILED',
      message: '统一 OutBox 目录不可写'
    })
    return { ok: false, reason: e.message }
  }

  let xml
  try {
    xml = Buffer.from(String(decXmlBase64 || ''), 'base64')
  } catch {
    xml = Buffer.alloc(0)
  }
  if (!xml.length) {
    warn(`decXmlBase64 解码失败或为空。${summary}`, 'deliver')
    await reportTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'FAILED',
      message: 'DEC XML 解码失败'
    })
    return { ok: false, reason: 'decXmlBase64 无效' }
  }

  const actualSha = sha256Hex(xml)
  if (actualSha !== String(xmlSha256 || '').toLowerCase()) {
    warn(`XML SHA-256 不一致，拒绝写盘。${summary} actual=${actualSha.slice(0, 12)}…`, 'deliver')
    await reportTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'FAILED',
      message: 'DEC XML 校验失败'
    })
    return { ok: false, reason: 'SHA-256 不一致' }
  }

  const existing = getTaskRecord(taskId, xmlSha256)
  const sameTaskOtherHash = findTaskByTaskId(taskId)
  if (sameTaskOtherHash && sameTaskOtherHash.xmlSha256 !== xmlSha256) {
    const msg = `账本中同一 taskId 存在不同 xmlSha256，需人工处理。${summary}`
    error(msg, 'deliver')
    patch({ lastError: msg })
    return { ok: false, reason: msg, needManual: true }
  }

  if (existing?.status === 'DELIVERED') {
    debug(`账本已 DELIVERED，仅回报状态。${summary}`, 'deliver')
    const rep = await reportTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: '本地账本已记录投递，直接回报'
    })
    if (rep.ok) {
      await upsertTask({ taskId, xmlSha256, reportOk: true })
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

  const temp = path.join(dirs.outBox, tempNameFor(fileName, taskId))
  const finalPath = path.join(dirs.outBox, fileName)

  try {
    const finalStat = await fs.stat(finalPath).catch(() => null)
    if (finalStat) {
      const finalSha = sha256Hex(await fs.readFile(finalPath))
      if (finalSha === xmlSha256) {
        info(`正式文件已存在且哈希一致，补记 DELIVERED。${summary}`, 'deliver')
        await upsertTask({
          taskId,
          xmlSha256,
          clientSeqNo,
          fileName,
          tempName: tempNameFor(fileName, taskId),
          outBox: dirs.outBox,
          status: 'DELIVERED',
          dispatchToken,
          businessModuleCode: businessModuleCode || SUPPORTED_MODULE,
          leaseExpireAt,
          firstAt: existing?.firstAt || Date.now()
        })
        const rep = await reportTaskStatus(cfg, taskId, {
          dispatchToken,
          status: 'OUTBOX_DROPPED',
          message: '正式文件已在 OutBox，账本补记 DELIVERED'
        })
        if (rep.ok) {
          await upsertTask({ taskId, xmlSha256, reportOk: true })
          info(`状态回报成功（正式文件已存在补记）taskId=${taskId}`, 'deliver')
          patch({ processed: state.processed + 1, delivered: state.delivered + 1 })
        }
        return { ok: true }
      }
      warn(`目标文件已存在但哈希不同，禁止覆盖。${summary}`, 'deliver')
      patch({ lastError: `目标文件已存在且内容不同：${fileName}` })
      return { ok: false, reason: '目标文件已存在且内容不同' }
    }

    // 写临时文件并 flush
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

    await upsertTask({
      taskId,
      xmlSha256,
      clientSeqNo,
      fileName,
      tempName: tempNameFor(fileName, taskId),
      outBox: dirs.outBox,
      status: 'PREPARED',
      dispatchToken,
      businessModuleCode: businessModuleCode || SUPPORTED_MODULE,
      leaseExpireAt,
      firstAt: existing?.firstAt || Date.now()
    })

    await atomicRename(temp, finalPath)

    await upsertTask({
      taskId,
      xmlSha256,
      status: 'DELIVERED',
      dispatchToken
    })

    info(`已写入 OutBox：${summary}`, 'deliver')
    const rep = await reportTaskStatus(cfg, taskId, {
      dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: '已写入统一 OutBox，投递账本已落库'
    })
    if (!rep.ok) {
      // 文件已进 OutBox，只能重试同一 OUTBOX_DROPPED，绝不能改报 FAILED；补报交给 reconcileReports
      warn(`状态回报失败（文件已投递）：${rep.msg}。${summary}`, 'deliver')
      patch({ lastError: `任务 ${taskId} 已投递但回报失败：${rep.msg}` })
      return { ok: false, deliveredButReportFailed: true, reason: rep.msg }
    }
    await upsertTask({ taskId, xmlSha256, reportOk: true })
    info(`状态回报成功 OUTBOX_DROPPED taskId=${taskId}`, 'deliver')
    patch({ processed: state.processed + 1, delivered: state.delivered + 1, lastError: null })
    return { ok: true }
  } catch (e) {
    error(`投递异常：${e.message}。${summary}`, 'deliver')
    patch({ lastError: e.message })
    return { ok: false, reason: e.message }
  }
}

/**
 * 补报：文件已投递（账本 DELIVERED）但 OUTBOX_DROPPED 回报未获后端确认的任务。
 * 文档 §6/§10：只重试同一个 OUTBOX_DROPPED 请求，不改报 FAILED、不重写文件；
 * 1050000202/1050000203 说明后端已处理或状态不允许，停止重试并告警供双方核查。
 */
async function reconcileReports(cfg) {
  const list = unreportedTasks()
  for (const rec of list) {
    if (!state.enabled) return
    const rep = await reportTaskStatus(cfg, rec.taskId, {
      dispatchToken: rec.dispatchToken,
      status: 'OUTBOX_DROPPED',
      message: '补报：文件已投递，此前回报未获确认'
    })
    if (rep.ok) {
      await upsertTask({ taskId: rec.taskId, xmlSha256: rec.xmlSha256, reportOk: true })
      info(`补报成功 taskId=${rec.taskId}`, 'deliver')
    } else if (rep.code === BIZ_CODE.TASK_NOT_FOUND || rep.code === BIZ_CODE.STATUS_CONFLICT) {
      await upsertTask({ taskId: rec.taskId, xmlSha256: rec.xmlSha256, reportOk: true, reportConflictCode: rep.code })
      warn(`补报被拒绝 taskId=${rec.taskId} code=${rep.code} ${rep.msg}，已停止重复回报，需双方核查`, 'deliver')
      patch({ lastError: `任务 ${rec.taskId} 状态回报冲突（code=${rep.code}），需双方核查` })
    } else {
      debug(`补报未成功，等待下轮 taskId=${rec.taskId} ${rep.msg}`, 'deliver')
    }
  }
}

async function tickTasks() {
  if (taskBusy) return
  if (!state.enabled) return
  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) {
    return patch({ lastError: `缺少 ${miss.join('、')}`, connected: false })
  }

  // 鉴权失败 / 通道关闭时降频，不拉新任务
  if (state.authFailed || state.channelClosed) return

  taskBusy = true
  patch({ lastTickAt: Date.now() })
  try {
    const dirs = goodsDirs(cfg)
    if (!dirs.outBox) {
      return patch({ lastError: '货物申报 OutBox 未配置' })
    }

    const res = await pullTasks(cfg, {
      tradeModes: TRADE_MODES,
      batchSize: cfg.batchSize
    })

    if (!res.ok) {
      if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
        patch({ authFailed: true, connected: false, lastError: res.msg })
        warn(`企业鉴权密钥无效：${res.msg}`, 'pull')
        return
      }
      if (res.code === BIZ_CODE.CHANNEL_CLOSED || res.httpStatus === 503) {
        patch({ channelClosed: true, connected: false, lastError: res.msg })
        warn(`前置机通道关闭：${res.msg}`, 'pull')
        return
      }
      // 例行失败不逐条刷屏：从连通转为失败时告警一次
      if (state.connected !== false) warn(`拉取任务失败：${res.msg}`, 'pull')
      return patch({ connected: false, lastError: res.msg })
    }

    patch({ connected: true, authFailed: false, channelClosed: false, lastError: null, tickCount: state.tickCount + 1 })

    for (const task of res.tasks || []) {
      if (!state.enabled) break
      info(
        `领取任务入队 taskId=${task.taskId} sha=${String(task.xmlSha256 || '').slice(0, 12)} file=${task.fileName}`,
        'pull'
      )
      await deliverTask(cfg, task)
    }

    // 本轮拉取成功说明网络通畅，顺手补报此前未确认的任务
    if (state.enabled) await reconcileReports(cfg)
  } catch (e) {
    patch({ connected: false, lastError: e.message })
  } finally {
    taskBusy = false
    broadcast({ ...state })
  }
}

/** 两次扫描文件大小与 mtime 均不变，才视为写入完成 */
const inboxStable = new Map()

function inboxEntryKey(full) {
  return full
}

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

/** 文档 §7.3.5：路径+大小+mtime 不变时复用 SHA-256，避免每轮对 InBox 全量读盘 */
const shaCache = new Map()

/** 已终态（ACKED_* / PERMANENT_REJECTED）回执的内存跳过表：内容变化后自动失效，重新按新 SHA 处理 */
const settled = new Map()

async function fileSha(file) {
  const hit = shaCache.get(file.full)
  if (hit && hit.size === file.size && hit.mtime === file.mtime) return hit.sha
  const buf = await fs.readFile(file.full)
  const sha = sha256Hex(buf)
  shaCache.set(file.full, { size: file.size, mtime: file.mtime, sha })
  return sha
}

/** 指数退避：1s 起步、×2、封顶 60s，加 0~20% 随机抖动（文档 §10） */
function backoffMs(retryCount) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, retryCount))
  return Math.round(base * (1 + Math.random() * 0.2))
}

/**
 * 回执处理（文档 v1.3 §7.3）：只读 InBox 文件，绝不移动/重命名/删除（§7.3.4）。
 * 以 XML 原始字节 SHA-256 为唯一标识（§7.3.5），结果按 §7.3 响应矩阵写入 SQLite 账本：
 * matched=true（duplicate 任意）→ ACKED_MATCHED；matched=false → ACKED_UNMATCHED；
 * 1050000204/205 或本地大小预检不过 → PERMANENT_REJECTED；网络/临时错误 → RETRY_PENDING 指数退避。
 */
async function processInboxFile(cfg, file) {
  const sha = await fileSha(file)
  const rec = getReceiptRecord(sha)
  if (rec) {
    if (rec.state !== 'RETRY_PENDING') {
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      debug(`回执已处理（${rec.state}），跳过 ${file.name} sha=${sha.slice(0, 12)}`, 'receipt')
      return
    }
    if (Date.now() < (rec.nextRetryAt ?? 0)) return
  }

  const buf = await fs.readFile(file.full)
  const common = {
    xmlSha256: sha,
    fullPath: file.full,
    fileName: file.name,
    size: file.size,
    mtime: file.mtime,
    lastAttemptAt: Date.now(),
    firstSeenAt: rec?.firstSeenAt ?? Date.now(),
    retryCount: rec?.retryCount ?? 0
  }

  // 本地大小预检（对应后端 1050000205，重试无意义）：记永久拒绝，文件留在 InBox
  const b64 = buf.length > 3 * 1024 * 1024 ? null : buf.toString('base64')
  if (!b64 || b64.length > 4 * 1024 * 1024) {
    warn(`回执超过大小限制（解码 3MiB / Base64 4MiB），记为永久拒绝，文件保留在 InBox：${file.name}`, 'receipt')
    await upsertReceipt({ ...common, state: 'PERMANENT_REJECTED', message: '本地预检：回执超过大小限制' })
    settled.set(file.full, { size: file.size, mtime: file.mtime })
    patch({ lastError: `回执 ${file.name} 超过大小限制，待客户处理` })
    return
  }

  const receivedAt = formatDateTime(new Date(file.mtime))
  info(`上传回执 ${file.name} size=${buf.length} retry=${common.retryCount}`, 'receipt')
  const res = await uploadReceipt(cfg, {
    fileName: file.name,
    receivedAt,
    receiptXmlBase64: b64
  })

  if (!res.ok) {
    if (res.code === BIZ_CODE.RECEIPT_INVALID || res.code === BIZ_CODE.RECEIPT_TOO_LARGE) {
      warn(`回执被后端拒绝（code=${res.code}），记为永久拒绝，文件保留在 InBox：${file.name} ${res.msg}`, 'receipt')
      await upsertReceipt({ ...common, state: 'PERMANENT_REJECTED', message: res.msg })
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      patch({ lastError: `回执 ${file.name} 被拒绝：${res.msg}` })
      return
    }
    if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
      patch({ authFailed: true, lastError: res.msg })
      return
    }
    // 网络异常、响应未知或可重试的服务端错误：RETRY_PENDING + 指数退避，文件始终留在 InBox
    const retryCount = common.retryCount + 1
    const delay = backoffMs(retryCount)
    warn(`回执上传失败，约 ${Math.round(delay / 1000)}s 后重试（第 ${retryCount} 次）：${file.name} ${res.msg}`, 'receipt')
    await upsertReceipt({
      ...common,
      retryCount,
      state: 'RETRY_PENDING',
      message: res.msg,
      nextRetryAt: Date.now() + delay
    })
    patch({ lastError: `回执上传失败：${res.msg}` })
    return
  }

  const data = res.data || {}
  if (data.matched) {
    await upsertReceipt({
      ...common,
      state: 'ACKED_MATCHED',
      taskId: data.taskId ?? null,
      customsStatus: data.customsStatus ?? null,
      message: data.duplicate ? 'duplicate' : 'matched',
      nextRetryAt: null
    })
    settled.set(file.full, { size: file.size, mtime: file.mtime })
    info(`回执已确认 taskId=${data.taskId} status=${data.customsStatus} duplicate=${!!data.duplicate} ${file.name}`, 'receipt')
    patch({ receipts: state.receipts + 1, lastError: null })
    return
  }

  // matched=false（无论 duplicate）：后端已接收但未匹配任务，停止自动重传并告警（§7.3.8）
  warn(`回执未匹配到任务（ACKED_UNMATCHED），文件保留在 InBox 待人工核查：${file.name}`, 'receipt')
  await upsertReceipt({ ...common, state: 'ACKED_UNMATCHED', message: 'matched=false', nextRetryAt: null })
  settled.set(file.full, { size: file.size, mtime: file.mtime })
  patch({ lastError: `回执未匹配：${file.name}` })
}

async function tickInbox() {
  if (inboxBusy || !state.enabled) return
  // 鉴权失败/通道关闭时停止高频上传（文档 §10），回执文件原地保留，等心跳探测恢复后再继续
  if (state.authFailed || state.channelClosed) return
  const cfg = await loadConfig()
  const dirs = goodsDirs(cfg)
  if (!dirs.inBox) return

  inboxBusy = true
  try {
    const files = await scanInboxOnce(dirs.inBox)
    const now = Date.now()
    const ready = []
    for (const f of files) {
      // 已终态且内容未变的文件直接跳过，不再进入稳定判定和处理
      const done = settled.get(f.full)
      if (done && done.size === f.size && done.mtime === f.mtime) continue
      const key = inboxEntryKey(f.full)
      const prev = inboxStable.get(key)
      if (prev && prev.size === f.size && prev.mtime === f.mtime && now - prev.seenAt >= 1500) {
        ready.push(f)
      } else {
        inboxStable.set(key, { size: f.size, mtime: f.mtime, seenAt: now })
      }
    }
    // 清理已消失文件的稳定记录与 SHA 缓存
    const live = new Set(files.map((f) => f.full))
    for (const k of inboxStable.keys()) {
      if (!live.has(k)) inboxStable.delete(k)
    }
    for (const k of shaCache.keys()) {
      if (!live.has(k)) shaCache.delete(k)
    }
    for (const k of settled.keys()) {
      if (!live.has(k)) settled.delete(k)
    }

    if (!ready.length) return

    for (const f of ready) {
      if (!state.enabled) break
      try {
        await processInboxFile(cfg, f)
      } catch (e) {
        error(`处理回执异常 ${f.name}：${e.message}`, 'receipt')
      }
    }
  } finally {
    inboxBusy = false
  }
}

async function tickHeartbeat() {
  if (heartbeatBusy || !state.enabled) return
  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) return

  heartbeatBusy = true
  try {
    const dirs = goodsDirs(cfg)
    let outboxOk = false
    let inboxOk = false
    try {
      if (dirs.outBox) {
        await fs.access(dirs.outBox)
        outboxOk = true
      }
    } catch {}
    try {
      if (dirs.inBox) {
        await fs.access(dirs.inBox)
        inboxOk = true
      }
    } catch {}

    const res = await sendHeartbeat(cfg, {
      version: app.getVersion(),
      ip: Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address)[0] || '',
      outboxOk,
      inboxOk,
      pendingTaskCount: pendingTaskCount(),
      lastError: state.lastError || ''
    })

    if (!res.ok) {
      if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
        patch({ authFailed: true, connected: false, lastError: res.msg, lastHeartbeatAt: Date.now() })
        return
      }
      if (res.code === BIZ_CODE.CHANNEL_CLOSED || res.httpStatus === 503) {
        patch({ channelClosed: true, connected: false, lastError: res.msg, lastHeartbeatAt: Date.now() })
        return
      }
      patch({ lastError: res.msg, lastHeartbeatAt: Date.now() })
      return
    }

    const nowText = res.data?.now
    if (nowText) {
      const serverTs = parseDateTime(nowText)
      if (serverTs != null) {
        state.clockOffsetMs = serverTs - Date.now()
        // 时钟偏移属异常才告警（租约判断依赖时钟），恢复正常自动解除
        const skewed = Math.abs(state.clockOffsetMs) > 120_000
        if (skewed && !clockOffsetWarned) {
          warn(`与服务器时钟偏移 ${Math.round(state.clockOffsetMs / 1000)}s，租约判断可能受影响，请校准本机时间（建议 NTP）`, 'heartbeat')
          clockOffsetWarned = true
        } else if (!skewed) {
          clockOffsetWarned = false
        }
      }
    }
    patch({
      connected: true,
      authFailed: false,
      channelClosed: false,
      lastHeartbeatAt: Date.now(),
      lastError: outboxOk && inboxOk ? null : state.lastError
    })
  } catch (e) {
    warn(`心跳异常：${e.message}`, 'heartbeat')
  } finally {
    heartbeatBusy = false
  }
}

function clearTimers() {
  for (const t of [taskTimer, inboxTimer, heartbeatTimer]) {
    if (t) clearInterval(t)
  }
  taskTimer = inboxTimer = heartbeatTimer = null
}

export async function startAgent() {
  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) {
    return patch({ enabled: false, running: false, lastError: `缺少 ${miss.join('、')}` })
  }
  const dirs = goodsDirs(cfg)
  if (!dirs.outBox || !dirs.inBox) {
    return patch({ enabled: false, running: false, lastError: '请先配置货物申报的 OutBox / InBox 目录' })
  }

  if (!ledgerReady) {
    const file = await initLedger()
    info(`投递账本：${file}`, 'agent')
    ledgerReady = true
  }

  clearTimers()
  state.enabled = true
  patch({ instanceName: cfg.instanceName, running: true, polling: true, lastError: null })

  const urlHint = cfg.apiUrl || '默认测试地址 https://www.tel365.com:8088'
  info(
    `代理已启动 instance=${cfg.instanceName} api=${urlHint} key=${maskKey(cfg.agentKey)} 任务间隔=${cfg.pollIntervalSeconds}s 回执间隔=${cfg.inboxIntervalSeconds}s 心跳间隔=${cfg.heartbeatIntervalSeconds}s`,
    'agent'
  )

  // 启动立刻跑一轮，避免干等定时器
  void tickTasks()
  void tickInbox()
  void tickHeartbeat()

  taskTimer = setInterval(tickTasks, Math.max(1, cfg.pollIntervalSeconds) * 1000)
  inboxTimer = setInterval(tickInbox, Math.max(1, cfg.inboxIntervalSeconds) * 1000)
  heartbeatTimer = setInterval(tickHeartbeat, Math.max(10, cfg.heartbeatIntervalSeconds) * 1000)

  return getAgentState()
}

export function stopAgent() {
  state.enabled = false
  clearTimers()
  info('代理已停止', 'agent')
  return patch({ running: false, polling: false })
}

export async function resumeAgent() {
  if (!state.enabled) {
    clearTimers()
    return patch({ running: false, polling: false })
  }
  return startAgent()
}

export async function runAgentOnce() {
  state.enabled = true
  if (!ledgerReady) {
    await initLedger()
    ledgerReady = true
  }
  await tickTasks()
  await tickInbox()
  await tickHeartbeat()
  return getAgentState()
}
