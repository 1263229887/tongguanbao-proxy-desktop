import { BrowserWindow, ipcMain } from 'electron'

// 所有 HTTP 都从渲染进程发出（axios），DevTools Network 可直接查看。
// 主进程只负责调度与落盘，通过本桥接把请求交给渲染进程执行。
// 例行请求不落日志；失败由 backend.post 统一告警，避免每 10/30 秒的轮询刷屏。

const TIMEOUT_MS = 20_000
const pending = new Map()
let seq = 0

function targetWindow() {
  const wins = BrowserWindow.getAllWindows()
  return wins.find((w) => !w.isDestroyed()) || null
}

export function isRendererReady() {
  const win = targetWindow()
  return !!(win && !win.webContents.isLoading() && !win.webContents.isDestroyed())
}

export function requestViaRenderer({ url, method = 'POST', headers = {}, body, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const win = targetWindow()
    if (!win || win.webContents.isDestroyed()) {
      reject(new Error('界面进程未就绪，无法发起网络请求'))
      return
    }
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`请求超时（${timeoutMs}ms）：${url}`))
    }, timeoutMs)

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })

    const payload = {
      id,
      url,
      method,
      headers,
      body: body === undefined ? null : body,
      timeoutMs
    }
    win.webContents.send('net:do-request', payload)
  })
}

export function setupNetBridge() {
  ipcMain.on('net:request-result', (_e, result) => {
    if (!result || result.id == null) return
    const entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id)
    if (result.ok) {
      entry.resolve({
        status: result.status,
        statusText: result.statusText || '',
        data: result.data,
        headers: result.headers || {}
      })
    } else {
      entry.reject(Object.assign(new Error(result.error || '网络请求失败'), { code: result.code }))
    }
  })
}
