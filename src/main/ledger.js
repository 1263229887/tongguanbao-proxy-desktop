import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { debug, info, warn } from './logger.js'

// SQLite 投递账本 + 回执处理账本（文档 v1.3 §5.3 / §7.3 / §10）：
// - tasks   以 taskId + xmlSha256 唯一，记录 PREPARED/DELIVERED 与回报确认
// - receipts 以 xmlSha256 唯一，记录 ACKED_MATCHED / ACKED_UNMATCHED / RETRY_PENDING / PERMANENT_REJECTED
// 进程重启后从库中恢复，不依赖内存状态。

let db = null
let file = null

const TASK_COLS = [
  'clientSeqNo',
  'fileName',
  'tempName',
  'outBox',
  'status',
  'dispatchToken',
  'businessModuleCode',
  'leaseExpireAt',
  'reportOk',
  'reportConflictCode',
  'firstAt'
]

const RECEIPT_COLS = [
  'fullPath',
  'fileName',
  'size',
  'mtime',
  'state',
  'taskId',
  'customsStatus',
  'retryCount',
  'nextRetryAt',
  'lastAttemptAt',
  'message',
  'firstSeenAt'
]

function ledgerFile() {
  return path.join(app.getPath('userData'), 'data', 'delivery-ledger.db')
}

function legacyJsonFile() {
  return path.join(app.getPath('userData'), 'data', 'delivery-ledger.json')
}

/** 旧版 JSON 账本一次性导入 SQLite（按 sha 去重），原文件保留不动 */
function importLegacyJson() {
  if (!fsSync.existsSync(legacyJsonFile())) return
  try {
    const raw = JSON.parse(fsSync.readFileSync(legacyJsonFile(), 'utf8'))
    const insTask = db.prepare(`
      INSERT INTO tasks (taskId, xmlSha256, clientSeqNo, fileName, tempName, outBox, status,
        dispatchToken, businessModuleCode, leaseExpireAt, reportOk, firstAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(taskId, xmlSha256) DO NOTHING
    `)
    for (const t of Object.values(raw.tasks || {})) {
      insTask.run(
        t.taskId,
        t.xmlSha256,
        t.clientSeqNo ?? null,
        t.fileName ?? null,
        t.tempName ?? null,
        t.outBox ?? null,
        t.status ?? null,
        t.dispatchToken ?? null,
        t.businessModuleCode ?? null,
        t.leaseExpireAt ?? null,
        t.reportOk ? 1 : 0,
        t.firstAt ?? null,
        t.updatedAt ?? Date.now()
      )
    }
    // 旧状态映射：UPLOADED→ACKED_MATCHED，UNMATCHED→ACKED_UNMATCHED，FAILED_CONTENT→PERMANENT_REJECTED
    const stateMap = { UPLOADED: 'ACKED_MATCHED', UNMATCHED: 'ACKED_UNMATCHED', FAILED_CONTENT: 'PERMANENT_REJECTED' }
    const insReceipt = db.prepare(`
      INSERT INTO receipts (xmlSha256, fullPath, fileName, state, message, lastAttemptAt, firstSeenAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(xmlSha256) DO NOTHING
    `)
    for (const r of Object.values(raw.receipts || {})) {
      if (!r.sha256) continue
      insReceipt.run(
        r.sha256,
        r.path ?? null,
        r.fileName ?? null,
        stateMap[r.status] || 'ACKED_UNMATCHED',
        r.message ?? null,
        r.updatedAt ?? Date.now(),
        r.updatedAt ?? Date.now(),
        r.updatedAt ?? Date.now()
      )
    }
    info(`旧 JSON 账本已导入 SQLite：tasks=${Object.keys(raw.tasks || {}).length} receipts=${Object.keys(raw.receipts || {}).length}`, 'ledger')
  } catch (e) {
    warn(`旧 JSON 账本导入失败（忽略，继续使用新库）：${e.message}`, 'ledger')
  }
}

export async function initLedger() {
  file = ledgerFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  // WAL + FULL：账本状态变更即时落盘（文档 §5.3.9 / §7.3.6 要求同步持久化）
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS tasks (
      taskId INTEGER NOT NULL,
      xmlSha256 TEXT NOT NULL,
      clientSeqNo TEXT,
      fileName TEXT,
      tempName TEXT,
      outBox TEXT,
      status TEXT NOT NULL,
      dispatchToken TEXT,
      businessModuleCode TEXT,
      leaseExpireAt TEXT,
      reportOk INTEGER NOT NULL DEFAULT 0,
      reportConflictCode INTEGER,
      firstAt INTEGER,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (taskId, xmlSha256)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      xmlSha256 TEXT PRIMARY KEY,
      fullPath TEXT,
      fileName TEXT,
      size INTEGER,
      mtime INTEGER,
      state TEXT NOT NULL,
      taskId INTEGER,
      customsStatus TEXT,
      retryCount INTEGER NOT NULL DEFAULT 0,
      nextRetryAt INTEGER,
      lastAttemptAt INTEGER,
      message TEXT,
      firstSeenAt INTEGER,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `)
  const imported = db.prepare('SELECT v FROM meta WHERE k = ?').get('legacy_imported')
  if (!imported) {
    importLegacyJson()
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('legacy_imported', '1')
  }
  const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get().c
  const receipts = db.prepare('SELECT COUNT(*) c FROM receipts').get().c
  debug(`投递账本已加载 tasks=${tasks} receipts=${receipts}`, 'ledger')
  return file
}

export function getTaskRecord(taskId, xmlSha256) {
  return db.prepare('SELECT * FROM tasks WHERE taskId = ? AND xmlSha256 = ?').get(taskId, xmlSha256) || null
}

export function findTaskByTaskId(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE taskId = ? LIMIT 1').get(taskId) || null
}

export async function upsertTask(record) {
  const cols = []
  const vals = []
  for (const c of TASK_COLS) {
    if (record[c] === undefined) continue
    cols.push(c)
    vals.push(c === 'reportOk' ? (record[c] ? 1 : 0) : record[c])
  }
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ')
  db.prepare(
    `INSERT INTO tasks (taskId, xmlSha256, ${cols.join(', ')}, updatedAt)
     VALUES (?, ?, ${placeholders}, ?)
     ON CONFLICT(taskId, xmlSha256) DO UPDATE SET ${updates}, updatedAt = excluded.updatedAt`
  ).run(record.taskId, record.xmlSha256, ...vals, Date.now())
  return getTaskRecord(record.taskId, record.xmlSha256)
}

/** 回执处理账本：以 XML 原始字节 SHA-256 为唯一键（文档 §7.3.5） */
export function getReceiptRecord(xmlSha256) {
  return db.prepare('SELECT * FROM receipts WHERE xmlSha256 = ?').get(xmlSha256) || null
}

export async function upsertReceipt(record) {
  const cols = []
  const vals = []
  for (const c of RECEIPT_COLS) {
    if (record[c] === undefined) continue
    cols.push(c)
    vals.push(record[c])
  }
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ')
  db.prepare(
    `INSERT INTO receipts (xmlSha256, ${cols.join(', ')}, updatedAt)
     VALUES (?, ${placeholders}, ?)
     ON CONFLICT(xmlSha256) DO UPDATE SET ${updates}, updatedAt = excluded.updatedAt`
  ).run(record.xmlSha256, ...vals, Date.now())
  return getReceiptRecord(record.xmlSha256)
}

export function pendingTaskCount() {
  return db
    .prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'PREPARED' OR (status = 'DELIVERED' AND reportOk = 0)")
    .get().c
}

/** DELIVERED 但 OUTBOX_DROPPED 回报未确认的任务，用于补报（文档 §6：回报超时只重试同一个请求） */
export function unreportedTasks() {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'DELIVERED' AND reportOk = 0 AND dispatchToken IS NOT NULL")
    .all()
}

export function getLedgerPath() {
  return file
}

export function closeLedger() {
  try {
    db?.close()
  } catch {}
  db = null
}
