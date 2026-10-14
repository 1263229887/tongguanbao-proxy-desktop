import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import dayjs from 'dayjs'
import { effectiveApiUrl } from './config.js'
import { requestViaRenderer } from './net-bridge.js'
import { info, warn } from './logger.js'

// 关务前置机接口：拉取任务 / 状态回报 / 回执上传 / 心跳 / 日志上传。
// 请求全部经渲染进程发出，便于 DevTools Network 排查。
// 日志纪律（文档 §13）：不记录完整密钥、XML、Base64、请求头/响应体；
// 例行成功的请求不逐条落日志，业务状态与异常在调用方记录。

export const API_PREFIX = '/admin-api/declaration/agent'

export const BIZ_CODE = {
  CHANNEL_CLOSED: 1050000200,
  BAD_KEY: 1050000201,
  TASK_NOT_FOUND: 1050000202,
  STATUS_CONFLICT: 1050000203,
  RECEIPT_INVALID: 1050000204,
  RECEIPT_TOO_LARGE: 1050000205,
  // 以下两个仅平台跨租户模式会出现（跨租户文档 §12）
  HEARTBEAT_TENANT_UNSET: 1050000208, // 后端未配置平台 heartbeat 归属租户
  RECEIPT_TASK_MISMATCH: 1050000209, // 回执 taskId 与 ClientSeqNo 不匹配
  // 日志上传（《前置机日志文件上传对接文档》§4）
  LOG_CHANNEL_CLOSED: 1050000231, // 服务端未开启日志上传通道，整体拒绝
  LOG_FILE_EMPTY: 1050000232,
  LOG_FILE_TOO_LARGE: 1050000233,
  LOG_FILE_TYPE_NOT_ALLOWED: 1050000234,
  LOG_INSTANCE_NAME_REQUIRED: 1050000235
}

export function maskKey(key) {
  const s = String(key || '')
  if (!s) return '(空)'
  if (s.length <= 4) return '****'
  return `…${s.slice(-4)}`
}

/** 只带鉴权头。multipart 请求必须用它：Content-Type 要留给渲染层的 FormData 生成 boundary */
export function agentKeyHeaders(cfg) {
  return { 'X-Agent-Key': cfg.agentKey }
}

export function authHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    ...agentKeyHeaders(cfg)
  }
}

export function missingAccess(cfg) {
  const miss = []
  if (!cfg?.agentKey) miss.push('企业鉴权密钥')
  if (!cfg?.instanceName) miss.push('实例名')
  return miss
}

function buildUrl(cfg, apiPath) {
  const base = effectiveApiUrl(cfg)
  // 完整路径 = 基础地址 + /admin-api/declaration/agent + 接口路径；NGINX 按 /admin-api 转发
  const full = `${API_PREFIX}/${String(apiPath).replace(/^\//, '')}`
  return new URL(full, `${base}/`).toString()
}

/**
 * 统一发送 + 信封解包。JSON 与 multipart 走同一条路，差别只在请求体形态与请求头。
 * 把后端公共包封成统一结果，避免各处重复判断 HTTP/code。
 */
async function send(cfg, apiPath, { body, multipart, headers, timeoutMs }, { scope = 'api', label = apiPath } = {}) {
  const url = buildUrl(cfg, apiPath)
  const started = Date.now()
  try {
    const res = await requestViaRenderer({
      url,
      method: 'POST',
      headers,
      body,
      multipart,
      timeoutMs
    })
    const cost = Date.now() - started
    let data = res.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        data = null
      }
    }
    const httpOk = res.status >= 200 && res.status < 300
    const code = data && typeof data.code === 'number' ? data.code : null
    const msg = (data && typeof data.msg === 'string' ? data.msg : '') || res.statusText || ''
    const ok = httpOk && code === 0

    if (!httpOk && (res.status === 401 || res.status === 503)) {
      return {
        ok: false,
        httpStatus: res.status,
        code,
        msg: msg || (res.status === 401 ? '企业鉴权密钥无效或企业已停用' : '前置机通道关闭'),
        data: data?.data,
        cost,
        fatal: true
      }
    }

    if (!ok) {
      const reason = msg || `HTTP ${res.status}${code != null ? ` code=${code}` : ''}`
      return { ok: false, httpStatus: res.status, code, msg: reason, data: data?.data, cost }
    }

    return { ok: true, httpStatus: res.status, code: 0, msg: '', data: data?.data, cost }
  } catch (e) {
    const cost = Date.now() - started
    warn(`${label} 失败：${e.message}`, scope)
    return { ok: false, httpStatus: 0, code: null, msg: e.message, data: null, cost, network: true }
  }
}

async function post(cfg, apiPath, body, { timeoutMs, scope, label } = {}) {
  return send(cfg, apiPath, { body, headers: authHeaders(cfg), timeoutMs }, { scope, label })
}

/** 后端接口约定的时间格式 yyyy-MM-dd HH:mm:ss：回执的 receivedAt、日志上传的 logTime 都用它 */
export function formatDateTime(d = new Date()) {
  return dayjs(d).format('YYYY-MM-DD HH:mm:ss')
}

function epochToMs(n) {
  // 大于 1e12 视为毫秒（该阈值对应 2001-09，秒级时间戳永远小于它）
  return n > 1e12 ? n : n * 1000
}

/** 兼容两种口径：文档约定的 "yyyy-MM-dd HH:mm:ss" 字符串，以及后端可能下发的 epoch 秒/毫秒（含 "1789…0.0" 数字串）；解析失败返回 null */
export function parseDateTime(text) {
  if (typeof text === 'number' && Number.isFinite(text)) return epochToMs(text)
  const s = String(text ?? '').trim()
  if (/^\d+(\.\d+)?$/.test(s)) return epochToMs(Number(s))
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

export async function pullTasks(cfg, { tradeModes, batchSize } = {}) {
  const body = {
    instanceName: cfg.instanceName,
    tradeModes: tradeModes?.length ? tradeModes : cfg.tradeModes,
    batchSize: batchSize || cfg.batchSize || 5
  }
  const res = await post(cfg, '/tasks/pull', body, { scope: 'pull', label: 'pull' })
  if (!res.ok) return res
  const tasks = Array.isArray(res.data?.tasks) ? res.data.tasks : []
  if (tasks.length) info(`本轮拉取到 ${tasks.length} 条任务`, 'pull')
  return { ...res, tasks }
}

export async function reportTaskStatus(cfg, taskId, { dispatchToken, status, message }) {
  const body = {
    instanceName: cfg.instanceName,
    dispatchToken,
    status,
    message: String(message || '').slice(0, 500)
  }
  const res = await post(cfg, `/tasks/${taskId}/status`, body, { scope: 'deliver', label: `status#${taskId}` })
  if (res.code === BIZ_CODE.TASK_NOT_FOUND || res.code === BIZ_CODE.STATUS_CONFLICT) {
    warn(`状态回报冲突/不存在 taskId=${taskId} code=${res.code} ${res.msg}`, 'deliver')
  }
  return res
}

export async function uploadReceipt(cfg, { taskId, fileName, receivedAt, receiptXmlBase64, tradeMode }) {
  const body = {
    instanceName: cfg.instanceName,
    fileName,
    receivedAt,
    receiptXmlBase64
  }
  // 平台跨租户模式必带 taskId（跨租户文档 §8.1）；普通租户模式按 v1.4 不带，由后端按 ClientSeqNo 匹配。
  // 请求体不带 tenantId：租户归属由后端从任务读取。
  if (taskId != null) body.taskId = taskId
  if (tradeMode) body.tradeMode = tradeMode
  // 回执可能较大，放宽超时
  return post(cfg, '/receipts', body, { scope: 'receipt', label: `receipt:${fileName}`, timeoutMs: 60_000 })
}

export async function sendHeartbeat(cfg, payload) {
  const body = {
    instanceName: cfg.instanceName,
    version: payload?.version || '',
    ip: payload?.ip || '',
    tradeModes: payload?.tradeModes || [
      {
        tradeMode: 'shared',
        outboxOk: !!payload?.outboxOk,
        inboxOk: !!payload?.inboxOk
      }
    ],
    pendingTaskCount: payload?.pendingTaskCount ?? 0,
    lastError: String(payload?.lastError || '').slice(0, 500)
  }
  const res = await post(cfg, '/heartbeat', body, { scope: 'heartbeat', label: 'heartbeat' })
  return res
}

/**
 * 上传本地日志文件（《前置机日志文件上传对接文档》§3）。
 * instanceName 直接取配置里那份——它在首次运行时冻结进 config.json，与心跳上送的是同一个值，
 * 后端靠它把日志关联到具体实例，两处不一致排查时就对不上号。
 * bytes 由调用方压缩好（服务端白名单 .log/.txt/.gz/.zip，压缩后省带宽也省服务器磁盘）。
 */
export async function uploadLogFile(cfg, { fileName, bytes, logTime }) {
  const fields = { instanceName: cfg.instanceName }
  // logTime 缺省时后端用接收时间；日志是补传的，必须带上文件自己的产生时间才排得进时间线
  if (logTime) fields.logTime = logTime
  return send(
    cfg,
    '/log/upload',
    {
      multipart: {
        fields,
        file: { field: 'file', name: fileName, contentType: 'application/gzip', bytes }
      },
      headers: agentKeyHeaders(cfg),
      // 压缩包可能几十 MB，走默认 20s 不够
      timeoutMs: 180_000
    },
    { scope: 'upload', label: `log:${fileName}` }
  )
}

/** 测试访问：直接打一次心跳，密钥/地址/网络一把验证 */export async function testConnection(cfg) {
  const miss = missingAccess(cfg)
  if (miss.length) {
    warn(`权限配置不完整，缺少：${miss.join('、')}`, 'access')
    return { ok: false, reason: `缺少 ${miss.join('、')}` }
  }
  const url = buildUrl(cfg, '/heartbeat')
  info(`测试访问 ${url} key=${maskKey(cfg.agentKey)}`, 'access')
  const res = await sendHeartbeat(cfg, {
    version: 'test',
    outboxOk: true,
    inboxOk: true,
    pendingTaskCount: 0,
    lastError: ''
  })
  if (res.ok) {
    info(`访问正常，耗时 ${res.cost}ms`, 'access')
    return { ok: true, cost: res.cost, data: res.data }
  }
  warn(`访问失败：${res.msg}`, 'access')
  return { ok: false, reason: res.msg, cost: res.cost, code: res.code, httpStatus: res.httpStatus }
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export async function fileSha256(fullPath) {
  const buf = await fs.readFile(fullPath)
  return sha256Hex(buf)
}
