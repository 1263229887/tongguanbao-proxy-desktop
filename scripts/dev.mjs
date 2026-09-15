import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import electronPath from 'electron'

const PORT = 5273
const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  server: { port: PORT, strictPort: true }
})
await server.listen()

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${PORT}` }
})

child.on('exit', (code) => {
  server.close().finally(() => process.exit(code ?? 0))
})
