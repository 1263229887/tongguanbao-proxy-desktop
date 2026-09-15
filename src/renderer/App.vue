<script setup>
import { onMounted, ref } from 'vue'
import logo from './assets/logo.png'
import HomeView from './views/HomeView.vue'
import AccessView from './views/AccessView.vue'
import DirView from './views/DirView.vue'
import ParamView from './views/ParamView.vue'
import AboutView from './views/AboutView.vue'
import { initStore, meta, pollState, view, go } from './store.js'

const VIEWS = { home: HomeView, access: AccessView, dir: DirView, param: ParamView, about: AboutView }
const NAV = [
  { key: 'home', label: '首页' },
  { key: 'access', label: '权限配置' },
  { key: 'dir', label: '目录配置' },
  { key: 'param', label: '参数配置' },
  { key: 'about', label: '关于' }
]

const statusTone = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  bad: 'bg-rose-500',
  idle: 'bg-slate-300'
}

onMounted(initStore)

const toggling = ref(false)

async function toggle() {
  toggling.value = true
  try {
    pollState.value = pollState.value.polling ? await window.intake.stopPoll() : await window.intake.startPoll()
  } finally {
    toggling.value = false
  }
}
</script>

<template>
  <div class="h-full flex bg-[#f3f5f8] text-slate-800">
    <aside class="w-52 shrink-0 flex flex-col border-r border-slate-200 bg-white">
      <div class="h-14 shrink-0 flex items-center gap-2.5 px-4 border-b border-slate-100">
        <img :src="logo" alt="" class="w-7 h-7 shrink-0 rounded" />
        <div class="min-w-0">
          <div class="text-sm font-semibold leading-tight truncate">{{ meta?.name ?? '通关宝 proxy' }}</div>
          <div class="text-[11px] text-slate-400 leading-tight truncate">代理机数据接收端</div>
        </div>
      </div>
      <nav class="py-2 flex flex-col gap-0.5">
        <div v-for="item in NAV" :key="item.key" :class="view === item.key ? 'nav-item-active' : 'nav-item'" @click="go(item.key)">
          {{ item.label }}
        </div>
      </nav>
      <div class="mt-auto px-4 py-3 text-[11px] text-slate-400 border-t border-slate-100">
        v{{ meta?.version ?? '—' }}{{ meta?.packaged ? '' : ' · dev' }}
      </div>
    </aside>

    <main class="flex-1 min-w-0 flex flex-col">
      <header class="h-14 shrink-0 flex items-center gap-2 px-5 border-b border-slate-200 bg-white">
        <h1 class="text-sm font-semibold">{{ NAV.find((n) => n.key === view)?.label }}</h1>
        <div class="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <button
            class="w-8 h-8 shrink-0 rounded-full border flex items-center justify-center transition-colors select-none disabled:opacity-50 disabled:pointer-events-none"
            :class="pollState.polling ? 'bg-white border-rose-300 text-rose-500 hover:bg-rose-50' : 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'"
            :disabled="toggling"
            :title="pollState.polling ? '点击停止代理机' : '点击启动代理机'"
            @click="toggle"
          >
            <svg v-if="pollState.polling" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7.75 5h3.25v14H7.75zM13 5h3.25v14H13z" />
            </svg>
            <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8.5 5.25v13.5L19 12z" />
            </svg>
          </button>
          <div class="flex items-center gap-2">
            <span
              class="w-2 h-2 rounded-full"
              :class="pollState.running ? statusTone.warn : pollState.lastError ? statusTone.bad : pollState.polling ? statusTone.ok : statusTone.idle"
            />
            <span>{{ pollState.running ? '轮询执行中' : pollState.lastError || (pollState.polling ? '轮询中' : '轮询未启动') }}</span>
          </div>
        </div>
      </header>

      <section class="flex-1 min-h-0">
        <component :is="VIEWS[view]" />
      </section>
    </main>
  </div>
</template>
