import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import dayjs from 'dayjs'
import { error, warn } from './logger.js'

// 主进程崩溃与异常退出捕获。
// 现场前置机装在客户内网、后端登录不上去，程序静默死掉就等于彻底失联：
// 心跳停了后端只能告警「离线」，看不到原因。所以这里补三件事——
// 1) 未捕获异常 / Promise 拒绝落日志后继续运行：代理不能因为一次异常就整台停摆，
//    停下来客户现场的报关单就没人投递了，比带着一个已记录的异常继续跑代价更大；
// 2) 子进程（GPU / 网络服务等）消失落日志，它不会带走主进程但会让界面渲染异常；
// 3) 运行标记文件：正常退出会删掉它，启动时发现残留即说明上次是崩溃或断电，
//    据此立刻补传当时的日志，并把摘要交给心跳上报，让后端在监控页直接看到。

let crashNote = ''
let shuttingDown = false

function flagFile() {
  return path.join(app.getPath('userData'), 'running.flag')
}

/**
 * 退出流程一开始就调用。正常退出时 Electron 会主动 kill 掉 GPU / Utility / 渲染等子进程，
 * 那些 child-process-gone 全是 reason=killed code=15，不是故障；
 * 不打这个标记的话每次退出都会往日志里写三四条假的「子进程异常退出」（实测 2026-10-14）。
 */
export function beginShutdown() {
  shuttingDown = true
}

/** 供心跳汇总；上报成功一次后由 agent 调用 clearCrashNote 清掉，避免长期挂在 lastError 上 */
export function getCrashNote() {
  return crashNote
}

export function clearCrashNote() {
  crashNote = ''
}

function writeFlag() {
  try {
    fs.mkdirSync(path.dirname(flagFile()), { recursive: true })
    fs.writeFileSync(flagFile(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8')
  } catch (e) {
    warn(`写运行标记失败：${e.message}`, 'crash')
  }
}

/** 启动时调用：返回上次是否异常退出，并写下本次运行标记 */
export function markRunning() {
  let previous = null
  try {
    previous = JSON.parse(fs.readFileSync(flagFile(), 'utf8'))
  } catch {}
  writeFlag()
  if (!previous?.startedAt) return false
  crashNote = `上次运行未正常退出（启动于 ${dayjs(previous.startedAt).format('YYYY-MM-DD HH:mm:ss')}），可能已崩溃或断电`
  error(`${crashNote} pid=${previous.pid ?? '-'}`, 'crash')
  return true
}

/** 正常退出时调用：清掉标记，下次启动才不会误判成崩溃 */
export function markCleanExit() {
  try {
    fs.rmSync(flagFile(), { force: true })
  } catch {}
}

export function setupCrashGuard() {
  process.on('uncaughtException', (e) => {
    crashNote = `主进程未捕获异常：${e?.message ?? e}`
    error(`${crashNote}\n${e?.stack ?? ''}`, 'crash')
  })

  process.on('unhandledRejection', (reason) => {
    const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : ''
    error(`未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason ?? '')}${stack}`, 'crash')
  })

  app.on('child-process-gone', (_e, details) => {
    if (shuttingDown || details.reason === 'clean-exit') return
    error(`子进程异常退出 type=${details.type} reason=${details.reason} code=${details.exitCode}`, 'crash')
  })
}
