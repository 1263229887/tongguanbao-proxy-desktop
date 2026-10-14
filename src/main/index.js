import path from 'node:path'
import { app, BrowserWindow, nativeImage, session, globalShortcut } from 'electron'
import { write as writeAutoStart } from './autostart.js'
import { loadConfig } from './config.js'
import { broadcast, registerIpc } from './ipc.js'
import { closeLogger, error, info, initLogger, log, subscribe, warn } from './logger.js'
import { closeLedger, initLedger } from './ledger.js'
import { flushNow as flushLogs, start as startLogUpload, stop as stopLogUpload } from './log-upload.js'
import { beginShutdown, markCleanExit, markRunning, setupCrashGuard } from './crash-guard.js'
import { onStateChange as onPollState, resume as resumePoller, stop as stopPoller } from './poller.js'
import { createTray, destroyTray } from './tray.js'
import { APP_ENV } from './env.js'
import { onUpdateState, setupUpdater, stopUpdater } from './updater.js'

const DEV_URL = process.env.ELECTRON_RENDERER_URL
// dev 下禁用 HTTP 磁盘缓存：vite 预打包依赖带 immutable 缓存头，缓存一旦损坏
// （net\disk_cache Critical error -8）模块读取会静默失败，页面卡成白屏
if (DEV_URL) app.commandLine.appendSwitch('disable-http-cache')

const RENDERER_FILE = path.join(import.meta.dirname, '../../dist/renderer/index.html')
const LOAD_TIMEOUT_MS = 15000
const LOAD_RETRY_MS = 2000
// 崩溃后补传日志的等待时间：给界面进程留出加载并完成初始化的余量
const CRASH_FLUSH_DELAY_MS = 30000
// 退出前补传日志的最长等待：超过就放弃上传直接退出，不能让用户点「退出」后卡住
const QUIT_FLUSH_TIMEOUT_MS = 20000

// 加载失败/超时的兜底页（data: URL，无脚本），主进程按 LOAD_RETRY_MS 自动重载真实页面
const FALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>通关宝 proxy</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f5f8;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#475569}
  .dot{display:inline-block;width:8px;height:8px;margin:0 3px;border-radius:50%;background:#94a3b8;animation:pulse 1.2s infinite}
  .dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
  @keyframes pulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
</style></head>
<body><div style="text-align:center">
  <div style="font-size:15px;margin-bottom:10px">界面正在加载<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <div style="font-size:12px;color:#94a3b8">如长时间停留在此页，请重启程序；仍无法进入请检查本机网络与安全软件设置</div>
</div></body></html>`

let win = null
let isQuitting = false
let hideHintShown = false
let loadSeq = 0
let retryTimer = null
let fallbackShown = false
let loadFailCount = 0

// 渲染进程的 console 只转发 error。warning 多是 axios/组件库的例行噪音；
// 而且一次网络故障同一条错误会在渲染层和 backend.js 各出现一次，全量转发等于把日志放大一倍。
// 相同文案 5 分钟内只落一条：断网期间 axios 会每隔几秒重试并重复报同一个错，不节流会撑爆当天日志。
const DIAG_LEVEL = { error: 'error' }
const DIAG_THROTTLE_MS = 5 * 60_000
const diagLastAt = new Map()

function attachDiagnostics(target) {
  const wc = target.webContents
  wc.on('console-message', (e) => {
    if (!DIAG_LEVEL[e.level]) return
    const now = Date.now()
    const last = diagLastAt.get(e.message) || 0
    if (now - last < DIAG_THROTTLE_MS) return
    if (diagLastAt.size > 200) diagLastAt.clear()
    diagLastAt.set(e.message, now)
    log(DIAG_LEVEL[e.level], `${e.message} (${e.sourceId || ''}:${e.lineNumber ?? 0})`, 'renderer')
  })
  wc.on('render-process-gone', (_e, details) => {
    // 退出流程里 Electron 会主动 kill 渲染进程（reason=killed code=15），那不是崩溃
    if (isQuitting || details.reason === 'clean-exit') return
    error(`渲染进程异常退出 reason=${details.reason} code=${details.exitCode}`, 'renderer')
  })
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

// 显示兜底页：任何加载失败/超时都不允许白屏
function showFallbackPage() {
  loadSeq++ // 使仍在挂起中的真实页面加载失效
  fallbackShown = true
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FALLBACK_HTML)}`).catch(() => {})
  win.show()
}

function handleLoadFailure(seq, reason) {
  if (seq !== loadSeq || !win || win.isDestroyed()) return
  loadFailCount++
  // 首次与后续每 10 次记一条，避免重试刷屏
  if (loadFailCount === 1 || loadFailCount % 10 === 0) {
    error(`渲染页面${reason}（第 ${loadFailCount} 次），已显示兜底页并自动重试`, 'app')
  }
  showFallbackPage()
  retryTimer = setTimeout(loadRenderer, LOAD_RETRY_MS)
}

async function loadRenderer() {
  if (!win || win.isDestroyed()) return
  clearTimeout(retryTimer)
  const seq = ++loadSeq
  const wasFallback = fallbackShown
  fallbackShown = false
  let settled = false
  // 看门狗：加载"挂起"不触发 did-fail-load（断网时模块请求卡死即此形态），必须靠超时兜底
  const watchdog = setTimeout(() => {
    if (settled) return
    settled = true
    handleLoadFailure(seq, '加载超时')
  }, LOAD_TIMEOUT_MS)
  try {
    if (DEV_URL) await win.loadURL(DEV_URL)
    else await win.loadFile(RENDERER_FILE)
    if (settled) return
    settled = true
    clearTimeout(watchdog)
    if (seq !== loadSeq) return
    loadFailCount = 0
    win.show()
    if (wasFallback) info('渲染页面已恢复加载', 'app')
    // 开发/测试包默认打开调试台，方便直接看 Network
    if (!app.isPackaged || APP_ENV !== 'prod') win.webContents.openDevTools({ mode: 'detach' })
  } catch (e) {
    if (settled) return
    settled = true
    clearTimeout(watchdog)
    handleLoadFailure(seq, `加载失败：${e.message}`)
  }
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

function withTimeout(promise, ms, reason) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms)
    })
  ]).finally(() => clearTimeout(timer))
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

  // 真实页面加载成功后 loadRenderer 内部会按需打开调试台；
  // 失败/超时由兜底页 + 自动重试接管，任何情况下不白屏
  loadRenderer()
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
  const logDir = initLogger({ days: cfg.logKeepDays, level: cfg.logLevel })
  setupCrashGuard()
  // 上次是崩溃/断电退出时，立刻把当天日志补传上去，后端才拿得到崩溃前后的现场记录。
  // 所有 HTTP 都经渲染进程发出，界面还没加载完就发必然失败，所以等窗口起来再触发；
  // 真没传成也会进 1/5/15 分钟的重试队列，不会丢
  if (markRunning()) setTimeout(() => void flushLogs(), CRASH_FLUSH_DELAY_MS)

  setupNetworkRelax()

  subscribe((entry) => broadcast('log:entry', entry))
  onPollState((state) => broadcast('poll:state', state))
  onUpdateState((state) => broadcast('update:state', state))

  registerIpc({
    onConfigSaved: async (next) => {
      initLogger({ days: next.logKeepDays, level: next.logLevel })
      writeAutoStart(next.autoLaunch)
      await resumePoller()
      // 换密钥/换地址后，此前被平台拒收的日志重新尝试一次
      await startLogUpload({ resetTerminal: true })
    }
  })

  // 账本要在代理启动前就打开：日志上传靠它判断哪些文件已经传过，而代理默认不自启
  await initLedger()

  setupJumpList()
  createWindow()
  createTray({ showWindow: showMainWindow, quit: quitApp })
  setupDevToolsShortcut()
  setupUpdater()

  info(`${app.name} ${app.getVersion()} 启动，env=${APP_ENV}，日志目录 ${logDir}`, 'app')
  if (app.isPackaged) writeAutoStart(cfg.autoLaunch)
  // 代理默认不自启，需用户在首页点「启动」
  await startLogUpload()
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

  function teardown() {
    stopUpdater()
    closeLedger()
    destroyTray()
    closeLogger()
  }

  /**
   * 退出收尾：先把当天日志补传一次再退出。
   * before-quit 是同步事件、等不了异步上传，所以第一次进来 preventDefault，
   * 传完（或超时）后清掉运行标记并重新 app.quit()；第二次进来直接放行。
   * 运行标记必须在这里删：留着的话下次启动会误判成崩溃。
   */
  let quitSettled = false
  app.on('before-quit', (e) => {
    isQuitting = true
    // 先打标记：紧接着 Electron 就会开始 kill 子进程，那些 gone 事件不能被记成崩溃
    beginShutdown()
    if (quitSettled) return
    quitSettled = true
    e.preventDefault()
    stopPoller()
    stopLogUpload()
    withTimeout(flushLogs(), QUIT_FLUSH_TIMEOUT_MS, '退出前上传日志超时')
      .catch((err) => warn(`退出前上传日志未完成：${err.message}`, 'upload'))
      .finally(() => {
        markCleanExit()
        teardown()
        app.quit()
      })
  })
}
