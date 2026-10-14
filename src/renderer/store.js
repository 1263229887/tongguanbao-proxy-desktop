import { ref } from 'vue'

export const PHASE_TEXT = {
  idle: '空闲',
  running: '执行中',
  blocked: '配置不完整',
  failed: '失败'
}

export const view = ref('home')
export const meta = ref(null)
export const config = ref(null)
export const pollState = ref({
  polling: false,
  running: false,
  enabled: false,
  connected: null,
  processed: 0,
  delivered: 0,
  receipts: 0,
  lastTickAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  tickCount: 0,
  instanceName: '',
  platformMode: null
})
export const logs = ref([])
export const logFiles = ref([])
export const logDir = ref('')
export const autoStart = ref({ openAtLogin: false, willLaunch: false, managed: false })
export const updateState = ref({
  status: 'idle',
  version: null,
  downloadSize: null,
  percent: 0,
  note: null,
  error: null,
  checkedAt: null
})

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
  autoStart.value = await window.intake.getAutoStart()
  updateState.value = await window.intake.getUpdateState()
  await refreshLogs()

  window.intake.onPollState((next) => (pollState.value = next))
  window.intake.onUpdateState((next) => (updateState.value = next))
  window.intake.onLogEntry((entry) => {
    logs.value = [...logs.value, entry].slice(-500)
  })
}

export async function saveConfig(patch) {
  // 去掉 Vue 响应式 Proxy，避免 Electron IPC structured clone 失败
  const plain = JSON.parse(JSON.stringify(patch ?? {}))
  config.value = await window.intake.saveConfig(plain)
  autoStart.value = await window.intake.getAutoStart()
  return config.value
}

export { refreshLogs }
