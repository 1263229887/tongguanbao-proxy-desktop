import { missingAccess, request } from './backend.js'
import { loadConfig } from './config.js'
import { info, warn } from './logger.js'

let timer = null
let running = false
// 用户启停意图：手动停止后，保存配置引起的内部重启不能再把轮询偷偷拉起
let enabled = true
let broadcast = () => {}

const state = {
  polling: false,
  connected: null,
  processed: 0,
  lastTickAt: null,
  lastError: null,
  tickCount: 0
}

function patch(values) {
  Object.assign(state, values)
  const snapshot = { ...state, running }
  broadcast(snapshot)
  return snapshot
}

export function onStateChange(fn) {
  broadcast = fn
}

export function getState() {
  return { ...state, running }
}

async function tick() {
  if (running) return patch({ lastError: '上一轮尚未结束' })

  const cfg = await loadConfig()
  const miss = missingAccess(cfg)
  if (miss.length) return patch({ lastError: `缺少 ${miss.join('、')}` })

  running = true
  const at = Date.now()
  info('轮询后台待处理任务', 'poll')
  try {
    // TODO 拉到任务后按 dirs.outBox 落地并累加 state.processed；接口与文件命名规则待后台确认，
    //      同时处理数受 maxConcurrentTasks 限制
    const res = await request(cfg, '/api/task/pending', { method: 'POST', body: '{}' })
    if (!res.ok) {
      return patch({ connected: false, lastTickAt: at, lastError: `HTTP ${res.status} ${res.statusText}`, tickCount: state.tickCount + 1 })
    }
    info('本轮轮询完成', 'poll')
    return patch({ connected: true, lastTickAt: at, lastError: null, tickCount: state.tickCount + 1 })
  } catch (e) {
    return patch({ connected: false, lastTickAt: at, lastError: e.message })
  } finally {
    running = false
    broadcast({ ...state, running: false })
  }
}

function clearTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

export async function start() {
  const cfg = await loadConfig()
  clearTimer()
  enabled = true
  if (!cfg.pollIntervalSeconds) {
    warn('轮询间隔无效，定时轮询未启动', 'poll')
    return patch({ polling: false })
  }
  timer = setInterval(tick, cfg.pollIntervalSeconds * 1000)
  info(`轮询已启动，间隔 ${cfg.pollIntervalSeconds}s`, 'poll')
  return patch({ polling: true, lastError: null })
}

export function stop() {
  enabled = false
  clearTimer()
  info('轮询已停止', 'poll')
  return patch({ polling: false })
}

// 保存配置后重排定时器：间隔可能改了，但用户的启停意图保持不变
export async function resume() {
  if (!enabled) {
    clearTimer()
    return patch({ polling: false })
  }
  return start()
}

export async function runNow() {
  await tick()
  return getState()
}
