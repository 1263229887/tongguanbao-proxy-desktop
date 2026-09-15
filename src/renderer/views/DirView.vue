<script setup>
import { ref, watch } from 'vue'
import { config, saveConfig } from '../store.js'

const TASKS_MIN = 1
const TASKS_MAX = 5

const DIRS = [
  { key: 'outBox', label: '待发送文件目录', placeholder: 'D:\\intake\\OutBox' },
  { key: 'sentBox', label: '发送完毕的文件', placeholder: 'D:\\intake\\SentBox' },
  { key: 'inBox', label: '回执文件 / 异常情况说明文件', placeholder: 'D:\\intake\\InBox' },
  { key: 'failBox', label: '服务器端校验失败文件', placeholder: 'D:\\intake\\FailBox' }
]

const form = ref(null)
const dirty = ref(false)
const saving = ref(false)
const dirErrors = ref({})
const summary = ref(null)

watch(
  config,
  (val) => {
    if (val && !form.value) form.value = { dirs: { ...val.dirs }, maxConcurrentTasks: val.maxConcurrentTasks }
  },
  { immediate: true }
)

function clampTasks(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return TASKS_MIN
  return Math.min(TASKS_MAX, Math.max(TASKS_MIN, Math.round(n)))
}

function edited(key) {
  dirty.value = true
  summary.value = null
  if (key) dirErrors.value[key] = null
}

async function pick(d) {
  const picked = await window.intake.pickDir(form.value.dirs[d.key])
  if (!picked) return
  form.value.dirs[d.key] = picked
  edited(d.key)
}

function stepTasks(delta) {
  form.value.maxConcurrentTasks = clampTasks(form.value.maxConcurrentTasks + delta)
  edited()
}

async function submit() {
  saving.value = true
  try {
    form.value.maxConcurrentTasks = clampTasks(form.value.maxConcurrentTasks)
    const next = await saveConfig({ dirs: form.value.dirs, maxConcurrentTasks: form.value.maxConcurrentTasks })
    form.value = { dirs: { ...next.dirs }, maxConcurrentTasks: next.maxConcurrentTasks }
    dirty.value = false

    const filled = DIRS.filter((d) => next.dirs[d.key])
    const checked = await Promise.all(
      filled.map(async (d) => ({ key: d.key, res: await window.intake.checkDir({ dir: next.dirs[d.key], label: d.label }) }))
    )
    const errors = {}
    for (const item of checked) if (!item.res.ok) errors[item.key] = item.res.reason
    dirErrors.value = errors

    const bad = Object.keys(errors).length
    if (!filled.length) summary.value = { tone: 'warn', text: '已保存，但四个目录都还没设置，文件没有落地位置' }
    else if (bad) summary.value = { tone: 'bad', text: `已保存，${bad} 个目录有问题，请看下方红色提示` }
    else summary.value = { tone: 'good', text: `已保存，${filled.length} 个目录都可读写` }
  } finally {
    saving.value = false
  }
}

const SUMMARY_TONE = {
  good: 'text-emerald-600',
  warn: 'text-amber-600',
  bad: 'text-rose-600'
}
</script>

<template>
  <div v-if="form" class="h-full overflow-y-auto p-5">
    <div class="panel max-w-[880px] flex flex-col">
      <div class="h-11 shrink-0 flex items-center px-5 border-b border-slate-100">
        <span class="text-sm font-semibold">货物申报</span>
      </div>

      <div class="p-5 flex flex-col gap-4">
        <div class="text-sm font-semibold">报关单暂存</div>

        <div>
          <div class="label-text mb-3">获取申报</div>
          <div class="flex gap-5 flex-col lg:flex-row">
            <div class="flex-1 min-w-0 flex flex-col gap-4">
              <div v-for="d in DIRS" :key="d.key">
                <div class="label-text mb-1">{{ d.label }}</div>
                <div class="flex gap-2">
                  <input v-model="form.dirs[d.key]" class="field flex-1 min-w-0" :placeholder="d.placeholder" @input="edited(d.key)" />
                  <button class="btn-ghost shrink-0" @click="pick(d)">选择…</button>
                </div>
                <div v-if="dirErrors[d.key]" class="mt-1 text-xs text-rose-600 break-all">{{ dirErrors[d.key] }}</div>
              </div>
            </div>

            <div class="shrink-0 lg:w-[240px] lg:border-l lg:border-slate-100 lg:pl-5">
              <div class="label-text mb-1">同时最大任务数（{{ TASKS_MIN }}-{{ TASKS_MAX }}）</div>
              <div class="h-8 flex rounded border border-slate-300 bg-white overflow-hidden focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/15">
                <button class="btn-step border-r border-slate-300" :disabled="form.maxConcurrentTasks <= TASKS_MIN" @click="stepTasks(-1)">−</button>
                <input
                  v-model.number="form.maxConcurrentTasks"
                  type="number"
                  :min="TASKS_MIN"
                  :max="TASKS_MAX"
                  class="flex-1 min-w-0 h-full bg-white text-center text-sm tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  @input="edited()"
                />
                <button class="btn-step border-l border-slate-300" :disabled="form.maxConcurrentTasks >= TASKS_MAX" @click="stepTasks(1)">+</button>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-slate-100 pt-4 flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <button class="btn-primary" :disabled="saving" @click="submit">{{ saving ? '保存中…' : '保存' }}</button>
            <span v-if="dirty" class="text-xs text-slate-400">有改动未保存</span>
          </div>
          <div v-if="summary" class="text-xs" :class="SUMMARY_TONE[summary.tone]">{{ summary.text }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
