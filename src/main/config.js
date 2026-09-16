import fs from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { app } from 'electron'
import { CAN_EDIT_SERVER } from './env.js'
import { BUSINESS_TYPES, emptyBizDir } from '../shared/biz-types.js'

// 后台地址内置在代码里，界面上不填；config.json 写了 apiUrl 才覆盖，换服务器时下发配置即可。
const DEFAULT_API_URL = '' // TODO 联调时填公司后台地址

// 字段名以后台接口契约为准，联调时统一替换。
const DEFAULTS = {
  apiUrl: DEFAULT_API_URL,
  appKey: '',
  tenantId: '',
  tag: '',
  // profiles / activeProfile 不放这里：loadConfig 用 {...DEFAULTS, ...文件} 展开，
  // 默认空组会盖住老配置里的顶层 apiUrl、appKey，让迁移失效
  maxConcurrentTasks: 3,
  pollIntervalSeconds: 30,
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
  // userData 在线升级不会清掉；productName 不变则路径稳定
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

function normalizeProfile(p) {
  const tag = str(p?.tag)
  return {
    tag: tag === 'test' || tag === 'prod' ? tag : '',
    apiUrl: str(p?.apiUrl).replace(/\/+$/, ''),
    appKey: str(p?.appKey),
    tenantId: str(p?.tenantId)
  }
}

function normalizeProfiles(raw) {
  const list = Array.isArray(raw.profiles) && raw.profiles.length ? raw.profiles : [{ tag: raw.tag, apiUrl: raw.apiUrl, appKey: raw.appKey, tenantId: raw.tenantId }]
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

// 旧版只有一套 dirs + maxConcurrentTasks，归到「货物申报 / 报关单暂存」
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
  return {
    // 顶层是当前生效值，请求侧只读这几个；profiles 仅 dev/test 用于多组切换
    tag: CAN_EDIT_SERVER ? active.tag : '',
    apiUrl: CAN_EDIT_SERVER ? active.apiUrl : DEFAULT_API_URL.replace(/\/+$/, ''),
    appKey: active.appKey,
    tenantId: active.tenantId,
    profiles: CAN_EDIT_SERVER ? profiles : [normalizeProfile({ tag: '', apiUrl: DEFAULT_API_URL, appKey: active.appKey, tenantId: active.tenantId })],
    activeProfile,
    // 按业务类型一组四个目录 + 最大任务数；旧版顶层 dirs 会迁到 goods
    bizDirs: normalizeBizDirs(raw),
    maxConcurrentTasks: clampInt(raw.maxConcurrentTasks, 1, 5, DEFAULTS.maxConcurrentTasks),
    pollIntervalSeconds: clampInt(raw.pollIntervalSeconds, 1, 86_400, DEFAULTS.pollIntervalSeconds),
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

export async function loadConfig() {
  if (cache) return cache
  // 主配置损坏时自动用备份，避免升级/异常退出丢目录
  for (const file of [configFile(), backupConfigFile()]) {
    try {
      cache = normalize({ ...DEFAULTS, ...(await readJson(file)) })
      return cache
    } catch {
      // try next
    }
  }
  cache = normalize(DEFAULTS)
  return cache
}

export async function saveConfig(patch) {
  const merged = { ...(cache ?? DEFAULTS), ...patch }
  // 只提交顶层字段（生产包就只提交 tenantId / appKey）时，落到当前激活组，否则会被旧 profiles 覆盖回去
  const touchesProfile =
    patch.profiles === undefined &&
    (patch.apiUrl !== undefined || patch.appKey !== undefined || patch.tenantId !== undefined || patch.tag !== undefined)
  if (touchesProfile) {
    const list = (merged.profiles ?? []).map((p) => ({ ...p }))
    const i = clampInt(merged.activeProfile, 0, Math.max(0, list.length - 1), 0)
    list[i] = {
      tag: patch.tag ?? list[i]?.tag ?? '',
      apiUrl: patch.apiUrl ?? list[i]?.apiUrl,
      appKey: patch.appKey ?? list[i]?.appKey,
      tenantId: patch.tenantId ?? list[i]?.tenantId
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

export async function checkDir(dir, { label = '目录' } = {}) {
  if (!dir) return { ok: false, reason: `未设置${label}` }
  if (!path.isAbsolute(dir)) return { ok: false, reason: '必须是绝对路径' }
  // 只读探测：本机业务程序会监听这些目录，写探针文件或建目录都会干扰真实流程
  try {
    if (!(await fs.stat(dir)).isDirectory()) return { ok: false, reason: `${label}不是文件夹` }
    await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK)
    return { ok: true }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: `${label}不存在，请先建好该文件夹` }
    return { ok: false, reason: `${label}不可读写：${e.message}` }
  }
}
