<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { config, saveConfig } from '../store.js'
import { BUSINESS_TYPES, DIR_FIELDS, countFilledDirs, emptyBizDir } from '../../shared/biz-types.js'

const TASKS_MIN = 1
const TASKS_MAX = 5
const SAVE_DEBOUNCE_MS = 400

const form = ref(null)
const savingKeys = reactive({})
const autoSavedAt = reactive({})
const dirErrors = ref({})
const expanded = ref({})
const notice = ref(null)

const importPath = ref('')
const importing = ref(false)
const importResult = ref(null)

function cloneBizDirs(src) {
  const next = {}
  for (const type of BUSINESS_TYPES) {
    next[type.id] = { ...emptyBizDir(), ...(src?.[type.id] ?? {}) }
  }
  return next
}

watch(
  config,
  (val) => {
    if (!val || form.value) return
    form.value = { bizDirs: cloneBizDirs(val.bizDirs) }
    const open = {}
    const filled = BUSINESS_TYPES.filter((t) => countFilledDirs(val.bizDirs?.[t.id]) > 0)
    if (filled.length) for (const t of filled) open[t.id] = true
    else open[BUSINESS_TYPES[0].id] = true
    expanded.value = open
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  for (const t of Object.values(saveTimers)) clearTimeout(t)
})

const openCount = computed(() => Object.values(expanded.value).filter(Boolean).length)
const bizById = Object.fromEntries(BUSINESS_TYPES.map((t) => [t.id, t]))

function toggle(typeId) {
  expanded.value = { ...expanded.value, [typeId]: !expanded.value[typeId] }
}

function clampTasks(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return TASKS_MIN
  return Math.min(TASKS_MAX, Math.max(TASKS_MIN, Math.round(n)))
}

const saveTimers = {}

function clearKeyError(typeId, key) {
  if (!key) return
  const id = `${typeId}.${key}`
  if (dirErrors.value[id]) dirErrors.value = { ...dirErrors.value, [id]: null }
}

async function verifyOne(typeId, entry) {
  const errors = { ...dirErrors.value }
  let bad = 0
  for (const field of DIR_FIELDS) {
    const id = `${typeId}.${field.key}`
    if (!entry[field.key]) {
      errors[id] = null
      continue
    }
    const res = await window.intake.checkDir({ dir: entry[field.key], label: `${bizById[typeId]?.subtitle ?? typeId} · ${field.label}` })
    if (!res.ok) {
      errors[id] = res.reason
      bad += 1
    } else {
      errors[id] = null
    }
  }
  dirErrors.value = errors
  return bad
}

async function saveOne(typeId) {
  if (!form.value?.bizDirs?.[typeId]) return
  savingKeys[typeId] = true
  try {
    const entry = { ...form.value.bizDirs[typeId] }
    entry.maxConcurrentTasks = clampTasks(entry.maxConcurrentTasks)
    form.value.bizDirs[typeId].maxConcurrentTasks = entry.maxConcurrentTasks
    await saveConfig({ bizDirs: { [typeId]: entry } })
    await verifyOne(typeId, entry)
    autoSavedAt[typeId] = Date.now()
    notice.value = { tone: 'good', text: `${bizById[typeId]?.title ?? typeId} 已自动保存` }
  } catch (e) {
    notice.value = { tone: 'bad', text: `自动保存失败：${e.message}` }
  } finally {
    savingKeys[typeId] = false
  }
}

function scheduleSave(typeId) {
  if (saveTimers[typeId]) clearTimeout(saveTimers[typeId])
  saveTimers[typeId] = setTimeout(() => {
    delete saveTimers[typeId]
    saveOne(typeId)
  }, SAVE_DEBOUNCE_MS)
}

function edited(typeId, key) {
  notice.value = null
  clearKeyError(typeId, key)
  scheduleSave(typeId)
}

async function pick(type, field) {
  const entry = form.value.bizDirs[type.id]
  const picked = await window.intake.pickDir(entry[field.key])
  if (!picked) return
  entry[field.key] = picked
  if (saveTimers[type.id]) {
    clearTimeout(saveTimers[type.id])
    delete saveTimers[type.id]
  }
  await saveOne(type.id)
}

function stepTasks(typeId, delta) {
  const entry = form.value.bizDirs[typeId]
  entry.maxConcurrentTasks = clampTasks(Number(entry.maxConcurrentTasks) + delta)
  if (saveTimers[typeId]) {
    clearTimeout(saveTimers[typeId])
    delete saveTimers[typeId]
  }
  saveOne(typeId)
}

function onTasksInput(typeId) {
  scheduleSave(typeId)
}

async function pickImportPath() {
  const picked = await window.intake.pickDir(importPath.value || undefined)
  if (!picked) return
  importPath.value = picked
  importResult.value = null
}

async function runImport() {
  importing.value = true
  importResult.value = null
  notice.value = null
  try {
    if (typeof window.intake?.importSwDirs !== 'function') {
      notice.value = { tone: 'bad', text: '当前运行中的客户端没有导入接口，请完全退出后重新启动本软件再试。' }
      return
    }
    const res = await window.intake.importSwDirs({ basePath: importPath.value || '' })
    importResult.value = res
    if (!res || !res.ok) {
      notice.value = { tone: 'bad', text: res?.reason || '导入失败：未返回有效结果' }
      return
    }
    const nextBiz = {}
    for (const [typeId, entry] of Object.entries(form.value.bizDirs || {})) {
      nextBiz[typeId] = { ...entry }
    }
    for (const [typeId, entry] of Object.entries(res.mapped || {})) {
      const prev = nextBiz[typeId] || emptyBizDir()
      nextBiz[typeId] = {
        ...prev,
        outBox: entry.outBox || '',
        sentBox: entry.sentBox || '',
        inBox: entry.inBox || '',
        failBox: entry.failBox || '',
        maxConcurrentTasks: clampTasks(entry.maxConcurrentTasks || prev.maxConcurrentTasks)
      }
      expanded.value = { ...expanded.value, [typeId]: true }
    }
    form.value = { bizDirs: nextBiz }
    // store.saveConfig 内部会 JSON 序列化，避免 Proxy 导致 IPC clone 失败
    const saved = await saveConfig({ bizDirs: nextBiz })
    form.value = { bizDirs: cloneBizDirs(saved?.bizDirs ?? nextBiz) }
    // 导入后仅清错误，不做磁盘探测（后端未联调前只保证写入配置）
    dirErrors.value = {}
    for (const typeId of Object.keys(res.mapped || {})) {
      autoSavedAt[typeId] = Date.now()
    }
    const n = Object.keys(res.mapped).length
    notice.value = {
      tone: 'good',
      text: `已从单一窗口导入 ${n} 个业务目录，请逐项核对后再启动业务。`
    }
  } catch (e) {
    notice.value = { tone: 'bad', text: `导入失败：${e?.message || e}` }
  } finally {
    importing.value = false
  }
}

const NOTICE_TONE = {
  good: 'text-emerald-600',
  warn: 'text-amber-600',
  bad: 'text-rose-600'
}
</script>

<template>
  <div v-if="form" class="h-full overflow-y-auto p-5">
    <div class="w-full flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold">目录配置</span>
        <span class="text-xs text-slate-400">按业务类型设置，目录须与单一窗口导入客户端一致。</span>
        <span class="ml-auto text-xs text-slate-400">已展开 {{ openCount }} / {{ BUSINESS_TYPES.length }}</span>
      </div>

      <div class="panel p-4 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold">从单一窗口导入</span>
          <span class="text-[11px] px-1.5 rounded bg-amber-50 text-amber-700">需对方已配置目录</span>
        </div>
        <p class="text-xs text-slate-500 leading-relaxed -mt-1">
          请先启动「中国国际贸易单一窗口导入客户端」，并在其目录/任务管理里配置好各业务目录。导入会按业务类型匹配写入本软件，但<strong class="font-medium text-slate-600">不保证 100% 成功</strong>；即使提示导入成功，也请在双方软件里逐项核对目录是否一致，确认无误后再启动业务。导入失败或不想导入时，仍可手动填写。
        </p>
        <div class="flex flex-col sm:flex-row gap-2">
          <input v-model="importPath" class="field flex-1 min-w-0" placeholder="对方安装文件夹，例如 E:\\中国电子口岸客户端控件" @input="importResult = null" />
          <button class="btn-ghost shrink-0" @click="pickImportPath">选择…</button>
          <button class="btn-primary shrink-0" :disabled="importing" @click="runImport">{{ importing ? '导入中…' : '一键导入' }}</button>
        </div>
        <div v-if="importResult" class="text-xs leading-relaxed" :class="importResult.ok ? 'text-slate-500' : 'text-rose-600'">
          <div v-if="importResult.ok && importResult.source" class="break-all">来源：{{ importResult.source }}</div>
          <div v-if="importResult.ok && importResult.matchedFormIds?.length">已导入：{{ importResult.matchedFormIds.join('、') }}</div>
          <div v-if="importResult.ok" class="mt-1 text-amber-700">仅导入本软件支持的业务；启动前请双边核对目录是否一致。</div>
          <div v-if="!importResult.ok" class="break-all">{{ importResult.reason }}</div>
        </div>
      </div>

      <div
        v-for="type in BUSINESS_TYPES"
        :key="type.id"
        class="panel overflow-hidden w-full"
        :class="expanded[type.id] ? 'ring-1 ring-brand-500/20 border-brand-200' : ''"
      >
        <button type="button" class="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors" @click="toggle(type.id)">
          <div class="min-w-0 flex-1 flex items-baseline gap-2 flex-wrap">
            <span class="text-sm font-semibold text-slate-800">{{ type.title }}</span>
            <span v-if="type.subtitle !== type.title" class="text-xs text-slate-400">{{ type.subtitle }}</span>
          </div>
          <span class="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
            目录 {{ countFilledDirs(form.bizDirs[type.id]) }}/{{ DIR_FIELDS.length }} · 并发 {{ form.bizDirs[type.id].maxConcurrentTasks }}
          </span>
          <span v-if="savingKeys[type.id]" class="shrink-0 text-[11px] text-brand-600">保存中…</span>
          <svg
            class="w-4 h-4 shrink-0 text-slate-400 transition-transform"
            :class="expanded[type.id] ? 'rotate-180' : ''"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </button>

        <div v-if="expanded[type.id]" class="px-4 pb-5 pt-1 border-t border-slate-100 flex flex-col gap-4">
          <div v-if="type.subtitle !== type.title" class="text-xs text-slate-500">
            <span class="text-slate-700 font-medium">{{ type.title }}</span>
            <span class="mx-1 text-slate-300">/</span>
            <span>{{ type.subtitle }}</span>
          </div>

          <div class="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div class="flex-1 min-w-0 flex flex-col gap-3">
              <div v-for="field in DIR_FIELDS" :key="field.key">
                <div class="label-text mb-1">{{ field.label }}</div>
                <div class="flex gap-2">
                  <input
                    v-model="form.bizDirs[type.id][field.key]"
                    class="field flex-1 min-w-0"
                    @input="edited(type.id, field.key)"
                  />
                  <button class="btn-ghost shrink-0" @click="pick(type, field)">选择…</button>
                </div>
                <div v-if="dirErrors[`${type.id}.${field.key}`]" class="mt-1 text-xs text-rose-600 break-all">
                  {{ dirErrors[`${type.id}.${field.key}`] }}
                </div>
              </div>
            </div>

            <div class="shrink-0 lg:w-[220px] lg:border-l lg:border-slate-100 lg:pl-5 flex flex-col items-center gap-3 py-1">
              <div class="w-full">
                <div class="label-text mb-1 text-center">同时最大任务数（{{ TASKS_MIN }}-{{ TASKS_MAX }}）</div>
                <div
                  class="h-8 flex rounded border border-slate-300 bg-white overflow-hidden focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/15"
                >
                  <button class="btn-step border-r border-slate-300" :disabled="form.bizDirs[type.id].maxConcurrentTasks <= TASKS_MIN" @click="stepTasks(type.id, -1)">
                    −
                  </button>
                  <input
                    v-model.number="form.bizDirs[type.id].maxConcurrentTasks"
                    type="number"
                    :min="TASKS_MIN"
                    :max="TASKS_MAX"
                    class="flex-1 min-w-0 h-full bg-white text-center text-sm tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    @input="onTasksInput(type.id)"
                  />
                  <button class="btn-step border-l border-slate-300" :disabled="form.bizDirs[type.id].maxConcurrentTasks >= TASKS_MAX" @click="stepTasks(type.id, 1)">
                    +
                  </button>
                </div>
              </div>
              <p class="text-xs text-slate-400 leading-relaxed text-center">仅对该业务类型生效</p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="notice" class="text-xs" :class="NOTICE_TONE[notice.tone]">{{ notice.text }}</div>
    </div>
  </div>
</template>
