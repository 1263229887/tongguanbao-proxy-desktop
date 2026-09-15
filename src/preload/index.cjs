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
  testAccess: () => invoke('access:test'),
  getAutoStart: () => invoke('autostart:get'),

  startPoll: () => invoke('poll:start'),
  stopPoll: () => invoke('poll:stop'),
  runPoll: () => invoke('poll:run'),
  getPollState: () => invoke('poll:state'),

  getLogs: () => invoke('logs:get'),
  clearLogs: () => invoke('logs:clear'),
  getLogFiles: () => invoke('logs:files'),
  readLogFile: (args) => invoke('logs:read', args),
  getLogDir: () => invoke('logs:dir'),
  openLogDir: () => invoke('logs:open'),
  uploadLogsNow: () => invoke('logs:upload-now'),

  getMeta: () => invoke('app:meta'),
  checkUpdate: () => invoke('update:check'),
  getUpdateState: () => invoke('update:state'),
  installUpdate: () => invoke('update:install'),

  onLogEntry: listen('log:entry'),
  onPollState: listen('poll:state'),
  onUpdateState: listen('update:state')
})
