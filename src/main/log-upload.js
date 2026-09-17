import path from 'node:path'
import { loadConfig } from './config.js'
import { getLogDir, info, listLogFiles, warn } from './logger.js'

let timer = null

function toRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export async function matchPending() {
  const cfg = await loadConfig()
  const dir = getLogDir()
  if (!cfg.logUpload.enabled || !dir) return []
  const re = toRegExp(cfg.logUpload.pattern)
  return listLogFiles()
    .filter((f) => re.test(f.name))
    .map((f) => ({ ...f, full: path.join(dir, f.name) }))
}

export async function run() {
  const cfg = await loadConfig()
  // 接口文档 v1.3 未提供日志上传接口；远端目录未配置时不做任何动作、不产生周期日志
  if (!cfg.logUpload.remoteDir) return { uploaded: 0, pending: [] }
  const files = await matchPending()
  if (!files.length) {
    warn('未匹配到待上传的日志文件', 'upload')
    return { uploaded: 0, pending: [] }
  }
  // TODO 上传通道与远端目录写法待后台确认
  info(`待上传 ${files.length} 个日志文件 → ${cfg.logUpload.remoteDir}`, 'upload')
  return { uploaded: 0, pending: files.map((f) => f.name) }
}

export async function start() {
  stop()
  const cfg = await loadConfig()
  if (!cfg.logUpload.enabled || !cfg.logUpload.remoteDir) {
    info('日志上传接口暂未提供（文档 v1.3 无此接口），本地日志正常保留', 'upload')
    return
  }
  timer = setInterval(run, cfg.logUpload.intervalMinutes * 60_000)
  info(`日志上传已启动，间隔 ${cfg.logUpload.intervalMinutes} 分钟，匹配 ${cfg.logUpload.pattern}`, 'upload')
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
