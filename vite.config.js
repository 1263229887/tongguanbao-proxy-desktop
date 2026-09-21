import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

const rendererPort = 5273

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    UnoCSS(),
    // Element Plus 按需引入：只打包用到的组件与样式
    AutoImport({
      imports: [],
      resolvers: [ElementPlusResolver()],
      dts: false,
      eslintrc: { enabled: false }
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: false
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: rendererPort,
    strictPort: true
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: true,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'vue-vendor', test: /node_modules\/(?:@vue|vue)/, priority: 20 }]
        }
      }
    }
  }
})
