import { info, warn } from './logger.js'

// 与后台通信的唯一出口：鉴权方式（签名 / 头字段名）将来只改这里。
// TODO 请求路径、签名算法与响应字段以后台契约为准。
const TEST_PATH = '/api/tenant/verify'
const TIMEOUT_MS = 10_000

export function authHeaders(cfg) {
  return {
    'content-type': 'application/json',
    'x-app-key': cfg.appKey
  }
}

export function missingAccess(cfg) {
  const miss = []
  if (!cfg.apiUrl) miss.push('后台地址')
  if (!cfg.appKey) miss.push('APP KEY')
  return miss
}

export async function request(cfg, apiPath, init = {}) {
  const url = new URL(apiPath.replace(/^\//, ''), `${cfg.apiUrl}/`).toString()
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(cfg), ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  return res
}

export async function testConnection(cfg) {
  const miss = missingAccess(cfg)
  if (miss.length) {
    warn(`权限配置不完整，缺少：${miss.join('、')}`, 'access')
    return { ok: false, reason: `缺少 ${miss.join('、')}` }
  }

  const startedAt = Date.now()
  info(`测试后台连通性 ${cfg.apiUrl}${TEST_PATH}`, 'access')
  try {
    const res = await request(cfg, TEST_PATH, { method: 'POST', body: '{}' })
    const cost = Date.now() - startedAt
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${res.statusText}`, cost }
    const data = await res.json().catch(() => ({}))
    info(`连通性测试通过，耗时 ${cost}ms；响应字段：${Object.keys(data).join(', ') || '无'}`, 'access')
    return { ok: true, cost, data }
  } catch (e) {
    warn(`连通性测试失败：${e.message}`, 'access')
    return { ok: false, reason: e.message, cost: Date.now() - startedAt }
  }
}
