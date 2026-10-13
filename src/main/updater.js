// 在线更新：electron-updater 直连后端投放的静态目录（对接文档 §1/§8）。
// 仅打包后的客户端启用；dev 模式不初始化。
// 策略：自动只做「检查」，发现新版本仅提示，是否下载、何时安装由用户决定；
// 安装前先停代理并等在途任务收尾，绝不打断「拉取→写单一窗口 OutBox→回报→上传回执」半途。
import { app } from 'electron'
import { getAgentState, stopAgent, waitIdle } from './agent.js'
import { APP_ENV } from './env.js'
import { debug, error, info, warn } from './logger.js'
import { feedUrlFor } from './update-config.js'

// electron-updater 是 CJS 包，ESM 下必须默认导入再解构（命名导入会报 does not provide an export）
import electronUpdaterPkg from 'electron-updater'
const { autoUpdater } = electronUpdaterPkg

// 启动后延迟首查，避开开机网络未就绪的窗口；之后每 6 小时静默检查一次
const STARTUP_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
// 安装前等在途任务收尾的上限：单个 HTTP 调用超时 20s，超时未收尾则按账本保证的原子性继续安装
const IDLE_WAIT_MS = 30_000

let state = {
  status: 'disabled', // disabled | idle | checking | upToDate | updateAvailable | downloading | downloaded | error
  version: null,
  size: null, // 新安装包字节数（latest.yml 提供，仅用于展示）
  percent: 0,
  note: null, // 友好提示（如服务器暂未发布新版本），不算错误
  error: null,
  checkedAt: null
}

let notify = () => {}
let checkTimer = null
let checking = false

function setState(patch) {
  state = { ...state, ...patch }
  notify(getUpdateState())
}

export function onUpdateState(cb) {
  if (typeof cb === 'function') notify = cb
}

export function getUpdateState() {
  return { ...state }
}

/** 服务器还没发布过 latest.yml（初始版本/新环境首次上线）属正常情况，不能当错误展示。
 * 注意后端会把 404 包成 HTTP 200 + JSON 错误体，electron-updater 解析不到版本号，
 * 实际抛的是 ERR_UPDATER_INVALID_VERSION（实测），而非 HTTP 404。 */
function feedMissing(e) {
  const msg = String(e?.message ?? e)
  return (
    e?.statusCode === 404 ||
    e?.code === 'ERR_UPDATER_INVALID_VERSION' ||
    /\b404\b|\bENOENT\b/i.test(msg)
  )
}

function markFeedMissing(e) {
  debug(`更新服务器暂无版本清单（latest.yml 未发布），视为已最新：${e?.message ?? e}`, 'update')
  setState({
    status: 'upToDate',
    version: null,
    size: null,
    percent: 0,
    note: '服务器暂未发布新版本',
    error: null,
    checkedAt: Date.now()
  })
}

export function setupUpdater() {
  if (!app.isPackaged) {
    setState({ status: 'disabled' })
    return
  }

  const feedUrl = feedUrlFor(APP_ENV)
  setState({ status: 'idle' })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  // 服务器仅保证单段 Range（文档 §1），关闭 multi-range 让差量下载走逐段请求。
  // feed 地址只留在主进程，不下发给渲染层/不显示在界面，也不打进日志
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false })

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (it) => {
    const version = it?.version ?? null
    const size = it?.files?.[0]?.size ?? null
    // 下载中/已下载时的周期复查不重置状态，只补齐版本信息
    if (state.status === 'downloading' || state.status === 'downloaded') {
      setState({ version, size })
      return
    }
    info(`发现新版本 ${version ?? '未知'}，等待用户选择下载`, 'update')
    setState({ status: 'updateAvailable', version, size, percent: 0, note: null })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'upToDate', version: null, size: null, percent: 0, note: null, checkedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (p) => {
    setState({ percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) })
  })
  autoUpdater.on('update-downloaded', (it) => {
    info(`新版本 ${it?.version ?? '未知'} 下载完成，等待用户确认安装`, 'update')
    setState({ status: 'downloaded', version: it?.version ?? state.version, percent: 100, error: null, checkedAt: Date.now() })
  })
  autoUpdater.on('error', (e) => {
    if (feedMissing(e)) {
      markFeedMissing(e)
      return
    }
    // 静默周期检查失败（现场断网等）只记日志，不弹打扰；界面状态仍如实展示
    warn(`在线更新出错：${e?.message ?? e}`, 'update')
    setState({ status: 'error', error: String(e?.message ?? e) })
  })

  checkTimer = setTimeout(() => {
    checkForUpdates(false)
    checkTimer = setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS)
  }, STARTUP_CHECK_DELAY_MS)

  info(`在线更新已启用`, 'update')
}

export function stopUpdater() {
  clearTimeout(checkTimer)
  clearInterval(checkTimer)
  checkTimer = null
}

export async function checkForUpdates(manual = true) {
  if (!app.isPackaged) return { ok: false, reason: '开发模式不支持在线更新，请使用打包后的客户端' }
  if (checking) return { ok: true, reason: '检查已在进行中' }
  checking = true
  try {
    setState({ status: 'checking', error: null })
    await autoUpdater.checkForUpdates()
    if (manual) setState({ checkedAt: Date.now() })
    return { ok: true }
  } catch (e) {
    if (feedMissing(e)) {
      markFeedMissing(e)
      return { ok: true, reason: '服务器暂未发布新版本' }
    }
    // error 事件已更新状态，这里只把结果返回给调用方
    return { ok: false, reason: String(e?.message ?? e) }
  } finally {
    checking = false
  }
}

export async function downloadUpdate() {
  if (!app.isPackaged) return { ok: false, reason: '开发模式不支持在线更新' }
  const retryable = state.status === 'error' && state.version
  if (state.status !== 'updateAvailable' && !retryable) {
    return { ok: false, reason: '当前没有待下载的新版本' }
  }
  try {
    setState({ status: 'downloading', percent: 0, error: null, note: null })
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (e) {
    if (feedMissing(e)) {
      markFeedMissing(e)
      return { ok: true, reason: '服务器暂未发布新版本' }
    }
    return { ok: false, reason: String(e?.message ?? e) }
  }
}

export async function quitAndInstall() {
  if (!app.isPackaged) return { ok: false, reason: '开发模式不支持在线更新' }
  if (state.status !== 'downloaded') return { ok: false, reason: '更新尚未下载完成' }
  // 安装即退出：先停代理，等在途的任务投递/回执上传收尾，避免打断与后端、单一窗口目录交互中的任务
  try {
    if (getAgentState().running) {
      stopAgent()
      await waitIdle(IDLE_WAIT_MS)
    }
  } catch (e) {
    warn(`安装前收尾代理任务异常：${e?.message ?? e}`, 'update')
  }
  info('代理任务已收尾，退出并安装新版本', 'update')
  // 延后一拍让 IPC 先返回；静默安装 + 装完自动拉起新版本
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (e) {
      error(`触发安装失败：${e?.message ?? e}`, 'update')
    }
  }, 200)
  return { ok: true }
}
