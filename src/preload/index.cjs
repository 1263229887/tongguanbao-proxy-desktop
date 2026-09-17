const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

function listen(channel) {
  return (handler) => {
    const wrapper = (_e, payload) => handler(payload)
    ipcRenderer.on(channel, wrapper)
    return () => ipcRenderer.removeListener(channel, wrapper)
  }
}

contextBridge.exposeInMainWorld('intake', {
  getConfig: () => invoke('config:get'),
  saveConfig: (patch) => invoke('config:set', patch),
  checkDir: (args) => invoke('config:checkDir', args),
  pickDir: (defaultPath) => invoke('dialog:pickDir', defaultPath),
  importSwDirs: (args) => invoke('sw:importDirs', args),
  testAccess: () => invoke('access:test'),
  getAutoStart: () => invoke('autostart:get'),

  startPoll: () => invoke('poll:start'),
  stopPoll: () => invoke('poll:stop'),
  runPoll: () => invoke('poll:run'),
  getPollState: () => invoke('poll:state'),
  startAgent: () => invoke('agent:start'),
  stopAgent: () => invoke('agent:stop'),

  getLogs: () => invoke('logs:get'),
  clearLogs: () => invoke('logs:clear'),
  getLogFiles: () => invoke('logs:files'),
  readLogFile: (args) => invoke('logs:read', args),
  getLogDir: () => invoke('logs:dir'),
  openLogDir: () => invoke('logs:open'),
  uploadLogsNow: () => invoke('logs:upload-now'),

  openDevTools: () => invoke('devtools:open'),

  getMeta: () => invoke('app:meta'),
  checkUpdate: () => invoke('update:check'),
  getUpdateState: () => invoke('update:state'),
  installUpdate: () => invoke('update:install'),

  // 主进程 → 渲染进程：发起 HTTP
  onNetRequest: listen('net:do-request'),
  sendNetResult: (result) => ipcRenderer.send('net:request-result', result),

  onLogEntry: listen('log:entry'),
  onPollState: listen('poll:state'),
  onUpdateState: listen('update:state')
})
