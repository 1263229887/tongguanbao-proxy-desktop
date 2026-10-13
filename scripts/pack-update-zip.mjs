// 把 release/<env>/win-x64 下 electron-builder 的安装产物压成可直接上传的 zip（文件平铺）。
// 产物固定为：xxx-Setup-<version>.exe / .exe.blockmap / latest.yml。
// 用法：node scripts/pack-update-zip.mjs <test|prod>
// 打完用开发模式左下角「更新包上传」选择该 zip 投放即可。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const env = process.argv[2]
if (!['test', 'prod'].includes(env)) {
  console.error('用法：node scripts/pack-update-zip.mjs <test|prod>')
  process.exit(1)
}

const srcDir = path.join(ROOT, 'release', env, 'win-x64')
if (!fs.existsSync(srcDir)) {
  console.error(`未找到 ${path.relative(ROOT, srcDir)}，请先执行 pnpm dist:${env}:win`)
  process.exit(1)
}

const latestYml = path.join(srcDir, 'latest.yml')
if (!fs.existsSync(latestYml)) {
  console.error('目录里没有 latest.yml，请确认是 electron-builder 的原始产物目录')
  process.exit(1)
}

const yml = fs.readFileSync(latestYml, 'utf8')
const version = yml.match(/^version:\s*(.+)$/m)?.[1]?.trim()
if (!version) {
  console.error('无法从 latest.yml 解析 version')
  process.exit(1)
}

const files = fs.readdirSync(srcDir).filter((n) => /^\S+\.exe$/.test(n) || /^\S+\.exe\.blockmap$/.test(n) || n === 'latest.yml')
// yml 里引用的文件必须都在，缺了投上去客户端也装不了
for (const m of yml.matchAll(/^\s*-\s*url:\s*(\S+)$/gm)) {
  if (!files.includes(m[1])) {
    console.error(`latest.yml 引用的 ${m[1]} 不在产物目录，请重新打包`)
    process.exit(1)
  }
}
if (!files.some((n) => n.endsWith('.exe')) || files.length < 3) {
  console.error(`产物不完整（应有 exe / exe.blockmap / latest.yml），实际：${files.join(', ')}`)
  process.exit(1)
}

if (version === '0.1.0') {
  console.warn('⚠ 当前版本号还是 0.1.0：客户端按版本号判断更新，发布前请先提升 package.json 的 version')
}

const outDir = path.join(ROOT, 'release', 'update-zip', env)
fs.mkdirSync(outDir, { recursive: true })
// 每次生成前清掉该环境目录里的旧 zip，避免本地越积越多（build.mjs 打包时也会清整个 release/）
for (const old of fs.readdirSync(outDir)) {
  if (old.endsWith('.zip')) fs.rmSync(path.join(outDir, old), { force: true })
}
// 固定 zip 名：每次同名覆盖（安装包文件名本身也不带版本号，服务端同名覆盖、不留历史）
const outZip = path.join(outDir, 'update.zip')
fs.rmSync(outZip, { force: true })

// Compress-Archive 传文件列表时 entry 平铺在 zip 根，符合投放约定
const list = files.map((n) => `'${path.join(srcDir, n)}'`).join(',')
const cmd = `Compress-Archive -Path ${list} -DestinationPath '${outZip}' -Force`
const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit', shell: false })
if (res.status !== 0 || !fs.existsSync(outZip)) {
  console.error('压缩失败：需要 Windows PowerShell 5+（Compress-Archive）')
  process.exit(1)
}

console.log(`\n已生成 ${path.relative(ROOT, outZip)}（${files.length} 个文件，版本 ${version}）`)
console.log('下一步：pnpm dev 启动应用 → 左下角「更新包上传」→ 选择该 zip → 开始上传\n')
