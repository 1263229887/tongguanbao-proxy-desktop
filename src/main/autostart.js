import { app } from 'electron'

// Windows 下写入当前用户的「启动」Run 项；未打包时不碰系统设置，只保留配置意图。
export function read() {
  const s = app.getLoginItemSettings()
  return {
    openAtLogin: s.openAtLogin,
    willLaunch: process.platform === 'win32' ? s.executableWillLaunchAtLogin : s.openAtLogin,
    managed: app.isPackaged
  }
}

export function write(enabled) {
  if (!app.isPackaged) return read()
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: [] })
  return read()
}
