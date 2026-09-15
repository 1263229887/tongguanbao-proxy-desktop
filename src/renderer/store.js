import { ref } from 'vue'

export const PHASE_TEXT = {
  idle: '空闲',
  running: '执行中',
  blocked: '配置不完整',
  failed: '失败'
}

export const UPDATE_TEXT = {
  idle: '尚未检查',
  checking: '检查中…',
  'up-to-date': '已是最新版本',
  downloading: '正在下载',
  ready: '新版本已就绪',
  installing: '正在安装',
  error: '更新失败',
  disabled: '开发环境不检查更新'
}

export const view = ref('home')
export const meta = ref(null)
export const config = ref(null)
export const pollState = ref({ polling: false, running: false, lastTickAt: null, lastError: null, tickCount: 0 })
export const logs = ref([])
export const logFiles = ref([])
export const logDir = ref('')
export const update = ref({ status: 'idle', version: null, note: null })
export const autoStart = ref({ openAtLogin: false, willLaunch: false, managed: false })

export function go(next) {
  view.value = next
}

export function formatTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

const pad = (n) => String(n).padStart(2, '0')

export function formatClock(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatShort(ts) {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${formatClock(ts)}`
}

export function formatSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

async function refreshLogs() {
  logs.value = await window.intake.getLogs()
  logFiles.value = await window.intake.getLogFiles()
  logDir.value = await window.intake.getLogDir()
}

export async function initStore() {
  meta.value = await window.intake.getMeta()
  config.value = await window.intake.getConfig()
  pollState.value = await window.intake.getPollState()
  update.value = await window.intake.getUpdateState()
  autoStart.value = await window.intake.getAutoStart()
  await refreshLogs()

  window.intake.onPollState((next) => (pollState.value = next))
  window.intake.onUpdateState((next) => (update.value = next))
  window.intake.onLogEntry((entry) => {
    logs.value = [...logs.value, entry].slice(-500)
  })
}

export async function saveConfig(patch) {
  config.value = await window.intake.saveConfig(patch)
  autoStart.value = await window.intake.getAutoStart()
  return config.value
}

export { refreshLogs }
