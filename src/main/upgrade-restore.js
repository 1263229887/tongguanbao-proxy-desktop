// 在线升级后的业务开关恢复提醒。
// 升级会重启进程，代理默认不自启，升级前开着的业务在新版本里会变成关闭状态。
// 安装前由 updater.js 记录当时真正在运行的业务；新版本首次启动时，界面询问用户是否重新开启。
// 目录配置不完整的业务不提醒（开了也跑不起来）；版本没变化说明安装被取消/失败，按普通启动处理。
//
// 过渡期兜底：升级到“第一个带本功能的版本”时，旧版本不会写恢复记录。
// 旧版本安装前会先停代理（日志「代理已停止」）并立即退出，新版本首次启动时据此反推，
// 只在“当前版本首次启动 + 时间紧邻 + 停之前确实在运行”时提示，之后由 restore-check.json 防止重复推断。
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { loadConfig } from './config.js'
import { ALL_BIZ_TYPES, DIR_FIELDS, cebChannelReady } from '../shared/biz-types.js'
import { debug, getLogDir, info, warn } from './logger.js'

const FILE_NAME = 'pending-biz-restore.json'
const CHECK_FILE_NAME = 'restore-check.json'
const UPGRADE_LOG = '退出并安装新版本'
const AGENT_START_LOG = '代理已启动'
const AGENT_STOP_LOG = '代理已停止'
const STARTUP_TOKEN = ' 启动，env='
// 过渡期兜底只用于旧版本（当时真实可运行的只有货物申报）
const LEGACY_RUNNABLE_BIZ = ['goods']

function markerFile() {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function checkFile() {
  return path.join(app.getPath('userData'), CHECK_FILE_NAME)
}

function normVersion(v) {
  return String(v || '').trim().replace(/^v/i, '')
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerFile(), 'utf8'))
  } catch {
    return null
  }
}

function readCheckedVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(checkFile(), 'utf8'))?.checkedVersion || '')
  } catch {
    return ''
  }
}

function writeCheckedVersion(version) {
  try {
    const file = checkFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ checkedVersion: version, at: Date.now() }, null, 2), 'utf8')
  } catch (e) {
    warn(`写升级检查记录失败：${e.message}`, 'update')
  }
}

function recentLogLines() {
  const dir = getLogDir() || path.join(app.getPath('userData'), 'logs')
  let names
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(n))
      .sort()
      .slice(-2)
  } catch {
    return []
  }
  const lines = []
  for (const name of names) {
    try {
      lines.push(...fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/))
    } catch {}
  }
  return lines
}

function parseLogTime(line) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/.exec(line)
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]}`)
  return Number.isFinite(t) ? t : null
}

/**
 * 过渡期兜底：只认旧版本退出前明确写下的「退出并安装新版本」，
 * 再按安装前该会话内最后一条代理状态判断开关是否开着。
 * 手动重启没有安装日志，原样关闭也不会出现“停止之前曾启动”，因此都不会误提醒。
 */
function inferPendingBusinessRestore(version) {
  const lines = recentLogLines()
  if (!lines.length) return null

  let installIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(UPGRADE_LOG)) {
      installIdx = i
      break
    }
  }
  if (installIdx < 0) return null

  // 安装后必须是本版本的这次启动；中间若插入过其他启动，说明不是升级后的首次启动
  let currentStartIdx = -1
  for (let i = installIdx + 1; i < lines.length; i++) {
    if (!lines[i].includes(STARTUP_TOKEN)) continue
    if (currentStartIdx >= 0 || !lines[i].includes(` ${version} 启动，env=`)) return null
    currentStartIdx = i
  }
  const installAt = parseLogTime(lines[installIdx])
  const startAt = currentStartIdx >= 0 ? parseLogTime(lines[currentStartIdx]) : null
  const refAt = startAt || Date.now()
  // 安装后自动拉起间隔很短；启动记录尚未落盘时用当前时间兜底
  if (!installAt || refAt < installAt || refAt - installAt > 30 * 60_000) return null

  // 只看安装所在的那次运行，避免把更早会话里的“启动”误算进来
  let prevStartIdx = -1
  for (let i = installIdx - 1; i >= 0; i--) {
    if (lines[i].includes(STARTUP_TOKEN)) {
      prevStartIdx = i
      break
    }
  }
  if (prevStartIdx < 0) return null

  // 安装前最近一条代理状态；安装流程会先停代理再写安装日志，
  // 这条“停止”紧贴安装日志才算升级导致，隔得远的是用户此前手动停止
  let stopIdx = -1
  for (let i = installIdx - 1; i > prevStartIdx; i--) {
    if (lines[i].includes(AGENT_START_LOG)) return [...LEGACY_RUNNABLE_BIZ]
    if (lines[i].includes(AGENT_STOP_LOG)) {
      stopIdx = i
      break
    }
  }
  if (stopIdx < 0) return null
  const stopAt = parseLogTime(lines[stopIdx])
  if (!stopAt || installAt - stopAt > 90_000) return null
  for (let i = stopIdx - 1; i > prevStartIdx; i--) {
    if (lines[i].includes(AGENT_START_LOG)) return [...LEGACY_RUNNABLE_BIZ]
    if (lines[i].includes(AGENT_STOP_LOG)) return null
  }
  return null
}

/** 安装前调用：记录升级前真正在运行的业务模块 */
export function markPendingBusinessRestore(bizTypes, targetVersion) {
  const list = [...new Set(Array.isArray(bizTypes) ? bizTypes : [])].filter(Boolean)
  if (!list.length) return
  const payload = {
    fromVersion: app.getVersion(),
    toVersion: String(targetVersion || ''),
    bizTypes: list,
    at: Date.now()
  }
  try {
    const file = markerFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.part`, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(`${file}.part`, file)
    debug(`已记录升级前运行中的业务：${list.join(',')}`, 'update')
  } catch (e) {
    warn(`记录升级前运行中的业务失败（升级后不会提示恢复）：${e.message}`, 'update')
  }
}

/**
 * 读取待恢复的业务。可重复调用，用户做出选择后由 renderer 调 clearPendingBusinessRestore 删除标记；
 * 没做选择就退出时，下次启动会继续提醒。
 */
export async function readPendingBusinessRestore() {
  if (!app.isPackaged) return null
  const version = app.getVersion()
  const firstRunOfVersion = normVersion(readCheckedVersion()) !== normVersion(version)
  if (firstRunOfVersion) writeCheckedVersion(version)

  let raw = readMarker()
  // 过渡期兜底只在“当前版本第一次启动且没有恢复记录”时尝试一次
  if (!raw && firstRunOfVersion) {
    const inferred = inferPendingBusinessRestore(version)
    if (inferred?.length) {
      info(`旧版本安装日志显示升级前正在运行：${inferred.join(',')}`, 'update')
      markPendingBusinessRestore(inferred, version)
      raw = readMarker() || { fromVersion: '', toVersion: version, bizTypes: inferred }
    }
  }
  if (!raw) return null

  const installed = raw?.toVersion
    ? normVersion(version) === normVersion(raw.toVersion)
    : normVersion(version) !== normVersion(raw?.fromVersion)
  if (!installed) {
    info(`未检测到升级完成（记录 ${raw?.fromVersion || '-'} → ${raw?.toVersion || '-'}，当前 ${version}），不提示恢复业务`, 'update')
    clearPendingBusinessRestore()
    return null
  }

  const cfg = await loadConfig()
  const items = []
  const skipped = []
  for (const id of Array.isArray(raw?.bizTypes) ? raw.bizTypes : []) {
    const type = ALL_BIZ_TYPES.find((t) => t.id === id)
    if (!type) continue
    // 渠道型业务（跨境电商）没有 bizDirs 组：只要有一个启用且收发目录齐全的渠道就算可恢复
    if (type.channelBased) {
      if (!(cfg.cebChannels || []).some(cebChannelReady)) {
        skipped.push(type.title)
        continue
      }
      items.push({ id, title: type.title })
      continue
    }
    const entry = cfg.bizDirs?.[id]
    const missing = DIR_FIELDS.filter((d) => !String(entry?.[d.key] || '').trim())
    if (missing.length) {
      skipped.push(type.title)
      continue
    }
    items.push({ id, title: type.title })
  }
  if (skipped.length) info(`升级前运行中的业务目录配置不完整，本次不提示恢复：${skipped.join('、')}`, 'update')
  if (!items.length) {
    clearPendingBusinessRestore()
    return null
  }

  info(`升级后首次启动（当前 ${version}），等待用户确认恢复业务：${items.map((i) => i.title).join('、')}`, 'update')
  return { fromVersion: raw.fromVersion || '', toVersion: version, items }
}

export function clearPendingBusinessRestore() {
  try {
    fs.rmSync(markerFile(), { force: true })
  } catch (e) {
    warn(`清除升级恢复记录失败：${e.message}`, 'update')
  }
}
