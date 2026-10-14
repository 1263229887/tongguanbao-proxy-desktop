import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { loadConfig } from './config.js'
import { BIZ_CODE, formatDateTime, missingAccess, uploadLogFile } from './backend.js'
import { getLogUpload, initLedger, resetTerminalLogUploads, upsertLogUpload } from './ledger.js'
import {
  flushLogger,
  getLogDir,
  info,
  listLogFiles,
  logFileDateKey,
  readLogBytes,
  setFileLevel,
  getFileLevel,
  todayKey,
  warn
} from './logger.js'

// 本地日志定期上传平台（《前置机日志文件上传对接文档》v1.0），便于后端远程排查客户现场问题。
// 节奏：日志按天滚动，每轮把已经「封口」（日期早于今天）且没传过的日志压缩后上传；
//       退出、安装更新、检测到上次异常退出时额外把当天日志补传一次。
// 进度记在 SQLite 账本 log_uploads 表，进程重启后接着做，断网/停机期间积压的日志恢复后自动补传。
// 例行成功不逐条落日志：只有真正传上去一个文件、或失败进入重试/终态时才写一行。

const gzip = promisify(zlib.gzip)

// 只是「多久看一眼有没有该传的文件」。日志按天封口，10 分钟足够，也够快接住断网恢复后的补传
const CHECK_INTERVAL_MS = 10 * 60_000
// 对接文档 §5.2：失败重试 3 次，间隔 1 / 5 / 15 分钟
const RETRY_DELAYS_MIN = [1, 5, 15]
// 对接文档 §4 单文件限 50MiB。日志按天滚动且没有大小上限，异常循环可能把单日文件写到很大，
// 超限时只保留尾部（最近的记录才是排障要的）；32MiB 文本 gzip 后只有几 MB，压缩率再差也到不了上限
const TAIL_BYTES = 32 * 1024 * 1024

let timer = null
let busy = false
// 安装更新时 electron-updater 会先把安装器拉起来再 app.quit()，那之后不能再等上传（会拖住安装）。
// 所以 quitAndInstall 自己先 flush 一次，再打开这个开关让 before-quit 的收尾直接跳过上传
let suppressExitFlush = false
// 平台未开通日志通道（1050000231）时只提示一次：那不是本机故障，
// 每轮都报会写成噪音，还会污染心跳 lastError 让后端误告警
let channelClosedNoticed = false
let uploadError = ''

// ---------- 上传通道翻转记录（边沿触发） ----------
// 平台重启/断网等导致的可重试失败（网络错误、5xx/502 网关）：首次记异常日志，
// 之后的成功上传记一条恢复日志并给出中断时长——排障时一对记录就是一个完整故障窗口。
// 断开期间不触发即时上传（必然失败），中断记录已写入本地日志，恢复后由重试/补传自然带到平台。
let channelDownSince = null

function noteUploadChannelDown(firstErr) {
  if (channelDownSince) return
  channelDownSince = Date.now()
  reportAnomaly('upload-channel-down', `日志上传通道不可用：${firstErr}，将自动重试并在恢复后补传`, { upload: false })
}

function noteUploadChannelUp() {
  if (!channelDownSince) return
  const durMin = Math.round((Date.now() - channelDownSince) / 60_000)
  channelDownSince = null
  info(`日志上传通道已恢复，本次中断持续约 ${durMin} 分钟`, 'upload')
}

// ---------- 异常自动上报 ----------
// 触发即写一条 WARN（进当天日志、随后随异常上传带上去），并立即补传当天日志。
// 同类异常按类型去重节流，避免刷屏与重复上传；异常期临时把写盘级别提到 debug
// 保留更多现场细节，窗口（10 分钟）过后自动恢复，无需用户配置。
const ANOMALY_DEBUG_WINDOW_MS = 10 * 60_000
const anomalyAt = new Map()
let debugRevertTimer = null
let debugRevertLevel = null

export function reportAnomaly(type, detail, { minIntervalMs = 30 * 60_000, upload = true } = {}) {
  const now = Date.now()
  const last = anomalyAt.get(type) ?? 0
  if (now - last < minIntervalMs) return false
  anomalyAt.set(type, now)
  warn(detail, 'anomaly')
  if (getFileLevel() !== 'debug') {
    debugRevertLevel = debugRevertLevel ?? getFileLevel()
    setFileLevel('debug')
    clearTimeout(debugRevertTimer)
    debugRevertTimer = setTimeout(() => {
      setFileLevel(debugRevertLevel ?? 'info')
      debugRevertLevel = null
    }, ANOMALY_DEBUG_WINDOW_MS)
  }
  if (upload) void run({ includeToday: true })
  return true
}

/** 供心跳汇总：连续上传失败要让后端能感知到「日志上传异常」（对接文档 §5.2） */
export function getUploadError() {
  return uploadError
}

function kb(bytes) {
  return `${Math.max(1, Math.round(Number(bytes) / 1024))}KB`
}

async function compress(file) {
  const raw = readLogBytes(file.name, { tailBytes: TAIL_BYTES })
  const truncated = raw.length < file.size
  const payload = truncated
    ? Buffer.concat([Buffer.from(`[日志过大，仅上传尾部 ${raw.length} 字节]\n`, 'utf8'), raw])
    : raw
  return { gz: await gzip(payload, { level: 9 }), truncated }
}

async function uploadOne(cfg, file) {
  const prev = getLogUpload(file.name)
  const base = {
    fileName: file.name,
    size: file.size,
    lastAttemptAt: Date.now(),
    firstSeenAt: prev?.firstSeenAt ?? Date.now()
  }

  let gz
  let truncated = false
  try {
    ;({ gz, truncated } = await compress(file))
  } catch (e) {
    warn(`日志压缩失败 ${file.name}：${e.message}`, 'upload')
    upsertLogUpload({ ...base, state: 'FAILED', nextRetryAt: null, message: `压缩失败：${e.message}` })
    return { state: 'FAILED', msg: `压缩失败：${e.message}` }
  }

  if (truncated) warn(`日志文件过大（${kb(file.size)}），仅上传尾部 ${kb(TAIL_BYTES)}：${file.name}`, 'upload')

  // 服务端用 UUID 重命名落盘，原始文件名存元数据表，这里带 .gz 后缀便于对方识别压缩格式
  const uploadName = `${file.name}.gz`
  const res = await uploadLogFile(cfg, {
    fileName: uploadName,
    bytes: gz,
    // 日志是补传的，必须带文件自己的产生时间，否则后端按接收时间排会打乱时间线
    logTime: formatDateTime(new Date(file.mtime))
  })

  if (res.ok) {
    upsertLogUpload({
      ...base,
      state: 'UPLOADED',
      retryCount: 0,
      nextRetryAt: null,
      remoteId: res.data?.id ?? null,
      remotePath: res.data?.filePath ?? null,
      message: ''
    })
    info(`日志已上传 ${uploadName} 原始 ${kb(file.size)} → 压缩 ${kb(gz.length)}${res.data?.id != null ? ` id=${res.data.id}` : ''}`, 'upload')
    uploadError = ''
    return { state: 'UPLOADED', msg: '' }
  }

  // 平台未开启日志上传通道：不是本机故障，静默记终态，不进心跳 lastError
  if (res.code === BIZ_CODE.LOG_CHANNEL_CLOSED) {
    upsertLogUpload({ ...base, state: 'BLOCKED', nextRetryAt: null, message: res.msg })
    if (!channelClosedNoticed) {
      channelClosedNoticed = true
      info(`平台未开启日志上传通道，日志继续保留在本机（${res.msg}）`, 'upload')
    }
    return { state: 'BLOCKED', msg: res.msg }
  }

  // 内容本身不被接受（空文件/超限/类型不允许/实例名缺失）：重传不会有别的结果，直接终态
  const rejected = [
    BIZ_CODE.LOG_FILE_EMPTY,
    BIZ_CODE.LOG_FILE_TOO_LARGE,
    BIZ_CODE.LOG_FILE_TYPE_NOT_ALLOWED,
    BIZ_CODE.LOG_INSTANCE_NAME_REQUIRED
  ]
  if (rejected.includes(res.code)) {
    warn(`日志被平台拒绝 ${uploadName}（code=${res.code}）：${res.msg}`, 'upload')
    upsertLogUpload({ ...base, state: 'FAILED', nextRetryAt: null, message: res.msg })
    return { state: 'FAILED', msg: res.msg }
  }

  // 鉴权失效 / 前置机通道关闭：重传同样会被拒，记 BLOCKED 等配置变更后再试，不空转
  if (res.fatal) {
    warn(`日志上传被拒绝 ${uploadName}（HTTP ${res.httpStatus}）：${res.msg}`, 'upload')
    upsertLogUpload({ ...base, state: 'BLOCKED', nextRetryAt: null, message: res.msg })
    return { state: 'BLOCKED', msg: res.msg }
  }

  // 网络或服务端临时错误（含接口 500「系统异常」）：按 1/5/15 分钟退避重试
  const retryCount = (prev?.retryCount ?? 0) + 1
  const delayMin = RETRY_DELAYS_MIN[retryCount - 1]
  if (delayMin) {
    warn(`日志上传失败 ${uploadName}，${delayMin} 分钟后重试（第 ${retryCount} 次）：${res.msg}`, 'upload')
    upsertLogUpload({ ...base, state: 'RETRY_PENDING', retryCount, nextRetryAt: Date.now() + delayMin * 60_000, message: res.msg })
    return { state: 'RETRY_PENDING', msg: res.msg }
  }

  uploadError = `日志上传连续 ${retryCount} 次失败：${res.msg}`
  warn(`${uploadError}，已停止重试并通过心跳上报`, 'upload')
  upsertLogUpload({ ...base, state: 'FAILED', retryCount, nextRetryAt: null, message: res.msg })
  return { state: 'FAILED', msg: res.msg }
}

/**
 * 跑一轮上传。
 * includeToday=true 时连当天日志一起传（退出/装更新/异常退出/异常自动上报时用）；
 * 默认只传已封口的历史文件——当天文件还在被写，传上去也是残缺的。
 * force=true 为手动「立即上传」：等在途轮次结束后，解锁此前被拒（BLOCKED）的记录、
 * 忽略重试退避，并强制重传当天文件（内容可能没变，但用户点上传就该真的传上去）。
 */
export async function run({ includeToday = false, force = false } = {}) {
  const done = { uploaded: 0, failed: 0, blocked: 0, skipped: 0, errors: [] }
  // 占位要放在第一个 await 之前：定时轮次和退出前的 flushNow 可能同时进来，
  // 先 await 再占位的话两边都会通过检查，同一个文件被压缩上传两遍。
  // 手动上传则等在途轮次结束（最多 30 秒）再接管，保证点一下就真的传
  if (force && busy) {
    const deadline = Date.now() + 30_000
    while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 400))
  }
  if (busy) return done
  busy = true
  try {
    const cfg = await loadConfig()
    // 密钥/实例名没配好时传不了。首次启动、用户还没填参数就会走到这里，不记日志免得刷屏
    if (missingAccess(cfg).length) return done
    await initLedger()
    if (!getLogDir()) return done
    // 当天文件的写流是带缓冲的，读之前先 flush，否则丢掉尾部几条（往往正是退出/崩溃那几条）
    if (includeToday) await flushLogger()
    // 手动上传给被平台拒绝过的日志再一次机会（换配置后同理）
    if (force) {
      const reset = resetTerminalLogUploads()
      if (reset) info(`手动上传：${reset} 个此前被平台拒绝的日志文件重新尝试`, 'upload')
    }

    const today = todayKey()
    const files = listLogFiles().filter((f) => {
      const key = logFileDateKey(f.name)
      if (!key) return false
      return includeToday ? key <= today : key < today
    })

    for (const file of files) {
      const prev = getLogUpload(file.name)
      const isToday = logFileDateKey(file.name) === today
      // 内容没变就不重传：封口文件传一次即终态；当天文件在多次退出之间会继续增长，靠 size 判定是否补传。
      // 手动上传（force）对当天文件豁免去重——用户点「立即上传」就该真的上传
      const sameSize = prev && prev.size === file.size
      const settledDone = sameSize && prev.state !== 'RETRY_PENDING' && prev.state !== 'PENDING'
      if (settledDone && !(force && isToday)) {
        done.skipped++
        continue
      }
      // 重试退避只约束自动轮次；手动上传立即重试
      if (!force && prev?.state === 'RETRY_PENDING' && Date.now() < (prev.nextRetryAt ?? 0)) {
        done.skipped++
        continue
      }
      const outcome = await uploadOne(cfg, file)
      if (outcome.state === 'UPLOADED') done.uploaded++
      else if (outcome.state === 'FAILED') {
        done.failed++
        done.errors.push({ fileName: file.name, msg: outcome.msg })
      } else if (outcome.state === 'RETRY_PENDING') {
        // 进入重试 = 通道临时不可用（网络错误/5xx/502 网关等），记录翻转边沿
        noteUploadChannelDown(outcome.msg)
        // 手动上传视角：这次点了没传上去就是失败，且要把接口的报错原文带出去
        if (force) {
          done.failed++
          done.errors.push({ fileName: file.name, msg: outcome.msg })
        } else done.skipped++
      } else if (outcome.state === 'BLOCKED') done.blocked++
      else done.skipped++
    }
    // 本轮有成功上传且无临时失败 = 通道恢复（若此前处于中断窗口，记录恢复时长）
    if (done.uploaded > 0 && !done.errors.length && done.failed === 0) noteUploadChannelUp()
    return done
  } catch (e) {
    warn(`日志上传轮次异常：${e.message}`, 'upload')
    return done
  } finally {
    busy = false
  }
}

/** 退出 / 安装更新 / 检测到上次异常退出时调用：把当天日志也补传一次 */
export function flushNow() {
  if (suppressExitFlush) return Promise.resolve({ uploaded: 0, failed: 0, blocked: 0, skipped: 0 })
  return run({ includeToday: true })
}

export function suppressNextExitFlush() {
  suppressExitFlush = true
}

export async function start({ resetTerminal = false } = {}) {
  stop()
  // 日志上传是运维必备能力，恒开（不做界面开关）
  if (resetTerminal) {
    // 换密钥/换地址之后，此前因鉴权或通道被拒的日志该再试一次
    await initLedger()
    const reset = resetTerminalLogUploads()
    if (reset) info(`配置已变更，${reset} 个此前被平台拒绝的日志文件将重新尝试上传`, 'upload')
  }
  timer = setInterval(() => void run(), CHECK_INTERVAL_MS)
  // 启动立刻跑一轮：接住断网/停机期间积压的日志（对接文档 §5.3 离线补传）
  void run()
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
