import { computed, reactive } from 'vue'
import { BUSINESS_TYPES, DIR_FIELDS } from '../shared/biz-types.js'
import { config, go } from './store.js'

// 各业务启停：货物申报接到主进程真实代理；其余业务暂未对接后台
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
  if (typeId !== 'goods') {
    return { ok: false, reason: '当前真实对接仅支持「货物申报 / 报关单暂存」(DECCUS001)，其他业务请先配置目录等待后续版本。' }
  }

  const miss = missingDirs(typeId)
  if (miss.length) {
    return { ok: false, reason: `无法启动：该业务还有 ${miss.length} 个目录未配置（${miss.join('、')}），请先到「目录配置」补齐。` }
  }

  try {
    const res = await window.intake.startAgent()
    if (res?.lastError && !res.running) {
      return { ok: false, reason: res.lastError }
    }
    state[typeId].running = true
    state[typeId].startedAt = Date.now()
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) }
  }
}

export function stopBiz(typeId) {
  if (typeId === 'goods') {
    window.intake.stopAgent?.()
  }
  state[typeId].running = false
  state[typeId].startedAt = null
  return { ok: true }
}

export function gotoDir(typeId) {
  go('dir')
  return typeId
}
