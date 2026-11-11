<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { config, saveConfig } from '../store.js'
import { CEB_DIR_FIELDS, CEB_ROUTES, emptyCebChannel } from '../../shared/biz-types.js'

// 跨境电商渠道目录编辑：每个渠道一个独立传输客户端（深圳公服只是其中之一），各有收发目录。
// 任务按报文 BaseTransfer.dxpId 匹配渠道；dxpId 留空作该路由兜底。与 DirView 一致的 400ms 自动保存。
const SAVE_DEBOUNCE_MS = 400

const channels = ref(null)
const saving = ref(false)
const savedAt = ref(null)
const dirErrors = ref({})
const notice = ref(null)
let saveTimer = null

function clone(src) {
  return (Array.isArray(src) ? src : []).map((c) => ({ ...emptyCebChannel(), ...c }))
}

watch(
  config,
  (val) => {
    if (!val || channels.value) return
    channels.value = clone(val.cebChannels)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
})

function newId() {
  return crypto.randomUUID()
}

function addChannel() {
  channels.value = [...channels.value, { ...emptyCebChannel(), id: newId() }]
  persist()
}

async function removeChannel(ch) {
  try {
    await ElMessageBox.confirm(
      `删除渠道「${ch.name || '未命名'}」后，匹配到该渠道的任务将无法投递。确定删除？`,
      '删除渠道',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  channels.value = channels.value.filter((c) => c.id !== ch.id)
  persist()
}

function edited() {
  notice.value = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist()
  }, SAVE_DEBOUNCE_MS)
}

async function persist() {
  if (!channels.value) return
  saving.value = true
  try {
    // 保留本地编辑态（与 DirView 一致）：规范化不会改动合法 id/路由/启用位，
    // 回填整份数组会在用户连续输入时打断光标
    await saveConfig({ cebChannels: channels.value })
    await verifyDirs()
    savedAt.value = Date.now()
    notice.value = { tone: 'good', text: '渠道配置已自动保存' }
  } catch (e) {
    notice.value = { tone: 'bad', text: `自动保存失败：${e.message}` }
  } finally {
    saving.value = false
  }
}

async function verifyDirs() {
  const errors = {}
  for (const ch of channels.value) {
    for (const field of CEB_DIR_FIELDS) {
      const dir = String(ch[field.key] || '').trim()
      if (!dir) continue
      const res = await window.intake.checkDir({ dir, label: `${ch.name || '渠道'} · ${field.label}` })
      if (!res.ok) errors[`${ch.id}.${field.key}`] = res.reason
    }
  }
  dirErrors.value = errors
}

async function pick(ch, field) {
  const picked = await window.intake.pickDir(ch[field.key])
  if (!picked) return
  ch[field.key] = picked
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await persist()
}

const NOTICE_TONE = {
  good: 'text-emerald-600',
  bad: 'text-rose-600'
}
</script>

<template>
  <div v-if="channels" class="flex flex-col gap-3">
    <div class="rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3 text-xs leading-relaxed text-slate-600">
      每个渠道对应一个<strong class="font-medium text-slate-700">独立传输客户端</strong>（深圳公服只是其中之一），各有自己的发送 / 接收目录。
      任务按报文中的 <strong class="font-medium text-slate-700">dxpId</strong> 自动匹配渠道：填写渠道 dxpId 可精确匹配，留空则作为该路由的兜底目录。
      发送目录（写入申报报文）与接收目录（读取回执）必填，备份 / 失败目录选填。
      9710 / 9810 的<strong class="font-medium text-slate-700">报关单申报</strong>仍走「货物申报」目录，此处仅配置前置申报与清单申报。
    </div>

    <div v-if="!channels.length" class="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-xs text-slate-400">
      还没有渠道。点击下方「添加渠道」，为每个传输客户端配置发送 / 接收目录。
    </div>

    <div v-for="ch in channels" :key="ch.id" class="rounded-lg border border-slate-200 bg-white">
      <div class="flex items-center gap-3 px-3.5 py-2.5 border-b border-slate-100">
        <label class="flex items-center gap-1.5 cursor-pointer select-none shrink-0" :title="ch.enabled === false ? '已停用' : '已启用'">
          <input v-model="ch.enabled" type="checkbox" class="w-3.5 h-3.5 accent-[#2f6fed]" @change="edited" />
          <span class="text-xs text-slate-500">启用</span>
        </label>
        <input v-model="ch.name" class="field flex-1 min-w-0" placeholder="渠道名称，如：深圳公服" @input="edited" />
        <el-select v-model="ch.route" class="w-[240px] shrink-0" @change="edited">
          <el-option v-for="r in CEB_ROUTES" :key="r.id" :label="r.label" :value="r.id" />
        </el-select>
        <button class="btn-ghost shrink-0 !px-2.5 text-rose-600 hover:bg-rose-50" title="删除该渠道" @click="removeChannel(ch)">删除</button>
      </div>

      <div class="px-3.5 py-3 flex flex-col gap-3">
        <div>
          <div class="label-text mb-1">报文 dxpId（选填，留空作该路由兜底）</div>
          <input v-model="ch.dxpId" class="field w-full" placeholder="与对方传输客户端配置一致，如 DXPENT0000000001" @input="edited" />
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-3">
          <div v-for="field in CEB_DIR_FIELDS" :key="field.key">
            <div class="label-text mb-1">
              {{ field.label }}
              <span v-if="field.required" class="text-rose-500">*</span>
            </div>
            <div class="flex gap-2">
              <input v-model="ch[field.key]" class="field flex-1 min-w-0" @input="edited" />
              <button class="btn-ghost shrink-0" @click="pick(ch, field)">选择…</button>
            </div>
            <div v-if="dirErrors[`${ch.id}.${field.key}`]" class="mt-1 text-xs text-rose-600 break-all">
              {{ dirErrors[`${ch.id}.${field.key}`] }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button class="btn-primary" @click="addChannel">添加渠道</button>
      <span v-if="saving" class="text-xs text-brand-600">保存中…</span>
      <span v-else-if="savedAt" class="text-xs text-slate-400">已自动保存</span>
      <span v-if="notice" class="text-xs" :class="NOTICE_TONE[notice.tone]">{{ notice.text }}</span>
    </div>
  </div>
</template>