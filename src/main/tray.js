import path from 'node:path'
import { Menu, Tray, app, nativeImage } from 'electron'

let tray = null

export function createTray({ showWindow, quit }) {
  if (tray) return tray

  const icon = nativeImage.createFromPath(path.join(import.meta.dirname, 'assets/tray.png'))
  tray = new Tray(icon)
  tray.setToolTip(`${app.name} · 后台运行中`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: quit }
    ])
  )
  tray.on('click', showWindow)
  return tray
}

export function destroyTray() {
  tray?.destroy()
  tray = null
}
