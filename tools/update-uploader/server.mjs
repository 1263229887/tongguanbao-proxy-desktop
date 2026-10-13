// 更新包上传工具的本地服务：bat 启动它，浏览器访问 http://127.0.0.1:5278/。
// 职责：① 托管 index.html（在线地址而非 file://）；② 提供一键打包接口
// （清理旧产物 → node scripts/build.mjs → node scripts/pack-update-zip.mjs）；
// ③ 把打好的 zip 以 HTTP 形式交给页面，页面复用既有分片上传管线投放到后端。
// 仅监听 127.0.0.1；打包命令全部走 node 直调，不依赖 pnpm/.cmd。
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PAGE = path.join(import.meta.dirname, 'index.html')
const ZIP_DIR = path.join(ROOT, 'release', 'update-zip', 'test')
const HOST = '127.0.0.1'
const PORT = 5278

let job = { running: false, ok: false, error: null, version: null, zipPath: null, zipName: null, zipSize: 0, log: [] }

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

function push(line) {
  // 去掉 electron-builder 输出里的 ANSI 控制符，页面展示干净
  job.log.push(String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
}

// 同源转发：浏览器只访问 127.0.0.1:5278，由本地服务直连更新服务器。
// 规避 Chrome 对「localhost 页面直连内网 IP」的 Local Network Access 拦截与系统代理干扰
// （此前 file:// 直连可用，换 http://127.0.0.1 后上传报 Failed to fetch 即此原因）。
function proxyApi(req, res, url) {
  const base = String(req.headers['x-target-base'] || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    sendJson(res, 400, { code: -1, msg: '缺少有效的 x-target-base 请求头' })
    return
  }
  let target
  try {
    target = new URL(base + url.pathname.replace(/^\/api\/proxy/, '') + url.search)
  } catch (e) {
    sendJson(res, 400, { code: -1, msg: '目标地址无效：' + e.message })
    return
  }
  const mod = target.protocol === 'https:' ? https : http
  const fwd = {}
  for (const h of ['content-type', 'x-update-token', 'content-length']) {
    if (req.headers[h] != null) fwd[h] = req.headers[h]
  }
  const up = mod.request(target, { method: req.method, headers: fwd }, (upRes) => {
    const chunks = []
    upRes.on('data', (c) => chunks.push(c))
    upRes.on('end', () => {
      if (res.writableEnded) return
      res.writeHead(upRes.statusCode || 502, {
        'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end(Buffer.concat(chunks))
    })
    upRes.on('error', () => {
      if (!res.writableEnded) sendJson(res, 502, { code: -1, msg: '更新服务器响应异常' })
    })
  })
  // complete（合并/解压/投放）可能耗时数分钟
  up.setTimeout(10 * 60 * 1000, () => up.destroy(new Error('连接更新服务器超时')))
  up.on('error', (e) => {
    if (!res.writableEnded) sendJson(res, 502, { code: -1, msg: '本地服务无法连接更新服务器：' + e.message })
  })
  req.on('error', () => up.destroy())
  req.pipe(up)
}

/** 一键打包：清理旧产物 → build → zip。版本号由开发者自行在 package.json 管理，工具不做自动提升 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    push(`$ ${path.basename(cmd)} ${args.join(' ')}`)
    const p = spawn(cmd, args, { cwd: ROOT, shell: false, env: process.env })
    const onLine = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(push)
    p.stdout.on('data', onLine)
    p.stderr.on('data', onLine)
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 退出码 ${code}`))))
  })
}

function startBuild() {
  if (job.running) return
  job = { running: true, ok: false, error: null, version: null, zipPath: null, zipName: null, zipSize: 0, log: [] }
  ;(async () => {
    try {
      // build.mjs 自身会先清空整个 release/ 目录（旧产物、旧 zip 一并清理）
      await run(process.execPath, [path.join(ROOT, 'scripts/build.mjs'), '--env=test', '--platforms=win'])
      await run(process.execPath, [path.join(ROOT, 'scripts/pack-update-zip.mjs'), 'test'])
      if (!fs.existsSync(ZIP_DIR)) throw new Error('未生成 zip 目录，请看构建日志')
      const zips = fs
        .readdirSync(ZIP_DIR)
        .filter((n) => n.endsWith('.zip'))
        .map((n) => ({ full: path.join(ZIP_DIR, n), mtime: fs.statSync(path.join(ZIP_DIR, n)).mtimeMs }))
      if (!zips.length) throw new Error('未找到生成的 zip，请看构建日志')
      zips.sort((a, b) => b.mtime - a.mtime)
      job.zipPath = zips[0].full
      job.zipName = path.basename(job.zipPath)
      job.zipSize = fs.statSync(job.zipPath).size
      job.version = pkgVersion()
      job.ok = true
      push(`DONE ${job.zipName}（${Math.round(job.zipSize / 1024 / 1024)} MB，v${job.version}）`)
    } catch (e) {
      job.error = e.message || String(e)
      push(`ERROR ${job.error}`)
    } finally {
      job.running = false
    }
  })()
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  try {
    if (url.pathname.startsWith('/api/proxy/')) {
      return proxyApi(req, res, url)
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      fs.createReadStream(PAGE).pipe(res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/job') {
      sendJson(res, 200, { ...job, version: job.version || pkgVersion(), log: job.log })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/build') {
      if (job.running) {
        sendJson(res, 409, { started: false, reason: '已有构建任务在跑，请等它结束' })
        return
      }
      startBuild()
      sendJson(res, 200, { started: true })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/zip-file') {
      if (!job.zipPath || !fs.existsSync(job.zipPath)) {
        sendJson(res, 404, { error: '暂无打包产物，请先执行一键打包' })
        return
      }
      const size = fs.statSync(job.zipPath).size
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(job.zipName)}"`,
        'Cache-Control': 'no-store'
      })
      fs.createReadStream(job.zipPath).pipe(res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end()
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    sendJson(res, 500, { error: e.message })
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用：服务可能已在运行，直接访问 http://${HOST}:${PORT}/ 即可`)
    process.exit(0)
  }
  console.error('服务异常：', e.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`更新包上传工具服务已启动：http://${HOST}:${PORT}/  （Ctrl+C 退出）`)
})
