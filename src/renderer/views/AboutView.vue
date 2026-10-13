<script setup>
import { computed, ref } from 'vue'
import { meta, updateState, formatTime, formatSize } from '../store.js'

function val(x) {
  return x == null || x === '' ? '—' : String(x)
}

const rows = computed(() => [
  { k: '应用名称', v: val(meta.value?.name) },
  { k: '版本号', v: val(meta.value?.version) },
  { k: '运行平台', v: meta.value ? `${val(meta.value.platform)} / ${val(meta.value.arch)}` : '—' },
  { k: '安装形态', v: meta.value ? (meta.value.packaged ? '已打包安装' : '开发模式') : '—' }
])

const checking = ref(false)
const downloading = ref(false)
const installing = ref(false)
const installHint = ref('')

const statusLine = computed(() => {
  const s = updateState.value
  const sizeText = s.size ? `（${formatSize(s.size)}）` : ''
  switch (s.status) {
    case 'disabled':
      return meta.value?.packaged ? '在线更新未启用' : '开发模式不支持在线更新'
    case 'checking':
      return '正在检查更新…'
    case 'upToDate':
      return s.note || '当前已是最新版本'
    case 'updateAvailable':
      return `发现新版本 v${val(s.version)}${sizeText}，可下载后安装`
    case 'downloading':
      return `正在下载新版本 v${val(s.version)}（${s.percent ?? 0}%）…`
    case 'downloaded':
      return `新版本 v${val(s.version)} 已下载完成`
    case 'error':
      return `更新失败：${val(s.error)}`
    default:
      return '启动后自动检查（每 6 小时一次），发现新版本会在这里提示'
  }
})

const showProgress = computed(() => updateState.value.status === 'downloading')
const canDownload = computed(
  () => updateState.value.status === 'updateAvailable' || (updateState.value.status === 'error' && updateState.value.version)
)
const canInstall = computed(() => updateState.value.status === 'downloaded')

async function check() {
  checking.value = true
  try {
    await window.intake.checkUpdate()
  } finally {
    checking.value = false
  }
}

async function download() {
  downloading.value = true
  try {
    await window.intake.downloadUpdate()
  } finally {
    downloading.value = false
  }
}

async function install() {
  installing.value = true
  installHint.value = '正在等待代理任务收尾，随后自动退出并安装…'
  try {
    const res = await window.intake.installUpdate()
    if (res && res.ok === false) installHint.value = res.reason || '暂时无法安装'
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto p-5">
    <div class="panel p-5 max-w-[620px]">
      <div class="text-sm font-semibold mb-3">版本信息</div>
      <div v-for="row in rows" :key="row.k" class="flex gap-4 py-1.5 border-b border-slate-50 last:border-b-0 text-sm">
        <span class="w-24 shrink-0 text-slate-400">{{ row.k }}</span>
        <span class="text-slate-700 font-mono">{{ row.v }}</span>
      </div>
    </div>

    <div class="panel p-5 max-w-[620px] mt-3">
      <div class="text-sm font-semibold mb-2">在线更新</div>
      <template v-if="meta?.packaged">
        <p class="text-xs text-slate-500 leading-relaxed mb-3">
          程序自动检查新版本，是否下载与安装由你决定；安装前会先完成手头的代理任务，不会打断报关单处理。
        </p>
        <div class="flex items-center gap-2 text-sm" :class="updateState.status === 'error' ? 'text-rose-600' : 'text-slate-700'">
          <span>{{ statusLine }}</span>
        </div>
        <div v-if="showProgress" class="mt-2 h-1.5 w-full rounded bg-slate-100 overflow-hidden">
          <div class="h-full bg-brand-500 transition-all" :style="{ width: `${updateState.percent ?? 0}%` }" />
        </div>
        <p v-if="canInstall" class="mt-2 text-xs text-slate-500 leading-relaxed">
          安装会自动退出程序，完成后自动重新打开；本机配置与日志保留。
        </p>
        <p v-if="installHint" class="mt-2 text-xs text-amber-600">{{ installHint }}</p>
        <div class="mt-3 flex items-center gap-2">
          <button class="btn-ghost" :disabled="checking || updateState.status === 'checking'" @click="check">
            {{ checking || updateState.status === 'checking' ? '检查中…' : '检查更新' }}
          </button>
          <button v-if="canDownload" class="btn-ghost" :disabled="downloading || showProgress" @click="download">
            {{ downloading ? '下载中…' : '下载更新' }}
          </button>
          <button v-if="canInstall" class="btn-primary" :disabled="installing" @click="install">
            {{ installing ? '正在准备…' : '重启并安装' }}
          </button>
          <span v-if="updateState.checkedAt" class="text-[11px] text-slate-400">上次检查 {{ formatTime(updateState.checkedAt) }}</span>
        </div>
      </template>
      <template v-else>
        <p class="text-xs text-slate-500 leading-relaxed">
          开发模式不走在线更新。如需投放新包，运行「更新包上传工具.bat」一键打包并上传投放；客户端会按更新通道自动检查并提示。
        </p>
      </template>
    </div>
  </div>
</template>
