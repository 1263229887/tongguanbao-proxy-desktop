<script setup>
import { computed } from 'vue'
import { meta } from '../store.js'

function val(x) {
  return x == null || x === '' ? '—' : String(x)
}

const rows = computed(() => [
  { k: '应用名称', v: val(meta.value?.name) },
  { k: '版本号', v: val(meta.value?.version) },
  { k: 'Electron', v: val(meta.value?.electron) },
  { k: 'Chromium', v: val(meta.value?.chrome) },
  { k: 'Node.js', v: val(meta.value?.node) },
  { k: '运行平台', v: meta.value ? `${val(meta.value.platform)} / ${val(meta.value.arch)}` : '—' },
  { k: '安装形态', v: meta.value ? (meta.value.packaged ? '已打包安装' : '开发模式') : '—' }
])
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
      <div class="text-sm font-semibold mb-2">应用更新</div>
      <p class="text-xs text-slate-500 leading-relaxed">
        在线检查更新暂未接入，本版本不会连接 GitHub 或其他更新源。需要升级时，请使用随包分发的安装程序覆盖安装即可，本机配置与日志会保留。
      </p>
    </div>
  </div>
</template>
