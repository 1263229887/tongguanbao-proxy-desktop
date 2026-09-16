import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Node ESM interop turns electron's CJS string export into {}; use require
const electronPath = createRequire(import.meta.url)('electron')

const PORT = 5273
const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  server: { port: PORT, strictPort: true }
})
await server.listen()

const childEnv = { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${PORT}` }
// Host runtimes (e.g. MiMo's bundled Node) may set this; Electron would run as plain Node
delete childEnv.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: childEnv
})

child.on('exit', (code) => {
  server.close().finally(() => process.exit(code ?? 0))
})
