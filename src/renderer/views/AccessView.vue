<script setup>
import { computed, ref, watch } from 'vue'
import { config, meta, saveConfig } from '../store.js'

const TAG_OPTIONS = [
  { value: '', label: '环境' },
  { value: 'test', label: '测试' },
  { value: 'prod', label: '生产' }
]

const TAG_TEXT = { test: '测试', prod: '生产', '': '未标' }

const form = ref(null)
const groups = ref([])
const active = ref(0)
const saving = ref(false)
const saved = ref(false)
const testing = ref(false)
const result = ref(null)

// 生产包只留企业鉴权密钥；开发/测试可填地址、多组
const canEditServer = computed(() => meta.value?.env !== 'prod')

function emptyGroup() {
  return { tag: '', apiUrl: '', agentKey: '' }
}

function pickProfile(p) {
  return {
    tag: p?.tag ?? '',
    apiUrl: p?.apiUrl ?? '',
    agentKey: p?.agentKey || p?.appKey || ''
  }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return (url || '').replace(/^https?:\/\//, '').split('/')[0]
  }
}

function groupLabel(g, i) {
  if (g.apiUrl) return hostOf(g.apiUrl)
  if (g.agentKey) return `key…${g.agentKey.slice(-4)}`
  return `组 ${i + 1}`
}

const groupChips = computed(() =>
  groups.value.map((g, i) => ({
    index: i,
    tag: TAG_TEXT[g.tag] || TAG_TEXT[''],
    label: groupLabel(g, i),
    active: i === active.value
  }))
)

watch(
  config,
  (val) => {
    if (!val) return
    if (groups.value.length) return
    const list = val.profiles?.length ? val.profiles : [pickProfile(val)]
    groups.value = list.map((p) => pickProfile(p))
    active.value = Math.min(val.activeProfile ?? 0, groups.value.length - 1)
    form.value = pickProfile(groups.value[active.value])
  },
  { immediate: true }
)

function selectGroup(i) {
  active.value = i
  form.value = pickProfile(groups.value[i])
  saved.value = false
  result.value = null
}

function pickFromList(value) {
  const i = groups.value.findIndex((g) => g.apiUrl === value || g.agentKey === value)
  if (i >= 0 && i !== active.value) selectGroup(i)
}

function addGroup() {
  groups.value = [...groups.value, emptyGroup()]
  selectGroup(groups.value.length - 1)
}

function removeGroup() {
  if (groups.value.length <= 1) return
  const rest = groups.value.filter((_, i) => i !== active.value)
  groups.value = rest
  selectGroup(Math.max(0, active.value - 1))
}

const edited = () => {
  saved.value = false
  result.value = null
}

async function submit() {
  saving.value = true
  saved.value = false
  try {
    if (canEditServer.value) {
      const next = groups.value.map((g, i) => (i === active.value ? pickProfile(form.value) : pickProfile(g)))
      await saveConfig({ profiles: next, activeProfile: active.value })
      groups.value = next
    } else {
      await saveConfig({ agentKey: form.value.agentKey })
    }
    saved.value = true
  } finally {
    saving.value = false
  }
}

async function test() {
  await submit()
  testing.value = true
  result.value = null
  try {
    result.value = await window.intake.testAccess()
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div v-if="form" class="h-full overflow-y-auto p-5">
    <div class="panel p-5 max-w-[920px] flex flex-col gap-4">
      <template v-if="canEditServer">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold">服务器配置</span>
          <span class="text-[11px] px-1.5 rounded bg-brand-50 text-brand-600">{{ meta?.env === 'dev' ? '开发模式' : '测试包' }}</span>
          <span class="ml-auto text-xs text-slate-400">当前编辑：第 {{ active + 1 }} / {{ groups.length }} 组</span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-500 shrink-0">切换组</span>
          <button
            v-for="chip in groupChips"
            :key="chip.index"
            type="button"
            class="h-8 px-3 rounded-full border text-xs font-medium transition-colors select-none"
            :class="
              chip.active
                ? 'bg-brand-500 border-brand-500 text-white shadow-sm shadow-brand-500/30'
                : 'bg-white border-slate-300 text-slate-600 hover:border-brand-300 hover:text-brand-600'
            "
            @click="selectGroup(chip.index)"
          >
            <span class="mr-1.5 opacity-80">{{ chip.tag }}</span>
            <span>{{ chip.label }}</span>
          </button>
          <span v-if="groups.length === 1" class="text-xs text-slate-400">仅一组，可点「新增一组」</span>
        </div>

        <div class="rounded-lg border border-brand-200 bg-brand-50/40 p-4 flex flex-col gap-4">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-brand-700">正在编辑第 {{ active + 1 }} 组</span>
            <span class="text-[11px] px-1.5 rounded bg-white border border-brand-200 text-brand-600">{{ TAG_TEXT[form.tag] || '未标环境' }}</span>
            <span class="text-[11px] text-brand-600/80 truncate min-w-0">{{ groupLabel(form, active) }}</span>
          </div>

          <div class="flex items-start gap-3">
            <div class="w-[92px] shrink-0">
              <div class="label-text mb-1">环境</div>
              <select v-model="form.tag" class="field" @change="edited">
                <option v-for="opt in TAG_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>

            <div class="flex-1 min-w-0 grid grid-cols-2 gap-3">
              <div>
                <div class="label-text mb-1">服务器地址</div>
                <input
                  v-model="form.apiUrl"
                  class="field"
                  list="api-url-options"
                  placeholder="留空则用测试环境 https://www.tel365.com:8088"
                  @change="pickFromList(form.apiUrl)"
                  @input="edited"
                />
                <datalist id="api-url-options">
                  <option v-for="(g, i) in groups" :key="i" :value="g.apiUrl" />
                </datalist>
              </div>

              <div>
                <div class="label-text mb-1">企业鉴权密钥</div>
                <input
                  v-model="form.agentKey"
                  type="password"
                  class="field"
                  list="agent-key-options"
                  placeholder="后台下发的 sk-… 企业鉴权密钥"
                  @change="pickFromList(form.agentKey)"
                  @input="edited"
                />
                <datalist id="agent-key-options">
                  <option v-for="(g, i) in groups" :key="i" :value="g.agentKey" />
                </datalist>
              </div>
            </div>
          </div>

          <div class="text-xs text-slate-400">密钥会写入本机配置目录，升级重装一般不会丢失。日志中只会显示末 4 位。</div>
        </div>

        <div class="flex items-center gap-2">
          <button class="btn-ghost" @click="addGroup">新增一组</button>
          <button class="btn-ghost" :disabled="groups.length <= 1" @click="removeGroup">删除本组</button>
        </div>
      </template>

      <template v-else>
        <div>
          <div class="label-text mb-1">企业鉴权密钥</div>
          <input v-model="form.agentKey" type="password" class="field max-w-[420px]" placeholder="后台按租户下发的 sk-… 密钥" @input="edited" />
        </div>

        <p class="text-xs text-slate-500 leading-relaxed">
          企业鉴权密钥由后台按租户下发，是本机访问后台数据的唯一凭证（无需租户 ID）。密钥保存在本机用户配置目录，升级后会保留。请妥善保管，不要外传。
        </p>
      </template>

      <div class="border-t border-slate-100 pt-4">
        <div class="label-text mb-1">实例名（instanceName）</div>
        <div class="field max-w-[420px] cursor-text select-all bg-slate-50 text-slate-500">
          {{ config?.instanceName || '（待生成）' }}
        </div>
        <div class="mt-1 text-xs text-slate-400">
          由「主机名 + 系统硬件指纹」首次自动生成并已固定，后台据此识别这台前置机；请勿修改，一旦变更请保持新名字不再改动。
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button class="btn-primary" :disabled="saving" @click="submit">{{ saving ? '保存中…' : '保存' }}</button>
        <button class="btn-ghost" :disabled="testing" @click="test">{{ testing ? '测试中…' : '测试访问' }}</button>
        <span v-if="saved && !result" class="text-xs text-emerald-600">已保存</span>
      </div>

      <div
        v-if="result"
        class="rounded border px-3 py-2 text-xs leading-relaxed"
        :class="result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'"
      >
        <div class="font-medium">{{ result.ok ? '访问正常' : '访问失败' }}</div>
        <div v-if="result.ok" class="mt-0.5">响应耗时 {{ result.cost }}ms</div>
        <div v-else class="mt-0.5 break-all">{{ result.reason }}</div>
      </div>
    </div>
  </div>
</template>
