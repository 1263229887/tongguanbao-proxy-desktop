// 前置机电源保活与睡眠感知。
// 睡眠/休眠 = 整个用户态冻结 + 网卡断电：无论请求从主进程还是渲染进程发出都会中断，
// 这不是代码层 bug，只能阻止系统「自动」睡眠（Electron powerSaveBlocker，
// 底层即 Windows SetThreadExecutionState 的 ES_SYSTEM_REQUIRED）。
// 用户主动睡眠（开始菜单/电源键）与笔记本合盖动作应用层拦不住，需在系统电源计划里配置；
// 现场部署建议（管理员 PowerShell 执行一次）：
//   powercfg /change standby-timeout-ac 0        交流电源永不睡眠
//   powercfg /change hibernate-timeout-ac 0      交流电源永不休眠
//   笔记本另需把「合盖动作」设为不采取任何操作
import { powerMonitor, powerSaveBlocker } from 'electron'
import { info, warn } from './logger.js'

let suspendBlockerId = null
let displayBlockerId = null
let onResume = () => {}

/** 按配置动态启停「保持唤醒」（参数配置开关，保存即生效）：系统不睡，屏幕仍可自动关闭 */
export function applyKeepAwake(enabled) {
  const started = suspendBlockerId != null && powerSaveBlocker.isStarted(suspendBlockerId)
  if (enabled && !started) {
    suspendBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    info('保持唤醒已开启：系统不会自动睡眠/休眠（屏幕仍正常关闭省电；用户主动睡眠与合盖不受此控）', 'power')
  } else if (!enabled && started) {
    powerSaveBlocker.stop(suspendBlockerId)
    suspendBlockerId = null
    info('保持唤醒已关闭：系统将按自身电源计划自动睡眠', 'power')
  }
}

/** 「屏幕常亮」：prevent-display-sleep 优先级高于 prevent-app-suspension，
 * 开启期间屏幕与系统都保持唤醒（Electron 语义：display 档隐含系统唤醒） */
export function applyDisplayAwake(enabled) {
  const started = displayBlockerId != null && powerSaveBlocker.isStarted(displayBlockerId)
  if (enabled && !started) {
    displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    info('屏幕常亮已开启：屏幕与系统均保持唤醒（耗电略增）', 'power')
  } else if (!enabled && started) {
    powerSaveBlocker.stop(displayBlockerId)
    displayBlockerId = null
    info('屏幕常亮已关闭：屏幕按电源计划自动关闭（系统是否睡眠取决于「保持唤醒」开关）', 'power')
  }
}

/** resume 为唤醒后的立即动作（index.js 注入：跑一轮业务 + 日志上传），避免这里反向依赖业务模块 */
export function setupPowerKeepAlive({ resume, keepAwake = true, keepDisplayAwake = false } = {}) {
  if (typeof resume === 'function') onResume = resume
  applyKeepAwake(keepAwake !== false)
  applyDisplayAwake(keepDisplayAwake === true)

  // 睡眠/恢复写进日志，与网络中断/恢复翻转记录一起构成完整的故障/离线时间线：
  // 排障时看到「进入睡眠 → 恢复 → 网络中断 → 恢复」即知是主机睡眠，而非平台故障
  powerMonitor.on('suspend', () =>
    warn('系统进入睡眠/休眠，代理轮询、心跳与日志上传暂停；如需 24 小时在线请在参数配置开启「保持唤醒」并调整电源计划', 'power')
  )
  powerMonitor.on('resume', () => {
    info('系统已从睡眠/休眠中恢复，立即执行一轮业务与日志上传', 'power')
    try {
      onResume()
    } catch (e) {
      warn(`恢复后的立即轮次异常：${e.message}`, 'power')
    }
  })
}
