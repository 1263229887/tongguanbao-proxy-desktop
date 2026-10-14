<script setup>
import { ref, watch } from 'vue'
import { autoStart, config, logDir, meta, refreshLogs, saveConfig } from '../store.js'

const form = ref(null)
const saved = ref(false)
const uploading = ref(false)
const uploadNote = ref(null)
const openingDevTools = ref(false)

const openLogDir = () => window.intake.openLogDir()
const canEditServer = () => meta.value?.env !== 'prod'

async function openDevTools() {
  openingDevTools.value = true
  try {
    await window.intake.openDevTools()
  } finally {
    openingDevTools.value = false
  }
}

async function uploadNow() {
  // 以已保存的配置为准：界面上的勾选还没保存时，主进程用的仍是旧值
  if (config.value?.logUpload?.enabled === false) {
    uploadNote.value = { error: true, text: '日志上传已关闭，先勾选下面的开关并保存' }
    return
  }
  uploading.value = true
  uploadNote.value = null
  try {
    const res = await window.intake.uploadLogsNow()
    if (res?.failed) {
      uploadNote.value = { error: true, text: `有 ${res.failed} 个日志文件上传失败，原因见运行日志` }
      ElMessage.error(`有 ${res.failed} 个日志文件上传失败，详情见运行日志`)
    } else if (res?.uploaded) {
      uploadNote.value = { text: `已成功上传 ${res.uploaded} 个日志文件` }
      ElMessage.success(`已成功上传 ${res.uploaded} 个日志文件`)
    } else if (res?.blocked) {
      uploadNote.value = { text: '平台暂未开启日志接收，本机日志照常保留' }
      ElMessage.warning('平台暂未开启日志接收，本机日志照常保留')
    } else {
      uploadNote.value = { text: '本机暂无可上传的日志' }
      ElMessage.info('本机暂无可上传的日志')
    }
  } catch (e) {
    uploadNote.value = { error: true, text: `上传失败：${e?.message || e}` }
    ElMessage.error(`上传失败：${e?.message || e}`)
  } finally {
    uploading.value = false
    await refreshLogs()
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
        关闭主窗口后程序仍在后台代理，需在任务栏或托盘图标上右键「退出」才会彻底结束。
        <template v-if="autoStart.managed">当前系统启动项：{{ autoStart.willLaunch ? '已注册' : '未注册' }}</template>
        <span v-else class="text-slate-400">（开发模式不写入系统启动项，打包后生效）</span>
      </div>

      <div class="border-t border-slate-100 pt-4 text-sm font-semibold">代理轮询</div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <div class="label-text mb-1">拉取任务间隔（秒）</div>
          <input v-model.number="form.pollIntervalSeconds" type="number" min="1" max="86400" class="field w-full" />
        </div>
        <div>
          <div class="label-text mb-1">回执扫描间隔（秒）</div>
          <input v-model.number="form.inboxIntervalSeconds" type="number" min="1" max="3600" class="field w-full" />
        </div>
        <div>
          <div class="label-text mb-1">心跳间隔（秒）</div>
          <input v-model.number="form.heartbeatIntervalSeconds" type="number" min="10" max="300" class="field w-full" />
        </div>
      </div>
      <div class="text-xs text-slate-400 -mt-2">建议心跳 30～60 秒；平台约 3 分钟未收到心跳会告警。</div>

      <div class="border-t border-slate-100 pt-4 text-sm font-semibold">日志与调试</div>

      <div>
        <div class="label-text mb-1">本机日志保留天数</div>
        <input v-model.number="form.logKeepDays" type="number" min="1" max="3650" class="field w-28" />
      </div>
      <div class="text-xs text-slate-400 -mt-2">
        日志只记录任务编号、文件名、校验值、状态与错误摘要，不会写出密钥或报关单内容；详细程度自动调节，无需手动设置。
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input v-model="form.logUpload.enabled" type="checkbox" class="w-3.5 h-3.5 accent-[#2f6fed]" />
          <span class="text-sm">把运行日志上传到通关宝平台</span>
        </label>
        <button class="btn-ghost" :disabled="uploading" @click="uploadNow">{{ uploading ? '上传中…' : '立即上传日志' }}</button>
      </div>
      <div class="text-xs text-slate-500 leading-relaxed -mt-2">
        现场出问题时，平台运维不登录这台电脑也能查日志。除手动「立即上传」外：每天自动上传前一天的日志；
        检测到鉴权失败、回执长期未到、程序异常退出等情形时自动上传当天日志；断网期间没传上去的，恢复后自动补传。
      </div>
      <div v-if="uploadNote" class="text-xs -mt-2" :class="uploadNote.error ? 'text-rose-600' : 'text-emerald-600'">
        {{ uploadNote.text }}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-ghost" @click="openLogDir">打开日志目录</button>
        <button v-if="canEditServer()" class="btn-ghost" :disabled="openingDevTools" @click="openDevTools">打开调试控制台</button>
      </div>
      <div class="text-xs text-slate-400 -mt-2">
        目录：<span class="break-all">{{ logDir }}</span
        >；调试台 Network 可查看全部请求的入参与返回，生产环境也能用 Ctrl+Shift+I 打开。
      </div>

      <div class="border-t border-slate-100 pt-4 flex items-center justify-end gap-3">
        <button class="btn-primary" @click="submit">保存</button>
        <span v-if="saved" class="text-xs text-emerald-600">已保存并生效</span>
      </div>
    </div>
  </div>
</template>
