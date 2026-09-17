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

// 真实代理引擎：拉取 DECCUS001 → 原子写 OutBox → 回报状态 → 轮询 InBox 上传回执 → 心跳。

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
  if (state.authFailed || state.channelClosed) {
    debug('鉴权失败或通道关闭，本轮跳过拉取', 'pull')
    return
  }

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
      return patch({ connected: false, lastError: res.msg })
    }

    patch({ connected: true, authFailed: false, channelClosed: false, lastError: null, tickCount: state.tickCount + 1 })

    for (const task of res.tasks || []) {
      if (!state.enabled) break
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

async function processInboxFile(cfg, file, dirs) {
  const buf = await fs.readFile(file.full)
  const sha = sha256Hex(buf)
  const prev = getReceiptRecord(file.full, sha)
  if (prev?.status === 'UPLOADED') {
    debug(`回执已上传过，跳过 ${file.name}`, 'receipt')
    return
  }
  if (prev?.status === 'UNMATCHED') {
    // 未匹配过的不反复打接口，等人工/后端处理
    return
  }
  if (prev?.status === 'FAILED_CONTENT') {
    return
  }

  if (buf.length > 3 * 1024 * 1024) {
    warn(`回执超过 3MiB，移入 failed：${file.name}`, 'receipt')
    await upsertReceipt({ path: file.full, sha256: sha, fileName: file.name, status: 'FAILED_CONTENT', message: 'oversize' })
    const dest = path.join(dirs.failBox, file.name)
    await fs.mkdir(dirs.failBox, { recursive: true })
    await fs.rename(file.full, dest).catch(() => {})
    return
  }

  const b64 = buf.toString('base64')
  if (b64.length > 4 * 1024 * 1024) {
    warn(`回执 Base64 超过 4MiB，移入 failed：${file.name}`, 'receipt')
    await upsertReceipt({ path: file.full, sha256: sha, fileName: file.name, status: 'FAILED_CONTENT', message: 'oversize-b64' })
    await fs.mkdir(dirs.failBox, { recursive: true })
    await fs.rename(file.full, path.join(dirs.failBox, file.name)).catch(() => {})
    return
  }

  const receivedAt = formatDateTime(new Date(file.mtime))
  info(`上传回执 ${file.name} size=${buf.length}`, 'receipt')
  const res = await uploadReceipt(cfg, {
    fileName: file.name,
    receivedAt,
    receiptXmlBase64: b64
  })

  if (!res.ok) {
    if (res.code === BIZ_CODE.RECEIPT_INVALID || res.code === BIZ_CODE.RECEIPT_TOO_LARGE) {
      warn(`回执内容非法/过大，移入 failed：${file.name} ${res.msg}`, 'receipt')
      await upsertReceipt({
        path: file.full,
        sha256: sha,
        fileName: file.name,
        status: 'FAILED_CONTENT',
        message: res.msg
      })
      await fs.mkdir(dirs.failBox, { recursive: true })
      await fs.rename(file.full, path.join(dirs.failBox, file.name)).catch(() => {})
      patch({ lastError: `回执 ${file.name}：${res.msg}` })
      return
    }
    if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
      patch({ authFailed: true, lastError: res.msg })
      return
    }
    // 网络/临时错误：保留原文件重试
    warn(`回执上传失败，保留重试：${file.name} ${res.msg}`, 'receipt')
    patch({ lastError: `回执上传失败：${res.msg}` })
    return
  }

  const data = res.data || {}
  if (data.duplicate || data.matched) {
    await upsertReceipt({
      path: file.full,
      sha256: sha,
      fileName: file.name,
      status: 'UPLOADED',
      message: data.duplicate ? 'duplicate' : `matched task ${data.taskId}`
    })
    await fs.mkdir(dirs.sentBox, { recursive: true })
    const dest = path.join(dirs.sentBox, file.name)
    // 目标重名则加时间后缀
    const exists = await fs.stat(dest).then(() => true).catch(() => false)
    const finalDest = exists ? path.join(dirs.sentBox, `${Date.now()}_${file.name}`) : dest
    await fs.rename(file.full, finalDest).catch(async () => {
      // 跨盘失败则 copy+unlink
      await fs.copyFile(file.full, finalDest)
      await fs.unlink(file.full)
    })
    info(`回执已归档 ${file.name} → ${path.basename(finalDest)} matched=${!!data.matched} duplicate=${!!data.duplicate}`, 'receipt')
    patch({ receipts: state.receipts + 1, lastError: null })
    return
  }

  // matched=false：后端已留档但未匹配业务，不归档、不重试，告警等核查
  warn(`回执未匹配到业务任务，保留原文件：${file.name}`, 'receipt')
  await upsertReceipt({
    path: file.full,
    sha256: sha,
    fileName: file.name,
    status: 'UNMATCHED',
    message: 'matched=false'
  })
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
      const key = inboxEntryKey(f.full)
      const prev = inboxStable.get(key)
      if (prev && prev.size === f.size && prev.mtime === f.mtime && now - prev.seenAt >= 1500) {
        ready.push(f)
      } else {
        inboxStable.set(key, { size: f.size, mtime: f.mtime, seenAt: now })
      }
    }
    // 清理已消失文件的稳定记录
    const live = new Set(files.map((f) => f.full))
    for (const k of inboxStable.keys()) {
      if (!live.has(k)) inboxStable.delete(k)
    }

    if (!ready.length) return

    try {
      await ensureWritableDir(dirs.sentBox, '归档目录')
      await ensureWritableDir(dirs.failBox, '失败目录')
    } catch (e) {
      warn(`归档/失败目录不可用：${e.message}`, 'receipt')
      return
    }

    for (const f of ready) {
      if (!state.enabled) break
      try {
        await processInboxFile(cfg, f, dirs)
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
        debug(`服务器时钟偏移 ${state.clockOffsetMs}ms now=${nowText}`, 'heartbeat')
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
