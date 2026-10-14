import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { debug, warn } from './logger.js'

// SQLite 投递账本 + 回执处理账本（文档 v1.3 §5.3 / §7.3 / §10；平台跨租户文档 §5.3/§8.2）：
// - tasks    以 taskId + clientSeqNo + xmlSha256 唯一，记录 PREPARED/DELIVERED 与回报确认；
//   平台模式额外落 tenantId/tradeMode（tenantId 仅用于账本、审计和排障，不参与目录选择）
// - receipts 以 xmlSha256 唯一，只记录本代理自己投递任务所产生回执的处理状态
//   （ACKED_MATCHED / ACKED_UNMATCHED / RETRY_PENDING / PERMANENT_REJECTED / LOCAL_UNMATCHED）
// - log_uploads 以日志文件名唯一，记录本地日志上传平台的结果与重试进度（见 log-upload.js）
// 库中数据全部来自本代理运行时的实际处理，不导入任何历史文件；进程重启后从库恢复。

let db = null
let file = null

const TASK_COLS = [
  'clientSeqNo',
  'tenantId',
  'tradeMode',
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
  'bizModule',
  'taskId',
  'tenantId',
  'clientSeqNo',
  'customsStatus',
  'retryCount',
  'nextRetryAt',
  'lastAttemptAt',
  'message',
  'firstSeenAt'
]

const LOG_UPLOAD_COLS = ['size', 'state', 'retryCount', 'nextRetryAt', 'lastAttemptAt', 'remoteId', 'remotePath', 'message', 'firstSeenAt']

function ledgerFile() {
  return path.join(app.getPath('userData'), 'data', 'delivery-ledger.db')
}

/**
 * 幂等初始化：日志上传要在代理未启动时也跑（bootstrap 阶段就要补传断网期间积压的日志），
 * 而账本原先只在 startAgent 里建。已打开时直接复用同一个连接，避免同库多连接。
 */
export async function initLedger() {
  if (db) return file
  file = ledgerFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  // WAL + FULL：账本状态变更即时落盘（文档 §5.3.9 / §7.3.6 要求同步持久化）
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS tasks (
      taskId INTEGER NOT NULL,
      clientSeqNo TEXT NOT NULL,
      xmlSha256 TEXT NOT NULL,
      tenantId INTEGER,
      tradeMode TEXT,
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
      PRIMARY KEY (taskId, clientSeqNo, xmlSha256)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      xmlSha256 TEXT PRIMARY KEY,
      fullPath TEXT,
      fileName TEXT,
      size INTEGER,
      mtime INTEGER,
      state TEXT NOT NULL,
      bizModule TEXT,
      taskId INTEGER,
      tenantId INTEGER,
      clientSeqNo TEXT,
      customsStatus TEXT,
      retryCount INTEGER NOT NULL DEFAULT 0,
      nextRetryAt INTEGER,
      lastAttemptAt INTEGER,
      message TEXT,
      firstSeenAt INTEGER,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS log_uploads (
      fileName TEXT PRIMARY KEY,
      size INTEGER,
      state TEXT NOT NULL,
      retryCount INTEGER NOT NULL DEFAULT 0,
      nextRetryAt INTEGER,
      lastAttemptAt INTEGER,
      remoteId INTEGER,
      remotePath TEXT,
      message TEXT,
      firstSeenAt INTEGER,
      updatedAt INTEGER NOT NULL
    );
  `)
  migrateTasksPk()
  ensureColumns('tasks', { tenantId: 'INTEGER', tradeMode: 'TEXT' })
  ensureColumns('receipts', { tenantId: 'INTEGER', clientSeqNo: 'TEXT' })
  const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get().c
  const receipts = db.prepare('SELECT COUNT(*) c FROM receipts').get().c
  debug(`投递账本已加载 tasks=${tasks} receipts=${receipts}`, 'ledger')
  return file
}

/**
 * v1.4 轮次迁移：旧库主键 (taskId, xmlSha256) → (taskId, clientSeqNo, xmlSha256)。
 * 旧行 clientSeqNo 为空时按 taskId 兜底生成，保证迁移可执行；历史数据原样保留。
 */
function migrateTasksPk() {
  const pkCols = db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .filter((c) => c.pk > 0)
    .map((c) => c.name.toLowerCase())
    .sort()
    if (pkCols.join(',') === 'clientseqno,taskid,xmlsha256') return
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE tasks_v14 (
        taskId INTEGER NOT NULL,
        clientSeqNo TEXT NOT NULL,
        xmlSha256 TEXT NOT NULL,
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
        PRIMARY KEY (taskId, clientSeqNo, xmlSha256)
      );
      INSERT INTO tasks_v14 (taskId, clientSeqNo, xmlSha256, fileName, tempName, outBox, status,
        dispatchToken, businessModuleCode, leaseExpireAt, reportOk, reportConflictCode, firstAt, updatedAt)
      SELECT taskId, COALESCE(NULLIF(clientSeqNo, ''), 'legacy-' || taskId), xmlSha256, fileName, tempName, outBox, status,
        dispatchToken, businessModuleCode, leaseExpireAt, reportOk, reportConflictCode, firstAt, updatedAt
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v14 RENAME TO tasks;
    `)
    db.exec('COMMIT')
    warn('投递账本已迁移到 v1.4 三段主键（taskId + clientSeqNo + xmlSha256）', 'ledger')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 旧库补列（平台跨租户改造）：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列 */
function ensureColumns(table, cols) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name.toLowerCase()))
  for (const [name, ddl] of Object.entries(cols)) {
    if (!present.has(name.toLowerCase())) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
  }
}

export function getTaskRecord(taskId, clientSeqNo, xmlSha256) {
  return (
    db
      .prepare('SELECT * FROM tasks WHERE taskId = ? AND clientSeqNo = ? AND xmlSha256 = ?')
      .get(taskId, clientSeqNo, xmlSha256) || null
  )
}

/** 同一 taskId + clientSeqNo 的既有轮次记录（用于协议异常判定：同轮次内容不应变化） */
export function getRoundRecord(taskId, clientSeqNo) {
  return db.prepare('SELECT * FROM tasks WHERE taskId = ? AND clientSeqNo = ? LIMIT 1').get(taskId, clientSeqNo) || null
}

/**
 * 平台跨租户模式回执关联（跨租户文档 §7.4）：按 XML 内 ClientSeqNo 查本地已投递轮次。
 * 不同租户可能出现相同 clientSeqNo，调用方必须要求恰好命中一条，0 条或多条均停止自动上传并告警。
 */
export function deliveredRoundsByClientSeqNo(clientSeqNo) {
  return db
    .prepare("SELECT * FROM tasks WHERE clientSeqNo = ? AND status = 'DELIVERED' ORDER BY firstAt")
    .all(clientSeqNo)
}

export async function upsertTask(record) {
  const cols = []
  const vals = []
  for (const c of TASK_COLS) {
    if (record[c] === undefined) continue
    cols.push(c)
    vals.push(c === 'reportOk' ? (record[c] ? 1 : 0) : record[c])
  }
  // 部分更新（回报确认/冲突冻结等，不带 status）：行必然已存在。
  // 必须用 UPDATE：INSERT..ON CONFLICT 会对未携带的 NOT NULL 列（status）抛错，
  // 即使目标行存在也一样（SQLite 按候选插入行独立检查非冲突目标约束）。
  if (record.status === undefined) {
    const setSql = cols.map((c) => `${c} = ?`).join(', ')
    const res = db
      .prepare(`UPDATE tasks SET ${setSql}, updatedAt = ? WHERE taskId = ? AND xmlSha256 = ? AND clientSeqNo = ?`)
      .run(...vals, Date.now(), record.taskId, record.xmlSha256, record.clientSeqNo)
    if (res.changes === 0) warn(`账本部分更新未命中行 taskId=${record.taskId}（记录不存在，忽略）`, 'ledger')
    return getTaskRecord(record.taskId, record.clientSeqNo, record.xmlSha256)
  }
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ')
  db.prepare(
    `INSERT INTO tasks (taskId, clientSeqNo, xmlSha256, ${cols.join(', ')}, updatedAt)
     VALUES (?, ?, ?, ${placeholders}, ?)
     ON CONFLICT(taskId, clientSeqNo, xmlSha256) DO UPDATE SET ${updates}, updatedAt = excluded.updatedAt`
  ).run(record.taskId, record.clientSeqNo, record.xmlSha256, ...vals, Date.now())
  return getTaskRecord(record.taskId, record.clientSeqNo, record.xmlSha256)
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
  // 部分更新（不带 state）同理走 UPDATE，规避 NOT NULL(state) 的候选行检查
  if (record.state === undefined) {
    const setSql = cols.map((c) => `${c} = ?`).join(', ')
    const res = db
      .prepare(`UPDATE receipts SET ${setSql}, updatedAt = ? WHERE xmlSha256 = ?`)
      .run(...vals, Date.now(), record.xmlSha256)
    if (res.changes === 0) warn(`回执账本部分更新未命中行 sha=${String(record.xmlSha256).slice(0, 12)}（记录不存在，忽略）`, 'ledger')
    return getReceiptRecord(record.xmlSha256)
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

/**
 * 指定业务模块下已投递（DELIVERED）任务的文件名主干（去掉 .xml 扩展名）。
 * 单一窗口回执文件名 = 前缀 + 所投递文件名主干 + 回执流水号，
 * 据此识别 InBox 中属于本模块任务的回执；其他模块/系统的历史文件不处理、不入库。
 * 按模块过滤，保证多业务模块并存时回执归属互不混淆。
 */
export function deliveredFileStems(moduleCode) {
  return db
    .prepare("SELECT fileName FROM tasks WHERE status = 'DELIVERED' AND fileName IS NOT NULL AND businessModuleCode = ?")
    .all(moduleCode)
    .map((r) => String(r.fileName).replace(/\.xml$/i, ''))
}

/**
 * 日志上传账本（对接《前置机日志文件上传对接文档》§5：失败重试 + 断网离线补传）。
 * 以日志文件名为唯一键：同一天的文件只上传一次，进程重启后按库中状态续做，不重传也不漏传。
 */
export function getLogUpload(fileName) {
  return db.prepare('SELECT * FROM log_uploads WHERE fileName = ?').get(fileName) || null
}

export function upsertLogUpload(record) {
  const cols = []
  const vals = []
  for (const c of LOG_UPLOAD_COLS) {
    if (record[c] === undefined) continue
    cols.push(c)
    vals.push(record[c])
  }
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ')
  db.prepare(
    `INSERT INTO log_uploads (fileName, ${cols.join(', ')}, updatedAt)
     VALUES (?, ${placeholders}, ?)
     ON CONFLICT(fileName) DO UPDATE SET ${updates}, updatedAt = excluded.updatedAt`
  ).run(record.fileName, ...vals, Date.now())
  return getLogUpload(record.fileName)
}

/**
 * 把 BLOCKED（服务端未开通道 / 鉴权失败）的记录退回 PENDING，返回条数。
 * 这类终态是外部原因造成的，换密钥或改地址之后就该再试一次；
 * FAILED 是内容问题或重试已耗尽，不在这里复活，避免每次启动都重打一遍必然失败的请求。
 */
export function resetTerminalLogUploads() {
  return db.prepare("UPDATE log_uploads SET state = 'PENDING', retryCount = 0, nextRetryAt = NULL, updatedAt = ? WHERE state = 'BLOCKED'").run(Date.now())
    .changes
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
