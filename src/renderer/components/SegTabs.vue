<script setup>
defineProps({
  modelValue: { type: String, required: true },
  items: { type: Array, required: true }
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="inline-flex items-center gap-0.5 rounded-lg bg-slate-100/90 p-0.5">
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      class="h-7 px-3.5 rounded-md text-xs transition-all duration-150 select-none"
      :class="
        modelValue === item.value
          ? 'bg-white text-slate-800 font-medium shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
          : 'text-slate-500 hover:text-slate-700'
      "
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
