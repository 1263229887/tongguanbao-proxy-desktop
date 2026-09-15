<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import StatusTile from '../components/StatusTile.vue'
import { go, meta, pollState } from '../store.js'

const GUIDE = [
  { view: 'access', label: '权限配置', desc: '填写后台按租户下发的 APP KEY，这是本机访问后台数据的唯一凭证。保存后可点「测试访问」确认能否连通。' },
  { view: 'dir', label: '目录配置', desc: '选择报关单暂存要用的四个文件夹，并设置本机同时处理的最大任务数。不设置的话，拉取到的文件没有落地位置。', legend: true },
  { view: 'param', label: '参数配置', desc: '设置轮询时间间隔（秒）、开机自动启动，以及本机日志保留天数。' },
  { view: 'about', label: '保持运行与更新', desc: '关掉主窗口后程序仍在后台继续轮询，要彻底结束需在托盘图标上右键「退出」。版本升级在「关于」里检查。' }
]

const DIR_LEGEND = [
  { name: 'OutBox', desc: '待发送数据的文件夹' },
  { name: 'SentBox', desc: '发送完毕数据的文件夹' },
  { name: 'InBox', desc: '接收回执 / 校验失败说明的文件夹' },
  { name: 'FailBox', desc: '校验失败数据的文件夹' }
]

const now = ref(Date.now())
let clock = null
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => clearInterval(clock))

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = pad(Math.floor((total % 3600) / 60))
  const s = pad(total % 60)
  return h >= 24 ? `${Math.floor(h / 24)} 天 ${pad(h % 24)}:${m}:${s}` : `${pad(h)}:${m}:${s}`
}

const uptime = computed(() => formatUptime(now.value - (meta.value?.startedAt ?? now.value)))

const CONNECTED = {
  yes: { value: '已联通', tone: 'good' },
  no: { value: '未联通', tone: 'bad' },
  probe: { value: '尚未探测', tone: 'default' }
}
const connectedState = computed(() => {
  const c = pollState.value.connected
  return c === null ? CONNECTED.probe : c ? CONNECTED.yes : CONNECTED.no
})
</script>

<template>
  <div class="h-full overflow-y-auto p-5 flex flex-col">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
      <StatusTile label="轮询中" :value="pollState.polling ? '运行中' : '已停止'" :tone="pollState.polling ? 'good' : 'warn'" />
      <StatusTile
        label="与服务器是否已联通"
        :value="connectedState.value"
        :tone="connectedState.tone"
        :hint="connectedState.tone === 'bad' ? pollState.lastError : ''"
      />
      <StatusTile label="启动后运行时长" :value="uptime" hint="自本次程序启动计时" />
      <StatusTile label="已处理报文数量" :value="String(pollState.processed ?? 0)" hint="自本次程序启动累计" />
    </div>

    <div class="panel flex-1 min-h-0 w-full mt-3 flex flex-col">
      <div class="h-10 shrink-0 flex items-center px-4 border-b border-slate-100">
        <span class="text-sm font-semibold">操作指引</span>
      </div>
      <div class="flex-1 min-h-0 scroll-y px-4 py-5 flex flex-col divide-y divide-slate-100">
        <div v-for="(item, i) in GUIDE" :key="item.view" class="group flex gap-3 py-5 first:pt-0 last:pb-0 cursor-pointer" @click="go(item.view)">
          <span class="w-5 h-5 shrink-0 rounded-full bg-brand-50 text-brand-600 text-xs font-medium flex items-center justify-center">{{ i + 1 }}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-700 group-hover:text-brand-600 transition-colors">{{ item.label }}</span>
              <span class="ml-auto text-xs text-slate-400 shrink-0 group-hover:text-brand-600 transition-colors">去配置 ›</span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-slate-500">{{ item.desc }}</p>
            <div v-if="item.legend" class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
              <div v-for="d in DIR_LEGEND" :key="d.name" class="text-xs text-slate-500 truncate">
                <span class="text-slate-700">{{ d.name }}</span> {{ d.desc }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
