import { computed } from 'vue'
import { config } from './store.js'
import { isRunning } from './biz-run.js'
import { ALL_BIZ_TYPES } from '../shared/biz-types.js'

// 首页与目录配置共用的模块页签：状态直接挂在页签上，未激活的页签也能看到是否在运行
export const MODULE_TABS = computed(() => {
  const swRunning = ALL_BIZ_TYPES.some((t) => !t.channelBased && isRunning(t.id))
  const cebRunning = isRunning('ceb')
  const allChannels = (config.value?.cebChannels || []).filter(Boolean)
  const activeChannels = allChannels.filter((c) => c.enabled !== false)
  const channelCount = `${activeChannels.length}/${allChannels.length}`

  return [
    {
      value: 'sw',
      label: '单一窗口',
      tag: { text: swRunning ? '已启动' : '未启动任何业务', tone: swRunning ? 'on' : 'off' }
    },
    {
      value: 'ceb',
      label: '渠道入口',
      tag: {
        text: `${cebRunning ? '已启动渠道业务' : '未启动任何渠道业务'}（${channelCount}）`,
        tone: cebRunning ? 'on' : 'off'
      },
      title: allChannels.length
        ? `已启用 ${activeChannels.length}/${allChannels.length} 个渠道：${activeChannels.map((c) => c.name || '未命名').join('、') || '无'}`
        : '尚未配置任何渠道'
    }
  ]
})
