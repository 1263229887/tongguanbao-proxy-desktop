<script setup>
import { computed, onMounted, watch } from 'vue'
import logo from './assets/logo.png'
import HomeView from './views/HomeView.vue'
import AccessView from './views/AccessView.vue'
import DirView from './views/DirView.vue'
import ParamView from './views/ParamView.vue'
import AboutView from './views/AboutView.vue'
import { isRunning, startBiz } from './biz-run.js'
import { initStore, meta, pollState, cebState, updateState, view, go } from './store.js'

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
  idle: 'bg-rose-500'
}

// 顶栏状态汇总两套引擎：任一运行即「轮询执行中」；未运行时不保留上次的报错，统一显示未启动
const headerStatus = computed(() => {
  const a = pollState.value
  const b = cebState.value
  if (a.running || b.running) return { tone: 'warn', text: '轮询执行中' }
  if (a.polling || b.polling) {
    const err = a.lastError || b.lastError
    if (err) return { tone: 'bad', text: err }
    return { tone: 'ok', text: '轮询中' }
  }
  return { tone: 'idle', text: '未启动任何业务' }
})

// 发现新版本 / 下载完成时主动弹提醒（右上角，点击直达关于页）。
// 只是提示：不自动下载、不自动安装，是否更新完全由用户在关于页决定。
// 同一「状态+版本」只弹一次，界面刷新后状态重载会再弹——正是「刚打开界面就要有提示」的效果
let lastToastedKey = null
watch(
  () => updateState.value.status,
  (st, old) => {
    if (st === old) return
    if (st === 'updateAvailable' || st === 'downloaded') {
      const s = updateState.value
      const key = `${st}:${s.version ?? ''}`
      if (lastToastedKey === key) return
      lastToastedKey = key
      if (st === 'updateAvailable') {
        ElNotification({
          title: '发现新版本',
          message: `v${s.version ?? '—'} 已发布，可前往「关于」页下载安装`,
          duration: 12000,
          onClick: () => go('about')
        })
      } else {
        ElNotification({
          title: '新版本已就绪',
          message: `v${s.version ?? '—'} 下载完成，可前往「关于」页重启安装`,
          type: 'success',
          duration: 12000,
          onClick: () => go('about')
        })
      }
    }
  }
)

onMounted(async () => {
  await initStore()
  await offerBizRestoreAfterUpgrade()
})

async function clearBizRestoreMarker() {
  try {
    await window.intake.clearPendingBizRestore()
  } catch {}
}

// 在线升级会重启进程，代理默认不自启。主进程在安装前记录了升级前开着的业务，
// 这里在升级后首次启动时询问是否重新开启；用户没做选择就退出，下次启动还会再问
async function offerBizRestoreAfterUpgrade() {
  let pending = null
  try {
    pending = await window.intake.getPendingBizRestore()
  } catch {
    return
  }
  const pendingItems = pending?.items ?? []
  if (!pendingItems.length) return
  // 启动时已经在运行的业务不再重复询问（例如升级流程将来改成自动拉起代理）
  const items = pendingItems.filter((item) => !isRunning(item.id))
  if (!items.length) {
    await clearBizRestoreMarker()
    return
  }
  const names = items.map((item) => `「${item.title}」`).join('、')

  try {
    await ElMessageBox.confirm(
      `升级前${names}处于开启状态，相关目录配置也完整。是否现在重新开启？选择「暂不开启」后，仍可在首页随时手动启动。`,
      '升级完成',
      {
        confirmButtonText: '重新开启',
        cancelButtonText: '暂不开启',
        type: 'success',
        showClose: false,
        closeOnClickModal: false,
        closeOnPressEscape: false
      }
    )
  } catch {
    await clearBizRestoreMarker()
    return
  }

  const failed = []
  for (const item of items) {
    const res = await startBiz(item.id)
    if (!res.ok) failed.push(`「${item.title}」：${res.reason}`)
  }
  await clearBizRestoreMarker()

  if (failed.length) {
    ElNotification({ title: '未能重新开启', message: failed.join('；'), type: 'warning', duration: 12000 })
  } else {
    ElNotification({ title: '业务已重新开启', message: `${names}已按之前的配置继续运行`, type: 'success', duration: 6000 })
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
        <div
          class="ml-auto flex items-center gap-2 text-xs"
          :class="headerStatus.tone === 'idle' ? 'text-rose-600 font-medium' : 'text-slate-500'"
        >
          <span
            class="w-2 h-2 rounded-full"
            :class="[statusTone[headerStatus.tone], headerStatus.tone === 'idle' ? 'status-dot-pulse' : '']"
          />
          <span>{{ headerStatus.text }}</span>
        </div>
      </header>

      <section class="flex-1 min-h-0">
        <component :is="VIEWS[view]" />
      </section>
    </main>
  </div>
</template>

<style scoped>
.status-dot-pulse {
  position: relative;
}

.status-dot-pulse::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  background: rgba(244, 63, 94, 0.4);
  animation: statusDotPulse 2.2s ease-out infinite;
}

@keyframes statusDotPulse {
  0% {
    transform: scale(0.6);
    opacity: 0.7;
  }
  70%,
  100% {
    transform: scale(2.2);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot-pulse::after {
    animation: none;
  }
}
</style>
