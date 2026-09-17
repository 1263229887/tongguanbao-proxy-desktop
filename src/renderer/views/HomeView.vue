<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { gsap } from '../vendor/gsap.min.js'
import StatusTile from '../components/StatusTile.vue'
import { config, go, meta, pollState } from '../store.js'
import { BUSINESS_TYPES, DIR_FIELDS, countFilledDirs } from '../../shared/biz-types.js'
import { bizRun, isRunning, missingDirs, runningCount, startBiz, stopBiz } from '../biz-run.js'

// 主进程代理状态与首页「货物申报」卡片对齐
watch(
  () => [pollState.value.running, pollState.value.enabled],
  ([running, enabled]) => {
    const on = !!(running || enabled)
    bizRun.goods.running = on
    if (on && !bizRun.goods.startedAt) bizRun.goods.startedAt = Date.now()
    if (!on) bizRun.goods.startedAt = null
  },
  { immediate: true }
)

const GUIDE = [
  { view: 'access', label: '权限配置', desc: '填写企业鉴权密钥（sk-…）。测试环境服务器地址可留空，将自动使用 https://www.tel365.com:8088。保存后可点「测试访问」确认能否连通。' },
  { view: 'dir', label: '目录配置', desc: '货物申报请配置统一 OutBox / InBox / 归档 / 失败目录，可从单一窗口一键导入。目录必须与对方完全一致。' },
  { view: 'param', label: '参数配置', desc: '轮询间隔、回执/心跳间隔、开机自动启动、日志保留。本地开发可打开调试控制台查看 Network。' },
  { view: 'about', label: '保持运行与更新', desc: '关闭主窗口后程序仍在后台；彻底退出请在托盘图标上右键。生产环境可用 Ctrl+Shift+I 打开调试台。' }
]

const now = ref(Date.now())
let clock = null
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000)
  // 已处于运行中的业务立刻挂上循环动效
  syncRunAnims()
})
onBeforeUnmount(() => {
  clearInterval(clock)
  killAllRunAnims()
})

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h >= 24 ? `${Math.floor(h / 24)} 天 ${pad(h % 24)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
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

const toast = ref(null)
let toastTimer = null
function showToast(tone, text) {
  toast.value = { tone, text }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 4200)
}

const animating = ref({})
const cardEls = ref({})
const runTweens = new Map()

function setCardEl(id, el) {
  if (el) cardEls.value[id] = el
}

function killRunAnim(typeId) {
  const tw = runTweens.get(typeId)
  if (tw) {
    tw.kill()
    runTweens.delete(typeId)
  }
  const el = cardEls.value[typeId]
  if (el) gsap.set(el, { clearProps: 'boxShadow,backgroundColor,borderColor' })
}

function killAllRunAnims() {
  for (const id of [...runTweens.keys()]) killRunAnim(id)
}

/** 运行中持续动效：蓝光呼吸（GSAP timeline，无斜条纹） */
function startRunAnim(typeId) {
  killRunAnim(typeId)
  const el = cardEls.value[typeId]
  if (!el) return
  gsap.set(el, {
    backgroundColor: '#f8fbff',
    borderColor: 'rgba(47, 111, 237, 0.28)',
    boxShadow: '0 0 0 1px rgba(47, 111, 237, 0.08), 0 10px 28px -16px rgba(47, 111, 237, 0.45)'
  })
  const tl = gsap.timeline({ repeat: -1, yoyo: true })
  tl.to(
    el,
    {
      duration: 2.2,
      ease: 'sine.inOut',
      boxShadow: '0 0 0 1px rgba(47, 111, 237, 0.34), 0 12px 32px -12px rgba(47, 111, 237, 0.55)',
      borderColor: 'rgba(47, 111, 237, 0.5)'
    },
    0
  )
  tl.to(
    el,
    {
      duration: 2.2,
      ease: 'sine.inOut',
      backgroundColor: '#eef5ff'
    },
    0
  )
  runTweens.set(typeId, tl)
}

function syncRunAnims() {
  for (const t of BUSINESS_TYPES) {
    if (isRunning(t.id)) startRunAnim(t.id)
    else killRunAnim(t.id)
  }
}

watch(
  () => BUSINESS_TYPES.map((t) => isRunning(t.id)),
  () => syncRunAnims(),
  { flush: 'post' }
)

/** 启动瞬间：缩放 + 光晕爆闪 */
function playStartAnim(typeId) {
  animating.value = { ...animating.value, [typeId]: true }
  const el = cardEls.value[typeId]
  if (el) {
    gsap.fromTo(
      el,
      { scale: 1 },
      {
        scale: 1.025,
        duration: 0.18,
        ease: 'power2.out',
        yoyo: true,
        repeat: 1,
        onComplete: () => gsap.set(el, { scale: 1 })
      }
    )
  }
  window.setTimeout(() => {
    animating.value = { ...animating.value, [typeId]: false }
  }, 1000)
}

async function onStart(type) {
  const res = await startBiz(type.id)
  if (!res.ok) {
    showToast('bad', res.reason)
    return
  }
  await nextTick()
  playStartAnim(type.id)
}

function onStop(type) {
  stopBiz(type.id)
}

const bizCards = computed(() =>
  BUSINESS_TYPES.map((t) => {
    const entry = config.value?.bizDirs?.[t.id]
    return {
      ...t,
      filled: countFilledDirs(entry),
      total: DIR_FIELDS.length,
      tasks: entry?.maxConcurrentTasks ?? '—',
      running: isRunning(t.id),
      miss: missingDirs(t.id),
      real: t.id === 'goods'
    }
  })
)
</script>

<template>
  <div class="h-full overflow-y-auto p-5 flex flex-col gap-3">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
      <StatusTile label="运行中业务" :value="`${runningCount} / ${BUSINESS_TYPES.length}`" :tone="runningCount ? 'good' : 'default'" hint="仅统计本机已启动的业务" />
      <StatusTile
        label="与服务器是否已联通"
        :value="connectedState.value"
        :tone="connectedState.tone"
        :hint="connectedState.tone === 'bad' ? pollState.lastError : ''"
      />
      <StatusTile label="启动后运行时长" :value="uptime" hint="自本次程序启动计时" />
      <StatusTile
        label="已投递 / 已归档回执"
        :value="`${pollState.delivered ?? 0} / ${pollState.receipts ?? 0}`"
        hint="自本次程序启动累计；处理数见日志"
      />
    </div>

    <div class="panel px-4 py-3 border-amber-200 bg-amber-50/70 shrink-0">
      <div class="flex items-start gap-2 text-xs leading-relaxed text-amber-800">
        <span class="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-amber-400 text-white text-[10px] font-bold flex items-center justify-center">!</span>
        <p>
          启动业务前，请确保<strong class="font-semibold">中国国际贸易单一窗口导入客户端</strong>中对应业务与「接收回执」均已启动，且本软件
          <button type="button" class="underline decoration-dotted text-brand-600 hover:text-brand-700" @click="go('dir')">目录配置</button>
          与对方<strong class="font-semibold">完全一致</strong>。未配齐目录和启动回执，启动业务将无法正常生效。
        </p>
      </div>
    </div>

    <div class="panel shrink-0 w-full flex flex-col">
      <div class="h-10 shrink-0 flex items-center px-4 border-b border-slate-100">
        <span class="text-sm font-semibold">操作指引</span>
      </div>
      <div class="px-4 py-3 flex flex-col divide-y divide-slate-100">
        <div v-for="(item, i) in GUIDE" :key="item.view" class="group flex gap-3 py-3 first:pt-0 last:pb-0 cursor-pointer" @click="go(item.view)">
          <span class="w-5 h-5 shrink-0 rounded-full bg-brand-50 text-brand-600 text-xs font-medium flex items-center justify-center">{{ i + 1 }}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-700 group-hover:text-brand-600 transition-colors">{{ item.label }}</span>
              <span class="ml-auto text-xs text-slate-400 shrink-0 group-hover:text-brand-600 transition-colors">去配置 ›</span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-slate-500">{{ item.desc }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="panel shrink-0 w-full">
      <div class="h-10 flex items-center px-4 border-b border-slate-100">
        <span class="text-sm font-semibold">业务启动</span>
        <span class="ml-2 text-xs text-slate-400">看按钮与卡片动效即可判断启停</span>
      </div>
      <div class="p-3 flex flex-col gap-2.5">
        <div
          v-for="type in bizCards"
          :key="type.id"
          :ref="(el) => setCardEl(type.id, el)"
          class="relative rounded-xl border transition-all duration-200 overflow-hidden"
          :class="type.running ? 'biz-card-running' : 'border-slate-200 bg-white hover:border-slate-300'"
        >
          <div class="absolute inset-0 pointer-events-none rounded-xl opacity-0" :class="animating[type.id] ? 'biz-flash' : ''" />

          <div v-if="type.running" class="biz-h-sheen pointer-events-none absolute inset-0" aria-hidden="true" />

          <div class="relative flex items-center gap-3 px-4 py-3.5">
            <div class="min-w-0 flex-1 flex items-center gap-3 flex-wrap">
              <div class="flex items-baseline gap-2 min-w-0">
                <span class="text-sm font-semibold" :class="type.running ? 'text-slate-900' : 'text-slate-800'">{{ type.title }}</span>
                <span v-if="type.subtitle !== type.title" class="text-xs text-slate-400">{{ type.subtitle }}</span>
                <span v-if="type.real" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">真实对接</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span :class="type.filled === type.total ? 'text-brand-600' : 'text-amber-600'">
                  目录 {{ type.filled }}/{{ type.total }}
                </span>
                <span>并发 {{ type.tasks }}</span>
                <span v-if="type.miss.length" class="text-amber-700 truncate max-w-[220px]" :title="type.miss.join('、')">
                  缺：{{ type.miss.join('、') }}
                </span>
              </div>
            </div>

            <button
              type="button"
              class="shrink-0 h-9 min-w-[72px] px-5 rounded-full text-sm font-medium transition-all select-none"
              :class="
                type.running
                  ? 'biz-btn-stop'
                  : 'bg-brand-500 text-white hover:bg-brand-600 shadow-sm shadow-brand-500/25'
              "
              @click="type.running ? onStop(type) : onStart(type)"
            >
              {{ type.running ? '停止' : '启动' }}
            </button>
          </div>

          <div v-if="animating[type.id]" class="absolute inset-0 pointer-events-none flex items-center justify-center rounded-xl">
            <span class="biz-orb" />
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="toast"
      class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] rounded-lg px-4 py-2.5 text-sm shadow-lg border"
      :class="
        toast.tone === 'good'
          ? 'bg-emerald-600 border-emerald-700 text-white'
          : toast.tone === 'bad'
            ? 'bg-rose-600 border-rose-700 text-white'
            : 'bg-amber-500 border-amber-600 text-white'
      "
    >
      {{ toast.text }}
    </div>
  </div>
</template>

<style scoped>
/* 运行中卡片底色（GSAP 会再叠阴影呼吸） */
.biz-card-running {
  background: #f3f8ff;
  border-color: rgba(47, 111, 237, 0.35);
}

/* 整卡轻微横向扫光 */
.biz-h-sheen {
  background: linear-gradient(
    100deg,
    transparent 40%,
    rgba(47, 111, 237, 0.08) 50%,
    transparent 60%
  );
  background-size: 220% 100%;
  animation: bizHSheen 2.4s linear infinite;
  pointer-events: none;
}

.biz-flash {
  opacity: 1;
  background: radial-gradient(circle at 50% 50%, rgba(47, 111, 237, 0.3), transparent 60%);
  animation: bizFlash 0.9s ease-out forwards;
  z-index: 2;
}

.biz-orb {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: radial-gradient(circle, #93c5fd 0%, #2f6fed 55%, transparent 72%);
  box-shadow: 0 0 0 0 rgba(47, 111, 237, 0.45);
  animation: bizOrb 0.9s ease-out forwards;
  z-index: 3;
}

.biz-btn-stop {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  color: #fff;
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4);
  animation: bizStopGlow 1.8s ease-in-out infinite;
}

.biz-btn-stop:hover {
  filter: brightness(1.05);
}

@keyframes bizHSheen {
  0% {
    background-position: 120% 0;
  }
  100% {
    background-position: -40% 0;
  }
}

@keyframes bizStopGlow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.3);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.1);
  }
}

@keyframes bizFlash {
  0% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
  }
}

@keyframes bizOrb {
  0% {
    transform: scale(0.2);
    box-shadow: 0 0 0 0 rgba(47, 111, 237, 0.45);
  }
  60% {
    transform: scale(1.7);
    box-shadow: 0 0 0 24px rgba(47, 111, 237, 0);
  }
  100% {
    transform: scale(2.2);
    opacity: 0;
    box-shadow: 0 0 0 36px rgba(47, 111, 237, 0);
  }
}
</style>
