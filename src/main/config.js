import fs from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { app } from 'electron'
import { CAN_EDIT_SERVER } from './env.js'

// 后台地址内置在代码里，界面上不填；config.json 写了 apiUrl 才覆盖，换服务器时下发配置即可。
const DEFAULT_API_URL = '' // TODO 联调时填公司后台地址

// 字段名以后台接口契约为准，联调时统一替换。
const DEFAULTS = {
  apiUrl: DEFAULT_API_URL,
  appKey: '',
  // profiles / activeProfile 不放这里：loadConfig 用 {...DEFAULTS, ...文件} 展开，
  // 默认空组会盖住老配置里的顶层 apiUrl、appKey，让迁移失效
  dirs: {
    outBox: '',
    sentBox: '',
    inBox: '',
    failBox: ''
  },
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
  return path.join(app.getPath('userData'), 'config.json')
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
  return { apiUrl: str(p?.apiUrl).replace(/\/+$/, ''), appKey: str(p?.appKey) }
}

function normalizeProfiles(raw) {
  const list = Array.isArray(raw.profiles) && raw.profiles.length ? raw.profiles : [{ apiUrl: raw.apiUrl, appKey: raw.appKey }]
  return list.map(normalizeProfile)
}

function normalize(raw) {
  const upload = raw.logUpload ?? {}
  const dirs = raw.dirs ?? {}
  const profiles = normalizeProfiles(raw)
  const activeProfile = CAN_EDIT_SERVER ? clampInt(raw.activeProfile, 0, profiles.length - 1, 0) : 0
  const active = profiles[activeProfile]
  return {
    // 顶层 apiUrl / appKey 是当前生效值，请求侧只读这两个；profiles 仅 dev/test 用于切换
    apiUrl: CAN_EDIT_SERVER ? active.apiUrl : DEFAULT_API_URL.replace(/\/+$/, ''),
    appKey: active.appKey,
    profiles: CAN_EDIT_SERVER ? profiles : [normalizeProfile(active)],
    activeProfile,
    // 顶层 xmlDir 是目录拆成 4 个之前的旧字段，读到就认作待发送目录，避免升级后配置被清空
    dirs: {
      outBox: str(dirs.outBox) || str(raw.xmlDir),
      sentBox: str(dirs.sentBox),
      inBox: str(dirs.inBox),
      failBox: str(dirs.failBox)
    },
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
  try {
    cache = normalize({ ...DEFAULTS, ...JSON.parse(await fs.readFile(configFile(), 'utf8')) })
  } catch {
    cache = normalize(DEFAULTS)
  }
  return cache
}

export async function saveConfig(patch) {
  const merged = { ...(cache ?? DEFAULTS), ...patch }
  // 只提交顶层 apiUrl / appKey（生产包就只提交 appKey）时，落到当前激活组，否则会被旧 profiles 覆盖回去
  if (patch.profiles === undefined && (patch.apiUrl !== undefined || patch.appKey !== undefined)) {
    const list = (merged.profiles ?? []).map((p) => ({ ...p }))
    const i = clampInt(merged.activeProfile, 0, Math.max(0, list.length - 1), 0)
    list[i] = { apiUrl: patch.apiUrl ?? list[i]?.apiUrl, appKey: patch.appKey ?? list[i]?.appKey }
    merged.profiles = list
  }
  if (patch.dirs) merged.dirs = { ...(cache?.dirs ?? DEFAULTS.dirs), ...patch.dirs }
  if (patch.logUpload) merged.logUpload = { ...(cache?.logUpload ?? DEFAULTS.logUpload), ...patch.logUpload }
  cache = normalize(merged)
  await fs.mkdir(path.dirname(configFile()), { recursive: true })
  const tmp = `${configFile()}.part`
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
  await fs.rename(tmp, configFile())
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
