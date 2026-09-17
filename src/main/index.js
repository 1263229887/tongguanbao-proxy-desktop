import path from 'node:path'
import { app, BrowserWindow, nativeImage, session, globalShortcut } from 'electron'
import { write as writeAutoStart } from './autostart.js'
import { loadConfig } from './config.js'
import { broadcast, registerIpc } from './ipc.js'
import { closeLogger, error, info, initLogger, log, subscribe } from './logger.js'
import { start as startLogUpload, stop as stopLogUpload } from './log-upload.js'
import { onStateChange as onPollState, resume as resumePoller, stop as stopPoller } from './poller.js'
import { checkForUpdates, onUpdateState, setupUpdater } from './updater.js'
import { createTray, destroyTray } from './tray.js'
import { APP_ENV } from './env.js'

const DEV_URL = process.env.ELECTRON_RENDERER_URL
let win = null
let isQuitting = false
let hideHintShown = false

const DIAG_LEVEL = { warning: 'warn', error: 'error' }

function attachDiagnostics(target) {
  const wc = target.webContents
  wc.on('console-message', (e) => {
    const level = DIAG_LEVEL[e.level]
    if (level) log(level, `${e.message} (${e.sourceId || ''}:${e.lineNumber ?? 0})`, 'renderer')
  })
  wc.on('render-process-gone', (_e, details) => error(`渲染进程异常退出 reason=${details.reason} code=${details.exitCode}`, 'renderer'))
  wc.on('did-fail-load', (_e, code, desc, url) => error(`页面加载失败 ${code} ${desc} ${url}`, 'renderer'))
}

// 渲染进程直接请求后台时需要放行 CORS；生产同样依赖渲染进程发请求。
function setupNetworkRelax() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {}
    callback({
      responseHeaders: {
        ...headers,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET,POST,PUT,DELETE,OPTIONS'],
        'Access-Control-Allow-Headers': ['*']
      }
    })
  })
}

function setupDevToolsShortcut() {
  // 生产无菜单栏也可 Ctrl+Shift+I 打开调试台（Network 查看轮询请求）
  try {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (!win || win.isDestroyed()) return
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
      else win.webContents.openDevTools({ mode: 'detach' })
    })
  } catch (e) {
    warnShortcut(e)
  }
}

function warnShortcut(e) {
  error(`注册调试台快捷键失败：${e.message}`, 'app')
}

function showMainWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: '#f3f5f8',
    autoHideMenuBar: true,
    title: app.name,
    icon: path.join(import.meta.dirname, 'assets/tray.png'),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 关闭以便 preload 稳定桥接；网络仍只在渲染进程用 axios
      sandbox: false,
      // 放行跨域，渲染进程才能直连后台 HTTPS
      webSecurity: false,
      spellcheck: false,
      // 生产也允许打开 DevTools（快捷键），便于现场排障
      devTools: true,
      backgroundThrottling: false
    }
  })

  attachDiagnostics(win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
  })

  // 关闭按钮只收进后台，进程继续跑轮询和日志上传；彻底退出走托盘/任务栏右键
  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    win.hide()
    if (!hideHintShown) {
      hideHintShown = true
      info('主界面已关闭，程序仍在后台运行；要彻底退出请在任务栏图标右键选择「退出」', 'app')
    }
  })

  // 开发/测试包默认打开调试台，方便直接看 Network
  if (!app.isPackaged || APP_ENV !== 'prod') {
    win.webContents.once('did-finish-load', () => {
      win?.webContents.openDevTools({ mode: 'detach' })
    })
  }

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(import.meta.dirname, '../../dist/renderer/index.html'))
}

// Windows 任务栏右键菜单里的「退出」通过再拉起一个带参数的实例实现，
// 单实例锁会把参数转交给 already-running 的实例处理。
function setupJumpList() {
  if (process.platform !== 'win32') return
  app.setJumpList([
    {
      // 分隔符只允许出现在标准 Tasks 分组；自定义分组带 separator 会报错
      type: 'tasks',
      items: [
        { type: 'task', title: '打开主界面', program: process.execPath, args: '--show', description: '打开主界面' },
        { type: 'separator' },
        { type: 'task', title: '退出', program: process.execPath, args: '--quit', description: '彻底退出程序' }
      ]
    }
  ])
}

async function bootstrap() {
  // macOS 下 BrowserWindow 的 icon 不影响 Dock，必须显式设置；Windows 的图标由 build/icon.png 在打包时生成
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(import.meta.dirname, 'assets/dock.png')))
  }

  const cfg = await loadConfig()
  const logDir = initLogger({ days: cfg.logKeepDays })

  setupNetworkRelax()

  subscribe((entry) => broadcast('log:entry', entry))
  onPollState((state) => broadcast('poll:state', state))
  onUpdateState((state) => broadcast('update:state', state))

  registerIpc({
    onConfigSaved: async (next) => {
      initLogger({ days: next.logKeepDays })
      writeAutoStart(next.autoLaunch)
      await resumePoller()
      await startLogUpload()
    }
  })

  setupUpdater()
  setupJumpList()
  createWindow()
  createTray({ showWindow: showMainWindow, quit: quitApp })
  setupDevToolsShortcut()

  info(`${app.name} ${app.getVersion()} 启动，env=${APP_ENV}，日志目录 ${logDir}`, 'app')
  info(`企业鉴权密钥已本地缓存于 userData/config.json（升级重装不丢）`, 'app')
  if (app.isPackaged) writeAutoStart(cfg.autoLaunch)
  // 代理默认不自启，需用户在首页点「启动」
  await startLogUpload()
  if (app.isPackaged) setTimeout(() => checkForUpdates(), 8_000)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--quit')) {
      quitApp()
      return
    }
    showMainWindow()
  })

  app.whenReady().then(bootstrap)

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll()
    } catch {}
  })

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
    stopPoller()
    stopLogUpload()
    destroyTray()
    closeLogger()
  })
}
