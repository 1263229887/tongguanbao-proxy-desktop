import { computed, reactive } from 'vue'
import { BUSINESS_TYPES, DIR_FIELDS } from '../shared/biz-types.js'
import { config, go } from './store.js'

// 各业务启停：货物申报（DEC）与跨境电商（CEB）各接一套主进程引擎；其余业务暂未对接后台
const state = reactive({})

for (const t of BUSINESS_TYPES) {
  state[t.id] = { running: false, startedAt: null, stopping: false }
}

export const bizRun = state

export const runningCount = computed(() => BUSINESS_TYPES.filter((t) => state[t.id]?.running).length)

export function isRunning(typeId) {
  return !!state[typeId]?.running
}

// 已真实对接的业务 → 主进程启停接口。新增引擎时在这里登记即可
const RUNTIME = {
  goods: { start: () => window.intake.startAgent(), stop: () => window.intake.stopAgent?.() },
  ceb: { start: () => window.intake.startCeb(), stop: () => window.intake.stopCeb?.() }
}

export function missingDirs(typeId) {
  const type = BUSINESS_TYPES.find((t) => t.id === typeId)
  // 渠道型业务没有 bizDirs 组：以「启用渠道」为单位检查收发目录是否配齐
  if (type?.channelBased) {
    const active = (config.value?.cebChannels || []).filter((c) => c && c.enabled !== false)
    if (!active.length) return ['渠道（至少添加并启用一个）']
    const miss = []
    if (!active.some((c) => String(c.sendDir || '').trim())) miss.push('渠道发送目录')
    if (!active.some((c) => String(c.receiveDir || '').trim())) miss.push('渠道接收目录')
    return miss
  }
  const entry = config.value?.bizDirs?.[typeId]
  if (!entry) return DIR_FIELDS.map((d) => d.label)
  return DIR_FIELDS.filter((d) => !String(entry[d.key] || '').trim()).map((d) => d.label)
}

export async function startBiz(typeId) {
  const rt = RUNTIME[typeId]
  if (!rt) {
    return { ok: false, reason: '当前真实对接仅支持「货物申报」与「跨境电商申报」，其他业务请先配置目录等待后续版本。' }
  }

  const miss = missingDirs(typeId)
  if (miss.length) {
    return { ok: false, reason: `无法启动：该业务还有 ${miss.length} 项未配置（${miss.join('、')}），请先到「目录配置」补齐。` }
  }

  try {
    const res = await rt.start()
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
  RUNTIME[typeId]?.stop()
  state[typeId].running = false
  state[typeId].startedAt = null
  return { ok: true }
}

export function gotoDir(typeId) {
  go('dir')
  return typeId
}