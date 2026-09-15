<script setup>
import { computed, ref } from 'vue'
import { UPDATE_TEXT, meta, update } from '../store.js'

const checking = ref(false)

const rows = computed(() => [
  { k: '应用名称', v: meta.value?.name ?? '—' },
  { k: '版本号', v: meta.value?.version ?? '—' },
  { k: 'Electron', v: meta.value?.electron ?? '—' },
  { k: 'Chromium', v: meta.value?.chrome ?? '—' },
  { k: 'Node.js', v: meta.value?.node ?? '—' },
  { k: '运行平台', v: meta.value ? `${meta.value.platform} / ${meta.value.arch}` : '—' },
  { k: '安装形态', v: meta.value ? (meta.value.packaged ? '已打包安装' : '开发模式') : '—' }
])

const tone = computed(() => {
  const s = update.value.status
  if (s === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (s === 'error') return 'border-rose-200 bg-rose-50 text-rose-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
})

async function check() {
  checking.value = true
  try {
    await window.intake.checkUpdate()
  } finally {
    checking.value = false
  }
}

const install = () => window.intake.installUpdate()
</script>

<template>
  <div class="h-full overflow-y-auto p-5">
    <div class="panel p-5 max-w-[620px]">
      <div class="text-sm font-semibold mb-3">版本信息</div>
      <div v-for="row in rows" :key="row.k" class="flex gap-4 py-1.5 border-b border-slate-50 last:border-b-0 text-sm">
        <span class="w-24 shrink-0 text-slate-400">{{ row.k }}</span>
        <span class="text-slate-700">{{ row.v }}</span>
      </div>
    </div>

    <div class="panel p-5 max-w-[620px] mt-3">
      <div class="text-sm font-semibold mb-3">升级检查</div>
      <div class="flex items-center gap-3">
        <button class="btn-primary" :disabled="checking" @click="check">{{ checking ? '检查中…' : '检查更新' }}</button>
        <button v-if="update.status === 'ready'" class="btn-ghost" @click="install">重启并安装</button>
      </div>
      <div class="mt-3 rounded border px-3 py-2 text-xs leading-relaxed" :class="tone">
        {{ UPDATE_TEXT[update.status] || update.status }}
        <template v-if="update.version">· 版本 {{ update.version }}</template>
        <template v-if="update.note">· {{ update.note }}</template>
      </div>
    </div>
  </div>
</template>
