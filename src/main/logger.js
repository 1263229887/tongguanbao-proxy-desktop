import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const MAX_LINES = 500
const LEVELS = ['debug', 'info', 'warn', 'error']
const PAD = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }

const buffer = []
const listeners = new Set()

let logDir = null
let stream = null
let streamDate = null
let retentionDays = 30
let seq = 0

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stamp(ts) {
  const d = new Date(ts)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
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

export function initLogger({ days } = {}) {
  retentionDays = Number(days) > 0 ? Number(days) : retentionDays
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

  const line = `${stamp(entry.at)} [${PAD[lv]}]${scope ? ` [${scope}]` : ''} ${entry.msg}`
  try {
    ensureStream()?.write(line + '\n')
  } catch {}

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
