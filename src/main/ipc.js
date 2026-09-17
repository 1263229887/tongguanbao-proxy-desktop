import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { read as readAutoStart } from './autostart.js'
import { testConnection } from './backend.js'
import { getAgentState, runAgentOnce, startAgent, stopAgent } from './agent.js'
import { setupNetBridge } from './net-bridge.js'
import { APP_ENV } from './env.js'
import { checkDir, loadConfig, saveConfig } from './config.js'
import { run as runLogUpload } from './log-upload.js'
import { clearLogs, getLogDir, getLogs, listLogFiles, readLogFile } from './logger.js'
import { getState, runNow, start as startPoller, stop as stopPoller } from './poller.js'
import { checkForUpdates, getUpdateState, quitAndInstall } from './updater.js'
import { importSwBizDirs } from './sw-import.js'
import { info, warn } from './logger.js'

const STARTED_AT = Date.now()

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc({ onConfigSaved } = {}) {
  setupNetBridge()

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:set', async (_e, patch) => {
    const next = await saveConfig(patch)
    await onConfigSaved?.(next)
    return next
  })

  ipcMain.handle('config:checkDir', (_e, args) => checkDir(args?.dir, args))

  ipcMain.handle('sw:importDirs', async (_e, args) => {
    try {
      const res = await importSwBizDirs(args?.basePath)
      if (res?.ok) info(`单一窗口目录导入成功 source=${res.source} mapped=${Object.keys(res.mapped || {}).join(',')}`, 'access')
      else warn(`单一窗口目录导入失败：${res?.reason}`, 'access')
      return res
    } catch (e) {
      warn(`单一窗口目录导入异常：${e.stack || e.message}`, 'access')
      return { ok: false, reason: e.message, source: null, mapped: {}, matchedFormIds: [], unmatchedFormIds: [] }
    }
  })

  ipcMain.handle('dialog:pickDir', async (e, defaultPath) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      defaultPath: defaultPath || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    return path.normalize(res.filePaths[0])
  })

  ipcMain.handle('access:test', () => loadConfig().then(testConnection))

  ipcMain.handle('autostart:get', () => readAutoStart())

  ipcMain.handle('poll:start', () => startPoller())
  ipcMain.handle('poll:stop', () => stopPoller())
  ipcMain.handle('poll:run', () => runNow())
  ipcMain.handle('poll:state', () => getState())
  ipcMain.handle('agent:start', () => startAgent())
  ipcMain.handle('agent:stop', () => stopAgent())
  ipcMain.handle('agent:run', () => runAgentOnce())
  ipcMain.handle('agent:state', () => getAgentState())

  ipcMain.handle('logs:get', () => getLogs())
  ipcMain.handle('logs:clear', () => clearLogs())
  ipcMain.handle('logs:files', () => listLogFiles())
  ipcMain.handle('logs:read', (_e, args) => readLogFile(args?.name, args?.tail))
  ipcMain.handle('logs:dir', () => getLogDir())
  ipcMain.handle('logs:open', () => getLogDir() && shell.openPath(getLogDir()))
  ipcMain.handle('logs:upload-now', () => runLogUpload())

  // 生产也可用快捷键/此接口开 DevTools，Network 看轮询请求
  ipcMain.handle('devtools:open', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return false
    win.webContents.openDevTools({ mode: 'detach' })
    return true
  })

  ipcMain.handle('app:meta', () => ({
    startedAt: STARTED_AT,
    name: app.name,
    env: APP_ENV,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch
  }))

  ipcMain.handle('update:check', () => checkForUpdates({ silent: false }))
  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:install', () => quitAndInstall())
}

export { broadcast }
