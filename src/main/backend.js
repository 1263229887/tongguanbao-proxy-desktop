import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { effectiveApiUrl } from './config.js'
import { requestViaRenderer } from './net-bridge.js'
import { info, warn } from './logger.js'

// 关务前置机四个接口。请求全部经渲染进程发出，便于 DevTools Network 排查。
// 日志纪律（文档 §13）：不记录完整密钥、XML、Base64、请求头/响应体；
// 例行成功的请求不逐条落日志，业务状态与异常在调用方记录。

export const API_PREFIX = '/admin-api/declaration/agent'

export const BIZ_CODE = {
  CHANNEL_CLOSED: 1050000200,
  BAD_KEY: 1050000201,
  TASK_NOT_FOUND: 1050000202,
  STATUS_CONFLICT: 1050000203,
  RECEIPT_INVALID: 1050000204,
  RECEIPT_TOO_LARGE: 1050000205
}

export function maskKey(key) {
  const s = String(key || '')
  if (!s) return '(空)'
  if (s.length <= 4) return '****'
  return `…${s.slice(-4)}`
}

export function authHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    'X-Agent-Key': cfg.agentKey
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

/** 把后端公共包封成统一结果，避免各处重复判断 HTTP/code */
async function post(cfg, apiPath, body, { timeoutMs, scope = 'api', label = apiPath } = {}) {
  const url = buildUrl(cfg, apiPath)
  const started = Date.now()
  try {
    const res = await requestViaRenderer({
      url,
      method: 'POST',
      headers: authHeaders(cfg),
      body,
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

export function formatDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function parseDateTime(text) {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
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

export async function uploadReceipt(cfg, { fileName, receivedAt, receiptXmlBase64, tradeMode }) {
  const body = {
    instanceName: cfg.instanceName,
    fileName,
    receivedAt,
    receiptXmlBase64
  }
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

/** 测试访问：直接打一次心跳，密钥/地址/网络一把验证 */
export async function testConnection(cfg) {
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
