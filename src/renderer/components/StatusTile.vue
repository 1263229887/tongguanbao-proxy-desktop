<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: String, default: '—' },
  hint: { type: String, default: '' },
  tone: { type: String, default: 'default' }
})

const TONES = {
  default: 'text-slate-800',
  good: 'text-emerald-600',
  warn: 'text-amber-600',
  bad: 'text-rose-600'
}
</script>

<template>
  <div class="tile">
    <span class="label-text">{{ label }}</span>
    <span class="text-base font-semibold truncate" :class="TONES[tone] || TONES.default" :title="value">{{ value }}</span>
    <span v-if="hint" class="text-xs text-slate-400 truncate">{{ hint }}</span>
  </div>
</template>
