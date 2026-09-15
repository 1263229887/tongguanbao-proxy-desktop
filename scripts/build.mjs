import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = path.join(ROOT, 'release')

const PLATFORMS = {
  win: { args: ['--win', '--x64'], dir: 'win-x64' },
  mac: { args: ['--mac', '--arm64'], dir: 'mac-arm64' }
}

function flag(argv, name) {
  return argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

function elapsed(ms) {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)} 秒` : `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`
}

function fail(msg) {
  console.error(`\n打包中止：${msg}\n`)
  process.exit(1)
}

function parse(argv) {
  const env = flag(argv, 'env')
  const platforms = (flag(argv, 'platforms') || '').split(',').filter(Boolean)
  if (!['test', 'prod'].includes(env)) fail(`--env 只能是 test 或 prod，收到「${env}」`)
  if (!platforms.length) fail('缺少 --platforms，可选 win / mac，逗号分隔')
  const unknown = platforms.filter((p) => !PLATFORMS[p])
  if (unknown.length) fail(`未知平台：${unknown.join(', ')}，可选：${Object.keys(PLATFORMS).join(' / ')}`)
  return { env, platforms, dryRun: argv.includes('--dry-run') }
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  if (opts.dryRun) return true
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  return !res.status
}

// 每次打包前彻底清空产物根目录，避免旧包和新包混在一起
function cleanOutRoot(dryRun) {
  if (!fs.existsSync(OUT_ROOT)) {
    console.log('产物目录不存在，跳过清理')
    return
  }
  const top = fs.readdirSync(OUT_ROOT)
  console.log(dryRun ? `将删除 ${path.relative(ROOT, OUT_ROOT)}/ 下的 ${top.length} 项：` : `已删除 ${path.relative(ROOT, OUT_ROOT)}/ 下的 ${top.length} 项：`)
  for (const name of top) {
    console.log(`  - ${name}`)
    if (!dryRun) fs.rmSync(path.join(OUT_ROOT, name), { recursive: true, force: true })
  }
}

function listArtifacts(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => {
      const full = path.join(dir, n)
      const st = fs.statSync(full)
      return { name: n, dir: st.isDirectory() }
    })
}

const argv = process.argv.slice(2)
const { env, platforms, dryRun } = parse(argv)
const startedAt = Date.now()

console.log(`\n打包开始 · 环境=${env} · 平台=${platforms.join(', ')}${dryRun ? ' · dry-run（不执行、不删除）' : ''}\n`)

cleanOutRoot(dryRun)

console.log('\n[1] 构建渲染层')
if (!run('npx', ['vite', 'build'], { dryRun })) fail('渲染层构建失败')

for (const [i, key] of platforms.entries()) {
  const target = PLATFORMS[key]
  const finalDir = path.join(OUT_ROOT, env, target.dir)
  const tmpDir = path.join(OUT_ROOT, '.tmp', target.dir)

  console.log(`\n[${i + 2}] 打包 ${key}（${env}）`)
  if (!dryRun) fs.rmSync(tmpDir, { recursive: true, force: true })
  const args = [...target.args, `--config.directories.output=${tmpDir}`, `--config.extraMetadata.appEnv=${env}`]
  if (!run('npx', ['electron-builder', ...args], { dryRun })) fail(`${key} 打包失败`)

  if (dryRun) {
    console.log(`  (dry-run) 将移动到 ${path.relative(ROOT, finalDir)}/`)
    continue
  }
  if (!fs.existsSync(tmpDir)) fail(`electron-builder 没有产出 ${path.relative(ROOT, tmpDir)}`)
  fs.mkdirSync(path.dirname(finalDir), { recursive: true })
  fs.rmSync(finalDir, { recursive: true, force: true })
  fs.renameSync(tmpDir, finalDir)
  const items = listArtifacts(finalDir)
  console.log(`  产物 → ${path.relative(ROOT, finalDir)}/`)
  for (const item of items) console.log(`    ${item.dir ? '📁' : '·'} ${item.name}`)
}

if (!dryRun) fs.rmSync(path.join(OUT_ROOT, '.tmp'), { recursive: true, force: true })

console.log(`\n打包完成 · 总耗时 ${elapsed(Date.now() - startedAt)}\n`)
