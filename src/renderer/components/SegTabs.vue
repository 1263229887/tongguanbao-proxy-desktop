<script setup>
defineProps({
  modelValue: { type: String, required: true },
  items: { type: Array, required: true }
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-slate-100/90 p-0.5">
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      class="h-8 px-3.5 rounded-md text-xs transition-all duration-150 select-none inline-flex items-center gap-2 whitespace-nowrap"
      :class="
        modelValue === item.value
          ? 'bg-white text-slate-800 font-medium shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
          : 'text-slate-500 hover:text-slate-700'
      "
      :title="item.title"
      @click="emit('update:modelValue', item.value)"
    >
      <span>{{ item.label }}</span>
      <span
        v-if="item.tag"
        class="shrink-0 inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border text-[10px] leading-none"
        :class="
          item.tag.tone === 'on'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'tag-closed border-rose-200 bg-rose-50 text-rose-600'
        "
      >
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="item.tag.tone === 'on' ? 'bg-emerald-500' : 'tag-dot-pulse bg-rose-500'"
        />
        {{ item.tag.text }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.tag-closed {
  animation: tagClosedGlow 3s ease-in-out infinite;
}

.tag-dot-pulse {
  position: relative;
}

.tag-dot-pulse::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 9999px;
  background: rgba(244, 63, 94, 0.45);
  animation: tagDotPulse 2.2s ease-out infinite;
}

@keyframes tagClosedGlow {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(244, 63, 94, 0);
  }
  50% {
    box-shadow: 0 0 0 2px rgba(244, 63, 94, 0.1);
  }
}

@keyframes tagDotPulse {
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
  .tag-closed,
  .tag-dot-pulse::after {
    animation: none;
  }
}
</style>
