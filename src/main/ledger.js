import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { debug } from './logger.js'

// 投递账本 + 回执游标，JSON 落盘。每次关键状态变更都原子写回，进程崩溃可恢复。

const EMPTY = { version: 1, tasks: {}, receipts: {} }

let cache = null
let file = null

function ledgerFile() {
  return path.join(app.getPath('userData'), 'data', 'delivery-ledger.json')
}

async function writeAtomic(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.part`
  // fsync：断电/系统崩溃时 PREPARED/DELIVERED 状态不能只停留在 OS 缓冲里（文档 §10）
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(JSON.stringify(data, null, 2), 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, target)
}

export async function initLedger() {
  file = ledgerFile()
  try {
    cache = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!cache || typeof cache !== 'object') cache = structuredClone(EMPTY)
    cache.tasks ||= {}
    cache.receipts ||= {}
  } catch {
    cache = structuredClone(EMPTY)
  }
  await writeAtomic(file, cache)
  debug(`投递账本已加载 tasks=${Object.keys(cache.tasks).length} receipts=${Object.keys(cache.receipts).length}`, 'ledger')
  return file
}

export function taskKey(taskId, xmlSha256) {
  return `${taskId}:${xmlSha256}`
}

export function getTaskRecord(taskId, xmlSha256) {
  return cache?.tasks?.[taskKey(taskId, xmlSha256)] || null
}

export function findTaskByTaskId(taskId) {
  if (!cache) return null
  for (const rec of Object.values(cache.tasks)) {
    if (rec.taskId === taskId) return rec
  }
  return null
}

export async function upsertTask(record) {
  const key = taskKey(record.taskId, record.xmlSha256)
  cache.tasks[key] = {
    ...cache.tasks[key],
    ...record,
    updatedAt: Date.now()
  }
  await writeAtomic(file, cache)
  return cache.tasks[key]
}

export function getReceiptRecord(fullPath, sha256) {
  return cache?.receipts?.[`${fullPath}|${sha256}`] || null
}

export async function upsertReceipt(record) {
  const key = `${record.path}|${record.sha256}`
  cache.receipts[key] = {
    ...cache.receipts[key],
    ...record,
    updatedAt: Date.now()
  }
  await writeAtomic(file, cache)
  return cache.receipts[key]
}

export function pendingTaskCount() {
  if (!cache) return 0
  return Object.values(cache.tasks).filter(
    (t) => t.status === 'PREPARED' || (t.status === 'DELIVERED' && !t.reportOk)
  ).length
}

/** DELIVERED 但 OUTBOX_DROPPED 回报尚未确认的任务，用于补报（文档 §6：回报超时只重试同一个请求） */
export function unreportedTasks() {
  if (!cache) return []
  return Object.values(cache.tasks).filter(
    (t) => t.status === 'DELIVERED' && !t.reportOk && t.dispatchToken
  )
}

export function getLedgerPath() {
  return file
}
