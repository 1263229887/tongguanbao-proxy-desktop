import { defineConfig, presetUno } from 'unocss'

export default defineConfig({
  presets: [presetUno()],
  theme: {
    colors: {
      brand: {
        50: '#eef6ff',
        500: '#2f6fed',
        600: '#2158c9',
        700: '#1a46a3'
      }
    }
  },
  shortcuts: {
    'panel': 'bg-white border border-slate-200 rounded-lg',
    'tile': 'panel px-4 py-3 flex flex-col gap-1',
    'label-text': 'text-xs text-slate-500 font-medium',
    'field': 'w-full h-8 px-2.5 text-sm rounded border border-slate-300 bg-white outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15',
    'btn': 'inline-flex items-center justify-center gap-1.5 h-8 px-3.5 text-sm font-medium rounded border transition-colors select-none disabled:opacity-50 disabled:pointer-events-none',
    'btn-primary': 'btn bg-brand-500 border-brand-500 text-white hover:bg-brand-600 hover:border-brand-600',
    'btn-ghost': 'btn bg-white border-slate-300 text-slate-700 hover:bg-slate-50',
    'btn-step': 'w-9 shrink-0 self-stretch flex items-center justify-center text-base leading-none text-slate-500 bg-slate-50 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 disabled:pointer-events-none',
    'nav-item': 'flex items-center gap-2.5 h-9 px-3 mx-2 rounded text-sm text-slate-600 hover:bg-slate-100 cursor-pointer select-none',
    'nav-item-active': 'nav-item bg-brand-50 text-brand-600 font-medium hover:bg-brand-50',
    'scroll-y': 'overflow-y-auto overflow-x-hidden'
  }
})
