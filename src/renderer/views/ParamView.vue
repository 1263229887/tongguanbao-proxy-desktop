<script setup>
import { ref, watch } from 'vue'
import { autoStart, config, logDir, refreshLogs, saveConfig } from '../store.js'

const form = ref(null)
const saved = ref(false)
const uploading = ref(false)

const openLogDir = () => window.intake.openLogDir()

async function uploadNow() {
  uploading.value = true
  try {
    await window.intake.uploadLogsNow()
    await refreshLogs()
  } finally {
    uploading.value = false
  }
}

watch(
  config,
  (val) => {
    if (val && !form.value) form.value = JSON.parse(JSON.stringify(val))
  },
  { immediate: true }
)

async function submit() {
  saved.value = false
  await saveConfig(form.value)
  saved.value = true
}
</script>

<template>
  <div v-if="form" class="h-full overflow-y-auto p-5">
    <div class="panel p-5 max-w-[720px] flex flex-col gap-4">
      <div class="text-sm font-semibold">启动与常驻</div>

      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input v-model="form.autoLaunch" type="checkbox" class="w-3.5 h-3.5 accent-[#2f6fed]" />
        <span class="text-sm">开机自动启动</span>
      </label>

      <div class="text-xs text-slate-500 leading-relaxed -mt-2">
        关闭主窗口后程序仍在后台轮询，需在任务栏或托盘图标上右键「退出」才会彻底结束。
        <template v-if="autoStart.managed">当前系统启动项：{{ autoStart.willLaunch ? '已注册' : '未注册' }}</template>
        <span v-else class="text-slate-400">（开发模式不写入系统启动项，打包后生效）</span>
      </div>

      <div class="border-t border-slate-100 pt-4 text-sm font-semibold">轮询处理</div>

      <div>
        <div class="label-text mb-1">轮询时间间隔（秒）</div>
        <input v-model.number="form.pollIntervalSeconds" type="number" min="1" max="86400" class="field w-40" />
        <div class="mt-1 text-xs text-slate-400">到点后向后台拉取待处理任务，取值 1 - 86400 秒</div>
      </div>

      <div class="border-t border-slate-100 pt-4 text-sm font-semibold">日志</div>

      <div>
        <div class="label-text mb-1">本机日志保留天数</div>
        <input v-model.number="form.logKeepDays" type="number" min="1" max="3650" class="field w-28" />
      </div>

      <div class="flex items-center gap-2">
        <button class="btn-ghost" @click="openLogDir">打开目录</button>
        <button class="btn-ghost" :disabled="uploading" @click="uploadNow">{{ uploading ? '上传中…' : '立即上传' }}</button>
        <span v-if="logDir" class="text-xs text-slate-400 truncate min-w-0">{{ logDir }}</span>
      </div>

      <div class="border-t border-slate-100 pt-4 flex items-center justify-end gap-3">
        <button class="btn-primary" @click="submit">保存</button>
        <span v-if="saved" class="text-xs text-emerald-600">已保存并生效</span>
      </div>
    </div>
  </div>
</template>
