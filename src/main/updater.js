import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { APP_ENV } from './env.js'
import { error, info, warn } from './logger.js'

const { autoUpdater } = electronUpdater

let broadcast = () => {}
const update = { status: 'idle', version: null, note: null }

function patch(values) {
  Object.assign(update, values)
  const snapshot = { ...update }
  broadcast(snapshot)
  return snapshot
}

export function onUpdateState(fn) {
  broadcast = fn
}

export function getUpdateState() {
  return { ...update }
}

export function setupUpdater() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true
  // test/dev 包发布为 GitHub prerelease；不打开时 /releases/latest 会 406
  autoUpdater.allowPrerelease = APP_ENV !== 'prod'

  autoUpdater.on('checking-for-update', () => patch({ status: 'checking', note: null }))
  autoUpdater.on('update-not-available', () => patch({ status: 'up-to-date', note: null }))

  autoUpdater.on('update-available', (release) => {
    patch({ status: 'downloading', version: release.version })
    info(`发现新版本 ${release.version}，开始下载`, 'update')
  })

  autoUpdater.on('download-progress', (p) => patch({ status: 'downloading', note: `${Math.round(p.percent * 10) / 10}%` }))

  autoUpdater.on('update-downloaded', (release) => {
    patch({ status: 'ready', version: release.version, note: null })
    info(`新版本 ${release.version} 已就绪，退出时自动安装`, 'update')
  })

  autoUpdater.on('error', (e) => {
    patch({ status: 'error', note: e.message })
    error(`更新失败：${e.message}`, 'update')
  })
}

export function checkForUpdates({ silent = true } = {}) {
  if (!app.isPackaged) {
    if (!silent) warn('开发环境不检查更新，请打包后验证', 'update')
    patch({ status: 'disabled' })
    return { ok: false, reason: 'dev' }
  }
  info('检查更新…', 'update')
  autoUpdater.checkForUpdates()
  return { ok: true }
}

export function quitAndInstall() {
  patch({ status: 'installing' })
  autoUpdater.quitAndInstall(true, true)
}
