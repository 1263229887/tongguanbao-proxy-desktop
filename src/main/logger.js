import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import dayjs from 'dayjs'
import { LOG_LEVELS } from '../shared/log-levels.js'

const MAX_LINES = 500
const LEVELS = LOG_LEVELS
const PAD = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }
// 写盘门槛：debug 只进内存缓冲和界面实时列表，不落文件。
// 现场日志要定期上传到平台给后端排障，逐条「已处理，跳过」这类流水会把它淹掉；
// 需要看 debug 时在参数配置里把日志级别调到 debug 即可，无需改代码。
const RANK = { debug: 0, info: 1, warn: 2, error: 3 }

const buffer = []
const listeners = new Set()

let logDir = null
let stream = null
let streamDate = null
let retentionDays = 30
let fileLevel = 'info'
let seq = 0

function today() {
  return dayjs().format('YYYY-MM-DD')
}

function stamp(ts) {
  return dayjs(ts).format('YYYY-MM-DD HH:mm:ss.SSS')
}

function fileNameFor(dateKey) {
  return `app-${dateKey}.log`
}

function ensureStream() {
  const key = today()
  if (stream && streamDate === key) return stream
  stream?.end()
  stream = fs.createWriteStream(path.join(logDir, fileNameFor(key)), { flags: 'a' })
  stream.on('error', () => {
    stream = null
    streamDate = null
  })
  streamDate = key
  return stream
}

function purge() {
  if (!logDir) return
  const cutoff = Date.now() - retentionDays * 86_400_000
  for (const name of fs.readdirSync(logDir)) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
    const full = path.join(logDir, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
    } catch {}
  }
}

export function initLogger({ days, level } = {}) {
  retentionDays = Number(days) > 0 ? Number(days) : retentionDays
  fileLevel = RANK[level] !== undefined ? level : fileLevel
  logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  ensureStream()
  purge()
  return logDir
}

export function getLogDir() {
  return logDir
}

export function log(level, msg, scope = '') {
  const lv = LEVELS.includes(level) ? level : 'info'
  const entry = { id: ++seq, at: Date.now(), level: lv, scope, msg: String(msg) }
  buffer.push(entry)
  if (buffer.length > MAX_LINES) buffer.shift()

  if (RANK[lv] >= RANK[fileLevel]) {
    const line = `${stamp(entry.at)} [${PAD[lv]}]${scope ? ` [${scope}]` : ''} ${entry.msg}`
    try {
      ensureStream()?.write(line + '\n')
    } catch {}
  }

  for (const fn of listeners) fn(entry)
  return entry
}

export const debug = (msg, scope) => log('debug', msg, scope)
export const info = (msg, scope) => log('info', msg, scope)
export const warn = (msg, scope) => log('warn', msg, scope)
export const error = (msg, scope) => log('error', msg, scope)

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getLogs() {
  return buffer.slice(-MAX_LINES)
}

export function listLogFiles() {
  if (!logDir) return []
  return fs
    .readdirSync(logDir)
    .filter((n) => n.endsWith('.log'))
    .map((name) => {
      const st = fs.statSync(path.join(logDir, name))
      return { name, size: st.size, mtime: st.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** 当天日期键，日志上传据此判断哪些文件已经「封口」（不再被写入） */
export function todayKey() {
  return today()
}

/** 从 app-YYYY-MM-DD.log 里取日期键；文件名不合规则返回 null */
export function logFileDateKey(name) {
  const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(String(name))
  return m ? m[1] : null
}

/**
 * 把当前写流关掉并等它 flush 完，之后的写入会自动重开文件。
 * 退出前上传当天日志必须先做这一步：createWriteStream 是带缓冲的，
 * 不 flush 直接读文件会丢掉最后几条（往往正是退出/崩溃那几条）。
 */
export function flushLogger() {
  return new Promise((resolve) => {
    if (!stream) return resolve()
    const closing = stream
    stream = null
    streamDate = null
    closing.end(() => resolve())
  })
}

/**
 * 读日志文件原始字节，供压缩上传。
 * tailBytes 用于兜底：日志按天滚动且没有大小上限，异常循环可能把单日文件写到很大，
 * 而上传接口单文件限 50MiB；超限时只保留尾部（最近的记录才是排障要的）。
 */
export function readLogBytes(name, { tailBytes = 0 } = {}) {
  const full = path.join(logDir || '', path.basename(name))
  const buf = fs.readFileSync(full)
  if (tailBytes > 0 && buf.length > tailBytes) return buf.subarray(buf.length - tailBytes)
  return buf
}

export function readLogFile(name, tail = 300) {
  const full = path.join(logDir || '', path.basename(name))
  if (!full || !fs.existsSync(full)) return []
  return fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-tail)
}

export function clearLogs() {
  buffer.length = 0
}

export function closeLogger() {
  stream?.end()
  stream = null
}
