import { computed, reactive } from 'vue'
import { BUSINESS_TYPES, DIR_FIELDS } from '../shared/biz-types.js'
import { config, go } from './store.js'

// 各业务启停仅前端状态；真正的轮询/收发逻辑后续接到主进程
const state = reactive({})

for (const t of BUSINESS_TYPES) {
  state[t.id] = { running: false, startedAt: null, stopping: false }
}

export const bizRun = state

export const runningCount = computed(() => BUSINESS_TYPES.filter((t) => state[t.id]?.running).length)

export function isRunning(typeId) {
  return !!state[typeId]?.running
}

export function missingDirs(typeId) {
  const entry = config.value?.bizDirs?.[typeId]
  if (!entry) return DIR_FIELDS.map((d) => d.label)
  return DIR_FIELDS.filter((d) => !String(entry[d.key] || '').trim()).map((d) => d.label)
}

export async function startBiz(typeId) {
  // 后端接口尚未接入：启动前只校验四个目录是否都已配置（是否可读写留给正式联调）
  const miss = missingDirs(typeId)
  if (miss.length) {
    return { ok: false, reason: `无法启动：该业务还有 ${miss.length} 个目录未配置（${miss.join('、')}），请先到「目录配置」补齐。` }
  }
  state[typeId].running = true
  state[typeId].startedAt = Date.now()
  return { ok: true }
}

export function stopBiz(typeId) {
  state[typeId].running = false
  state[typeId].startedAt = null
  return { ok: true }
}

export function gotoDir(typeId) {
  go('dir')
  // DirView 自身会展开已配置业务；这里只负责跳转
  return typeId
}
