import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 国内网络加固：electron 运行时与 builder 二进制（nsis/winCodeSign）走 npmmirror，
// 避免 GitHub 直连抖动导致 ECONNRESET 打包失败（@electron/get 与 electron-builder 都认这几个环境变量）
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = path.join(ROOT, 'release')

const PLATFORMS = {
  win: { args: ['--win', '--x64'], dir: 'win-x64' },
  mac: { args: ['--mac', '--arm64'], dir: 'mac-arm64' }
}

// 在线更新 feed（对接文档 §8），按环境写进包内 app-update.yml；
// 运行时 updater.js 仍会 setFeedURL 按 appEnv 兜底覆盖
const UPDATE_FEED = {
  test: 'http://192.168.200.1:48080/agent-update/',
  prod: 'https://www.danaai.net/astongai/agent-update/'
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
  // shell:false，避免路径空格（如 Xiaomi MiMo）被拆开
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  return !res.error && !res.status
}

// 优先用显式 Node 可执行文件；避免 process.execPath 指向宿主 GUI
function nodeExe() {
  return process.env.MIMO_NODE || process.execPath
}

function toolCmd(kind) {
  const candidates =
    kind === 'vite'
      ? [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')]
      : [path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli.js'), path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')]
  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: nodeExe(), args: [c] }
  }
  return { cmd: 'npx', args: [] }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 杀软常对刚产出的 exe 持有扫描句柄，目录级改名偶发 EPERM/EBUSY：退避重试
async function renameRetry(from, to, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (i === tries) throw e
      console.log(`  目录改名被占用（${e.code}），${i * 1.5}s 后重试 ${i}/${tries - 1}…`)
      await sleep(i * 1500)
    }
  }
}

const argv = process.argv.slice(2)
const { env, platforms, dryRun } = parse(argv)
const startedAt = Date.now()

console.log(`\n打包开始 · 环境=${env} · 平台=${platforms.join(', ')}${dryRun ? ' · dry-run（不执行、不删除）' : ''}\n`)

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
if (pkgVersion === '0.1.0') {
  console.log('⚠ 当前 package.json version 还是 0.1.0：客户端按版本号判断更新，正式发版前请先提升版本号\n')
}

cleanOutRoot(dryRun)

console.log('\n[1] 构建渲染层')
{
  const t = toolCmd('vite')
  if (!run(t.cmd, [...t.args, 'build'], { dryRun })) fail('渲染层构建失败')
}

for (const [i, key] of platforms.entries()) {
  const target = PLATFORMS[key]
  const finalDir = path.join(OUT_ROOT, env, target.dir)
  const tmpDir = path.join(OUT_ROOT, '.tmp', target.dir)

  console.log(`\n[${i + 2}] 打包 ${key}（${env}）`)
  if (!dryRun) fs.rmSync(tmpDir, { recursive: true, force: true })

  if (dryRun) {
    console.log(`  (dry-run) electron-builder ${target.args.join(' ')} → ${path.relative(ROOT, tmpDir)}`)
    continue
  }

  // 走 Node API，避免 CLI/yargs 在精简 Node 环境下把脚本路径当成参数。
  // 网络抖动（下载 electron zip 等被重置）自动重试一次；重试前清掉半成品临时目录
  const eb = await import('electron-builder')
  const { build, Platform, Arch } = eb
  const targets =
    key === 'win'
      ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64)
      : Platform.MAC.createTarget(['dmg'], Arch.arm64)
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!dryRun) fs.rmSync(tmpDir, { recursive: true, force: true })
    try {
      await build({
        targets,
        // publish 选项是「是否执行发布动作」的策略：本地构建永不发布；
        // config.publish 只用于生成包内 app-update.yml（electron-updater 下载缓存目录依赖它）
        publish: 'never',
        config: {
          directories: { output: tmpDir },
          extraMetadata: { appEnv: env },
          publish: { provider: 'generic', url: UPDATE_FEED[env] ?? UPDATE_FEED.test, useMultipleRangeRequest: false }
        }
      })
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (attempt < 2) {
        console.log(`  打包第 ${attempt} 次失败（${String(e.message || e).split('\n')[0]}），3 秒后自动重试…`)
        await sleep(3000)
      }
    }
  }
  if (lastErr) {
    console.error(lastErr)
    fail(`${key} 打包失败`)
  }

  if (!fs.existsSync(tmpDir)) fail(`electron-builder 没有产出 ${path.relative(ROOT, tmpDir)}`)
  fs.mkdirSync(path.dirname(finalDir), { recursive: true })
  fs.rmSync(finalDir, { recursive: true, force: true })
  await renameRetry(tmpDir, finalDir)
  const items = listArtifacts(finalDir)
  console.log(`  产物 → ${path.relative(ROOT, finalDir)}/`)
  for (const item of items) console.log(`    ${item.dir ? '📁' : '·'} ${item.name}`)
}

if (!dryRun) fs.rmSync(path.join(OUT_ROOT, '.tmp'), { recursive: true, force: true })

console.log(`\n打包完成 · 总耗时 ${elapsed(Date.now() - startedAt)}\n`)
