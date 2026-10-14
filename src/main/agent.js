import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { effectiveApiUrl, loadConfig } from './config.js'
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
  deliveredFileStems,
  deliveredRoundsByClientSeqNo,
  getReceiptRecord,
  getRoundRecord,
  getTaskRecord,
  initLedger,
  pendingTaskCount,
  unreportedTasks,
  upsertReceipt,
  upsertTask
} from './ledger.js'
import { debug, error, info, warn } from './logger.js'
import { clearCrashNote, getCrashNote } from './crash-guard.js'
import { getUploadError, reportAnomaly } from './log-upload.js'
import { deliveredWithoutReceipt } from './ledger.js'

// 真实代理引擎（文档 v1.4）：拉取 DECCUS001 → 原子写 OutBox → 回报状态 → 轮询 InBox 上传回执 → 心跳。
// clientSeqNo 为申报轮次标识：同 taskId 新轮次正常投递，账本按 taskId+clientSeqNo+xmlSha256 三段键记录。
// 回执只读不移动，且只处理属于本代理已投递任务的回执（按文件名主干识别归属）；
// 以 SHA-256 为唯一标识，处理状态入 SQLite 账本（ACKED_MATCHED/ACKED_UNMATCHED/RETRY_PENDING/PERMANENT_REJECTED）。
//
// 平台跨租户模式（跨租户文档 v1.0，自动识别：pull 响应任务带 tenantId 即为平台 Key）：
// 一个平台 Key 处理所有有效业务租户，四个接口协议不变；差异仅在上传回执必须携带本地关联出的 taskId
// （文件名主干预筛后，从回执原始字节提取 ClientSeqNo，投递账本恰好命中一条才算关联成功），
// tenantId 只落账本与日志用于审计排障，不参与目录选择、不进请求体。

/**
 * 当前启用的业务模块定义。后期新增模块时新增描述符并各起一套轮询：
 * 目录取 cfg.bizDirs[对应的组]、pull 按 moduleCode 过滤、账本按 businessModuleCode 隔离，
 * 各模块的任务队列、回执归属、目录互不混用。
 */
const BIZ = {
  bizType: 'goods', // 参数配置里的业务目录组 id
  moduleCode: 'DECCUS001', // 后端 businessModuleCode 白名单（货物申报/报关单暂存）
  tradeModes: ['export', 'import', '9610'] // 本模块允许拉取的任务分类
}

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
  module: BIZ.moduleCode,
  platformMode: null // null=尚未识别；true=平台跨租户模式（回执上传带 taskId）；false=普通租户模式
}

let broadcast = () => {}
let taskTimer = null
let inboxTimer = null
let heartbeatTimer = null
let taskBusy = false
let inboxBusy = false
let heartbeatBusy = false
let clockOffsetWarned = false
let heartbeatTenantWarned = false

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
  const d = cfg.bizDirs?.[BIZ.bizType]
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
    tenantId,
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

  const summary = `taskId=${taskId}${tenantId != null ? ` tenant=${tenantId}` : ''} order=${orderId} mode=${tradeMode} file=${fileName} sha=${String(xmlSha256).slice(0, 12)}…`

  if (businessModuleCode && businessModuleCode !== BIZ.moduleCode) {
    warn(`不支持的业务模块 ${businessModuleCode}，停止投递并告警。${summary}`, 'deliver')
    return { ok: false, reason: `不支持的业务模块 ${businessModuleCode}` }
  }

  try {
    await ensureWritableDir(dirs.outBox, 'OutBox')
  } catch (e) {
    warn(`OutBox 不可写：${e.message}`, 'deliver')
    reportAnomaly('outbox-unwritable', `统一 OutBox 目录不可写，任务无法投递到单一窗口：${e.message}，请检查目录配置与磁盘/权限`)
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

  // v1.4：clientSeqNo 是申报轮次唯一标识。同 taskId 出现新 clientSeqNo + xmlSha256 = 失败重报的新轮次，
  // 必须新增账本记录并正常投递；只有同一 clientSeqNo 对应不同 xmlSha256 才属协议异常
  const existing = getTaskRecord(taskId, clientSeqNo, xmlSha256)
  const priorRound = getRoundRecord(taskId, clientSeqNo)
  if (priorRound && priorRound.xmlSha256 !== xmlSha256) {
    const msg = `同一 clientSeqNo=${clientSeqNo} 对应不同 xmlSha256，属协议异常，停止处理。${summary}`
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
      await upsertTask({ taskId, clientSeqNo, xmlSha256, reportOk: true })
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
          tenantId: tenantId ?? null,
          tradeMode: tradeMode ?? null,
          fileName,
          tempName: tempNameFor(fileName, taskId),
          outBox: dirs.outBox,
          status: 'DELIVERED',
          dispatchToken,
          businessModuleCode: businessModuleCode || BIZ.moduleCode,
          leaseExpireAt,
          firstAt: existing?.firstAt || Date.now()
        })
        const rep = await reportTaskStatus(cfg, taskId, {
          dispatchToken,
          status: 'OUTBOX_DROPPED',
          message: '正式文件已在 OutBox，账本补记 DELIVERED'
        })
        if (rep.ok) {
          await upsertTask({ taskId, clientSeqNo, xmlSha256, reportOk: true })
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
      tenantId: tenantId ?? null,
      tradeMode: tradeMode ?? null,
      fileName,
      tempName: tempNameFor(fileName, taskId),
      outBox: dirs.outBox,
      status: 'PREPARED',
      dispatchToken,
      businessModuleCode: businessModuleCode || BIZ.moduleCode,
      leaseExpireAt,
      firstAt: existing?.firstAt || Date.now()
    })

    await atomicRename(temp, finalPath)

    await upsertTask({
      taskId,
      clientSeqNo,
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
    await upsertTask({ taskId, clientSeqNo, xmlSha256, reportOk: true })
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
 * 平台跨租户模式自动识别（跨租户文档 §2）：平台 Key 的 pull 响应额外返回任务真实 tenantId。
 * 首次识别后整个会话内保持：一旦升级为平台模式不再降级，避免后端偶发缺字段导致回执漏带 taskId。
 */
function detectPlatformMode(tasks) {
  if (!tasks.length) return
  const hasTenant = tasks.some((t) => t?.tenantId != null)
  if (hasTenant && state.platformMode !== true) {
    patch({ platformMode: true })
    info('pull 响应包含 tenantId，按平台跨租户模式运行：回执上传将携带本地关联的 taskId', 'pull')
  } else if (!hasTenant && state.platformMode == null) {
    patch({ platformMode: false })
    info('pull 响应不含 tenantId，按普通租户模式运行', 'pull')
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
      await upsertTask({ taskId: rec.taskId, clientSeqNo: rec.clientSeqNo, xmlSha256: rec.xmlSha256, reportOk: true })
      info(`补报成功 taskId=${rec.taskId}`, 'deliver')
    } else if (rep.code === BIZ_CODE.TASK_NOT_FOUND || rep.code === BIZ_CODE.STATUS_CONFLICT) {
      await upsertTask({
        taskId: rec.taskId,
        clientSeqNo: rec.clientSeqNo,
        xmlSha256: rec.xmlSha256,
        reportOk: true,
        reportConflictCode: rep.code
      })
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
      tradeModes: BIZ.tradeModes,
      batchSize: cfg.batchSize
    })

    if (!res.ok) {
      if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
        patch({ authFailed: true, connected: false, lastError: res.msg })
        warn(`企业鉴权密钥无效：${res.msg}`, 'pull')
        reportAnomaly('auth-failed', `企业鉴权密钥无效，已暂停拉取任务：${res.msg}，请在「权限配置」核对密钥`)
        return
      }
      if (res.code === BIZ_CODE.CHANNEL_CLOSED || res.httpStatus === 503) {
        patch({ channelClosed: true, connected: false, lastError: res.msg })
        warn(`前置机通道关闭：${res.msg}`, 'pull')
        reportAnomaly('channel-closed', `前置机通道被平台关闭：${res.msg}，请联系平台处理`)
        return
      }
      // 例行失败不逐条刷屏：从连通转为失败时告警一次
      if (state.connected !== false) warn(`拉取任务失败：${res.msg}`, 'pull')
      return patch({ connected: false, lastError: res.msg })
    }

    patch({ connected: true, authFailed: false, channelClosed: false, lastError: null, tickCount: state.tickCount + 1 })

    detectPlatformMode(res.tasks || [])

    for (const task of res.tasks || []) {
      if (!state.enabled) break
      // debug：本轮条数已由 backend.pullTasks 汇总记录，逐条投递结果由「已写入 OutBox」承载，
      // 这里再记一条 info 等于每个任务两行，任务量上来就把当天日志刷满
      debug(
        `领取任务入队 taskId=${task.taskId}${task.tenantId != null ? ` tenant=${task.tenantId}` : ''} sha=${String(task.xmlSha256 || '').slice(0, 12)} file=${task.fileName}`,
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

// ---------- 回执缺失检测 ----------
// 有任务投递成功、但 InBox 里迟迟见不到对应回执 → 大概率是单一窗口导入客户端没跑起来、
// 「接收回执」没启动或回执目录配错。这类故障用户不点开目录根本发现不了，
// 必须自动上报（写日志并立即补传当天日志），而不是等定时/手动上传。
const RECEIPT_GRACE_MS = 30 * 60_000 // 投递后容忍多久没回执（单一窗口回执通常分钟级）
const RECEIPT_CHECK_INTERVAL_MS = 5 * 60_000 // 检测节奏：tickInbox 每 3 秒一轮，这里节流到 5 分钟
let lastReceiptCheckAt = 0

function checkReceiptsMissing(inboxFiles) {
  if (Date.now() - lastReceiptCheckAt < RECEIPT_CHECK_INTERVAL_MS) return
  lastReceiptCheckAt = Date.now()
  try {
    const pending = deliveredWithoutReceipt(BIZ.moduleCode, RECEIPT_GRACE_MS)
    if (!pending.length) return
    // InBox 里已出现同名主干文件 = 回执已到、只是还在排队处理，不算异常
    const inboxText = inboxFiles.map((f) => f.name.replace(/\.xml$/i, '')).join('\n')
    const stuck = pending.filter((r) => !inboxText.includes(String(r.fileName).replace(/\.xml$/i, '')))
    if (!stuck.length) return
    const oldestMin = Math.round((Date.now() - Math.min(...stuck.map((r) => r.firstAt || Date.now()))) / 60_000)
    reportAnomaly(
      'receipt-missing',
      `单一窗口回执疑似异常：${stuck.length} 个任务已投递超过 ${Math.round(RECEIPT_GRACE_MS / 60_000)} 分钟仍未收到回执（最早 ${oldestMin} 分钟前投递）。请检查中国国际贸易单一窗口导入客户端是否运行、「接收回执」是否启动、InBox 回执目录配置是否与单一窗口一致`,
      { minIntervalMs: 30 * 60_000 }
    )
    patch({ lastError: '已投递任务长时间未收到单一窗口回执，请检查单一窗口导入客户端' })
  } catch (e) {
    debug(`回执缺失检测异常：${e.message}`, 'receipt')
  }
}

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
 * 心跳 lastError 的取值：业务异常 > 上次崩溃/异常退出 > 日志上传连续失败。
 * 三者都要让后端在「前置机监控告警」里看见，但字段只有一条，按谁更需要人工介入排序。
 * 崩溃与日志上传的异常不在 state 里，所以这里现取。
 */
function heartbeatLastError() {
  return state.lastError || getCrashNote() || getUploadError() || ''
}

/**
 * 从回执原始字节提取 ClientSeqNo（跨租户文档 §7.3，仅用于本地任务关联）。
 * 不引入 XML 解析器：在原始字节上按 ASCII 兼容编码（UTF-8/GBK）做正则匹配，
 * 不解析实体/DTD/命名空间，天然满足"禁用 DTD、外部实体和 XInclude"的 XXE 防护要求；
 * 允许带命名空间前缀；上传时仍使用最初读取的原始字节，本函数结果不回写文件。
 */
function extractClientSeqNo(buf) {
  const m = buf
    .toString('latin1')
    .match(/<(?:[A-Za-z_][\w.-]*:)?ClientSeqNo>\s*([0-9A-Za-z_-]+)\s*<\/(?:[A-Za-z_][\w.-]*:)?ClientSeqNo>/)
  return m ? m[1] : null
}

/**
 * 回执处理（文档 v1.3 §7.3）：只读 InBox 文件，绝不移动/重命名/删除（§7.3.4）。
 * 以 XML 原始字节 SHA-256 为唯一标识（§7.3.5），结果按 §7.3 响应矩阵写入 SQLite 账本：
 * matched=true（duplicate 任意）→ ACKED_MATCHED；matched=false → ACKED_UNMATCHED；
 * 1050000204/205 或本地大小预检不过 → PERMANENT_REJECTED；网络/临时错误 → RETRY_PENDING 指数退避。
 *
 * 平台跨租户模式（跨租户文档 §7/§8）：上传前必须本地关联 taskId——
 * 提取 XML 内 ClientSeqNo → 查投递账本恰好命中一条 DELIVERED 轮次；
 * 未命中/多候选（不同租户可能同流水号）→ LOCAL_UNMATCHED，停止自动上传并告警等人工核查；
 * 已携带 taskId 仍返回 1050000209（与 ClientSeqNo 不匹配）→ PERMANENT_REJECTED，停止重试当前组合；
 * 未携带 taskId 时返回 1050000209（模式尚未识别的启动窗口）→ 按 RETRY_PENDING 重试，识别后再关联。
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
    bizModule: BIZ.moduleCode,
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

  // 平台跨租户模式：先本地关联 taskId（跨租户文档 §7），未命中/多候选停止自动上传并告警
  let platformTask = null
  if (state.platformMode) {
    const seqNo = extractClientSeqNo(buf)
    if (!seqNo) {
      warn(`无法从回执提取 ClientSeqNo，记为永久拒绝，文件保留在 InBox：${file.name}`, 'receipt')
      await upsertReceipt({ ...common, state: 'PERMANENT_REJECTED', message: '无法从回执 XML 提取 ClientSeqNo' })
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      patch({ lastError: `回执 ${file.name} 无法提取 ClientSeqNo，待人工核查` })
      return
    }
    const rounds = deliveredRoundsByClientSeqNo(seqNo)
    if (rounds.length !== 1) {
      const why = rounds.length
        ? `ClientSeqNo=${seqNo} 在本地账本命中 ${rounds.length} 条任务（跨租户流水号重复），无法确定归属`
        : `ClientSeqNo=${seqNo} 未命中本地投递账本`
      warn(`回执无法唯一关联任务，停止自动上传待人工核查：${file.name} ${why}`, 'receipt')
      await upsertReceipt({ ...common, clientSeqNo: seqNo, state: 'LOCAL_UNMATCHED', message: why })
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      patch({ lastError: `回执 ${file.name} 无法唯一关联任务，待人工核查` })
      return
    }
    platformTask = rounds[0]
    common.clientSeqNo = platformTask.clientSeqNo
    common.tenantId = platformTask.tenantId ?? null
  }

  const receivedAt = formatDateTime(new Date(file.mtime))
  // debug：成功由「回执已确认」记一条，失败由各分支的 warn 记一条，这里再记 info 会成对重复
  debug(
    `上传回执 ${file.name} size=${buf.length} retry=${common.retryCount}${platformTask ? ` taskId=${platformTask.taskId}` : ''}`,
    'receipt'
  )
  const res = await uploadReceipt(cfg, {
    ...(platformTask ? { taskId: platformTask.taskId, tradeMode: platformTask.tradeMode } : {}),
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
    if (res.code === BIZ_CODE.RECEIPT_TASK_MISMATCH && platformTask) {
      // 已携带 taskId 仍不匹配：任务身份冲突，停止重试当前组合并核查本地关联（跨租户文档 §11.2/§12）
      warn(`回执 taskId=${platformTask.taskId} 与 ClientSeqNo 不匹配（1050000209），记为永久拒绝，请核查本地关联：${file.name} ${res.msg}`, 'receipt')
      await upsertReceipt({ ...common, state: 'PERMANENT_REJECTED', message: res.msg })
      settled.set(file.full, { size: file.size, mtime: file.mtime })
      patch({ lastError: `回执 ${file.name} taskId 与 ClientSeqNo 不匹配，待人工核查` })
      return
    }
    if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
      patch({ authFailed: true, lastError: res.msg })
      reportAnomaly('auth-failed', `上传回执时鉴权失败，已暂停：${res.msg}，请在「权限配置」核对密钥`)
      return
    }
    // 网络异常、响应未知或可重试的服务端错误：RETRY_PENDING + 指数退避，文件始终留在 InBox。
    // 未携带 taskId 时收到 1050000209（首次 pull 未完成、模式未识别的启动窗口）也走重试，
    // 平台模式识别后会带 taskId 重新关联上传
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
    // 回执归属过滤：单一窗口回执名 = 前缀 + 所投递文件主干 + 流水号。
    // 只处理文件名能对上某个本代理 DELIVERED 任务主干的回执；
    // 其他系统/历史文件不读、不传、不入库（PREPARED 未落地的任务不会产生回执，不参与匹配）
    const stems = deliveredFileStems(BIZ.moduleCode)
    checkReceiptsMissing(files)
    const now = Date.now()
    const ready = []
    for (const f of files) {
      const noExt = f.name.replace(/\.xml$/i, '')
      if (!stems.some((s) => noExt.includes(s))) continue
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
      lastError: heartbeatLastError()
    })

    if (!res.ok) {
      if (res.code === BIZ_CODE.BAD_KEY || res.httpStatus === 401) {
        patch({ authFailed: true, connected: false, lastError: res.msg, lastHeartbeatAt: Date.now() })
        reportAnomaly('auth-failed', `心跳上报鉴权失败：${res.msg}，请在「权限配置」核对密钥`)
        return
      }
      if (res.code === BIZ_CODE.CHANNEL_CLOSED || res.httpStatus === 503) {
        patch({ channelClosed: true, connected: false, lastError: res.msg, lastHeartbeatAt: Date.now() })
        reportAnomaly('channel-closed', `心跳上报通道被平台关闭：${res.msg}，请联系平台处理`)
        return
      }
      if (res.code === BIZ_CODE.HEARTBEAT_TENANT_UNSET) {
        // 1050000208（跨租户文档 §12）：后端未配置平台 heartbeat 归属租户。
        // 属后端配置问题，不阻断既有心跳节奏（30s+ 本身即低频探测），告警一次并提示联系后端运维
        if (!heartbeatTenantWarned) {
          warn(`后端未配置平台心跳归属租户（1050000208），保持低频心跳重试：${res.msg}`, 'heartbeat')
          heartbeatTenantWarned = true
        }
        patch({ lastError: '后端未配置平台心跳归属租户（1050000208），请联系后端运维', lastHeartbeatAt: Date.now() })
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
    heartbeatTenantWarned = false
    // 崩溃摘要上报成功一次即清除：一直挂着会掩盖之后真正的业务异常，
    // 而且它已经随当天日志补传到了平台，后端要看细节去日志里看
    clearCrashNote()
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

  // initLedger 幂等：日志上传可能已在 bootstrap 阶段打开账本，这里直接复用同一个连接
  const file = await initLedger()
  debug(`投递账本：${file}`, 'ledger')

  clearTimers()
  state.enabled = true
  patch({ instanceName: cfg.instanceName, running: true, polling: true, lastError: null })

  const urlHint = effectiveApiUrl(cfg)
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

/** 安装更新/退出前调用：已停代理后等待在途的任务投递与回执上传收尾（各 HTTP 调用有 20s 超时上限） */
export async function waitIdle(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while ((taskBusy || inboxBusy) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
  }
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
  await initLedger()
  await tickTasks()
  await tickInbox()
  await tickHeartbeat()
  return getAgentState()
}
