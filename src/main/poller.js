// 兼容旧 poll 接口：实际代理逻辑在 agent.js
export {
  getAgentState as getState,
  startAgent as start,
  stopAgent as stop,
  resumeAgent as resume,
  runAgentOnce as runNow,
  onStateChange
} from './agent.js'
