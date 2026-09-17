import fs from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { app } from 'electron'
import { CAN_EDIT_SERVER } from './env.js'
import { BUSINESS_TYPES, emptyBizDir } from '../shared/biz-types.js'

// 测试环境兜底地址；生产地址待定，联调/测试包未填时走这里。
// 生产包若仍为空，请求会失败并提示配置服务器地址。
export const DEFAULT_API_URL = 'https://www.tel365.com:8088'

// 字段名以后台接口契约为准：只保存企业鉴权密钥，不再保存租户 ID。
const DEFAULTS = {
  apiUrl: '',
  agentKey: '',
  tag: '',
  instanceName: '',
  swImportBasePath: '',
  maxConcurrentTasks: 3,
  pollIntervalSeconds: 10,
  inboxIntervalSeconds: 3,
  heartbeatIntervalSeconds: 30,
  batchSize: 5,
  tradeModes: ['export', 'import', '9610'],
  logKeepDays: 30,
  autoLaunch: true,
  logUpload: {
    enabled: true,
    intervalMinutes: 10,
    pattern: '*.log',
    remoteDir: ''
  }
}

let cache = null

function configFile() {
  return path.join(app.getPath('userData'), 'config.json')
}

function backupConfigFile() {
  return path.join(app.getPath('userData'), 'config.backup.json')
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.part`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function str(v) {
  return String(v ?? '').trim()
}

function stripTrailingSlash(url) {
  return str(url).replace(/\/+$/, '')
}

let machineGuidCache

/** Windows 装机时生成的机器 GUID：普通权限可读，重命名电脑/换网卡/重装应用都不变，重装系统才变 */
function readMachineGuid() {
  if (machineGuidCache !== undefined) return machineGuidCache
  if (process.platform !== 'win32') {
    machineGuidCache = null
  } else {
    try {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8'
      })
      const m = String(out).match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/)
      machineGuidCache = m ? m[1] : null
    } catch {
      machineGuidCache = null
    }
  }
  return machineGuidCache
}

/**
 * 稳定实例名：主机名前缀 + 机器指纹片段（读不到 MachineGuid 时用一次性 UUID 兜底）。
 * 只在配置缺少 instanceName 时求值，随后固化进 config.json，之后永不自动变化（文档 §5.1）。
 */
export function defaultInstanceName() {
  const host = (os.hostname() || 'AGENT').replace(/[^\w.-]+/g, '-').slice(0, 32) || 'AGENT'
  const guid = readMachineGuid() || crypto.randomUUID()
  return `${host}-${String(guid).replace(/-/g, '').slice(0, 12)}`
}

function normalizeTradeModes(src) {
  const allowed = new Set(['export', 'import', '9610'])
  const list = Array.isArray(src) ? src.map(str).filter((x) => allowed.has(x)) : []
  return list.length ? list : [...DEFAULTS.tradeModes]
}

function normalizeProfile(p) {
  const tag = str(p?.tag)
  // 兼容旧字段 appKey → agentKey；tenantId 直接丢弃
  return {
    tag: tag === 'test' || tag === 'prod' ? tag : '',
    apiUrl: stripTrailingSlash(p?.apiUrl),
    agentKey: str(p?.agentKey || p?.appKey)
  }
}

function normalizeProfiles(raw) {
  const list =
    Array.isArray(raw.profiles) && raw.profiles.length
      ? raw.profiles
      : [{ tag: raw.tag, apiUrl: raw.apiUrl, agentKey: raw.agentKey || raw.appKey }]
  return list.map(normalizeProfile)
}

function normalizeBizDir(src, fallbackTasks) {
  return {
    outBox: str(src?.outBox),
    sentBox: str(src?.sentBox),
    inBox: str(src?.inBox),
    failBox: str(src?.failBox),
    maxConcurrentTasks: clampInt(src?.maxConcurrentTasks, 1, 5, fallbackTasks)
  }
}

function normalizeBizDirs(raw) {
  const legacy = normalizeBizDir(
    {
      outBox: raw.dirs?.outBox ?? raw.xmlDir,
      sentBox: raw.dirs?.sentBox,
      inBox: raw.dirs?.inBox,
      failBox: raw.dirs?.failBox,
      maxConcurrentTasks: raw.maxConcurrentTasks
    },
    DEFAULTS.maxConcurrentTasks
  )
  const source = raw.bizDirs && typeof raw.bizDirs === 'object' ? raw.bizDirs : {}
  const result = {}
  for (const type of BUSINESS_TYPES) {
    const src = source[type.id]
    result[type.id] = src ? normalizeBizDir(src, DEFAULTS.maxConcurrentTasks) : type.id === 'goods' ? legacy : emptyBizDir()
  }
  return result
}

function normalize(raw) {
  const upload = raw.logUpload ?? {}
  const profiles = normalizeProfiles(raw)
  const activeProfile = CAN_EDIT_SERVER ? clampInt(raw.activeProfile, 0, profiles.length - 1, 0) : 0
  const active = profiles[activeProfile]
  // 生产包地址不可改：优先用户曾填的，否则测试兜底（生产待定）
  const apiUrl = CAN_EDIT_SERVER ? active.apiUrl : stripTrailingSlash(raw.apiUrl) || DEFAULT_API_URL
  return {
    tag: CAN_EDIT_SERVER ? active.tag : '',
    apiUrl,
    agentKey: active.agentKey,
    instanceName: str(raw.instanceName) || defaultInstanceName(),
    swImportBasePath: str(raw.swImportBasePath),
    profiles: CAN_EDIT_SERVER
      ? profiles
      : [normalizeProfile({ tag: '', apiUrl: DEFAULT_API_URL, agentKey: active.agentKey })],
    activeProfile,
    bizDirs: normalizeBizDirs(raw),
    maxConcurrentTasks: clampInt(raw.maxConcurrentTasks, 1, 5, DEFAULTS.maxConcurrentTasks),
    pollIntervalSeconds: clampInt(raw.pollIntervalSeconds, 1, 86_400, DEFAULTS.pollIntervalSeconds),
    inboxIntervalSeconds: clampInt(raw.inboxIntervalSeconds, 1, 3600, DEFAULTS.inboxIntervalSeconds),
    heartbeatIntervalSeconds: clampInt(raw.heartbeatIntervalSeconds, 10, 300, DEFAULTS.heartbeatIntervalSeconds),
    batchSize: clampInt(raw.batchSize, 1, 20, DEFAULTS.batchSize),
    tradeModes: normalizeTradeModes(raw.tradeModes),
    logKeepDays: clampInt(raw.logKeepDays, 1, 3650, DEFAULTS.logKeepDays),
    autoLaunch: raw.autoLaunch !== false,
    logUpload: {
      enabled: upload.enabled !== false,
      intervalMinutes: clampInt(upload.intervalMinutes, 1, 1440, DEFAULTS.logUpload.intervalMinutes),
      pattern: str(upload.pattern) || DEFAULTS.logUpload.pattern,
      remoteDir: str(upload.remoteDir)
    }
  }
}

/** 首次生成的实例名立即落盘固化，之后主机名被修改/网卡变化都不会引起实例名漂移 */
async function persistFirstInstanceName() {
  try {
    await saveConfig({ instanceName: cache.instanceName })
  } catch {
    // 落盘失败不阻断启动：MachineGuid 场景下次重新求值结果相同；UUID 兜底场景磁盘必然已故障
  }
}

export async function loadConfig() {
  if (cache) return cache
  for (const file of [configFile(), backupConfigFile()]) {
    try {
      const raw = await readJson(file)
      cache = normalize({ ...DEFAULTS, ...raw })
      if (!str(raw.instanceName)) await persistFirstInstanceName()
      return cache
    } catch {
      // try next
    }
  }
  cache = normalize(DEFAULTS)
  await persistFirstInstanceName()
  return cache
}

export async function saveConfig(patch) {
  const merged = { ...(cache ?? DEFAULTS), ...patch }
  // 只提交顶层字段时落到当前激活组，避免被旧 profiles 盖住
  const touchesProfile =
    patch.profiles === undefined &&
    (patch.apiUrl !== undefined || patch.agentKey !== undefined || patch.appKey !== undefined || patch.tag !== undefined)
  if (touchesProfile) {
    const list = (merged.profiles ?? []).map((p) => ({ ...p }))
    const i = clampInt(merged.activeProfile, 0, Math.max(0, list.length - 1), 0)
    list[i] = {
      tag: patch.tag ?? list[i]?.tag ?? '',
      apiUrl: patch.apiUrl ?? list[i]?.apiUrl,
      agentKey: patch.agentKey ?? patch.appKey ?? list[i]?.agentKey
    }
    merged.profiles = list
  }
  if (patch.bizDirs) {
    const prev = cache?.bizDirs ?? {}
    const nextBiz = { ...prev }
    for (const [id, val] of Object.entries(patch.bizDirs)) {
      nextBiz[id] = { ...(prev[id] ?? emptyBizDir()), ...val }
    }
    merged.bizDirs = nextBiz
  }
  if (patch.tradeModes) merged.tradeModes = normalizeTradeModes(patch.tradeModes)
  if (patch.logUpload) merged.logUpload = { ...(cache?.logUpload ?? DEFAULTS.logUpload), ...patch.logUpload }
  cache = normalize(merged)
  await writeJsonAtomic(configFile(), cache)
  try {
    await writeJsonAtomic(backupConfigFile(), cache)
  } catch {
    // 备份失败不阻断主保存
  }
  return cache
}

export function effectiveApiUrl(cfg) {
  return stripTrailingSlash(cfg?.apiUrl) || DEFAULT_API_URL
}

export async function checkDir(dir, { label = '目录' } = {}) {
  if (!dir) return { ok: false, reason: `未设置${label}` }
  if (!path.isAbsolute(dir)) return { ok: false, reason: '必须是绝对路径' }
  try {
    if (!(await fs.stat(dir)).isDirectory()) return { ok: false, reason: `${label}不是文件夹` }
    await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK)
    return { ok: true }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: `${label}不存在，请先建好该文件夹` }
    return { ok: false, reason: `${label}不可读写：${e.message}` }
  }
}
