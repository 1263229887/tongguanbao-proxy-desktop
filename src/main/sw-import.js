import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SW_FORM_TO_BIZ } from '../shared/biz-types.js'

function attr(text, name) {
  const m = text.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1].trim() : ''
}

function parseSubFormSettings(xml) {
  const rows = []
  const re = /<SubFormSetting\b([^>]*?)\/?>/gi
  let m
  while ((m = re.exec(xml))) {
    const a = m[1]
    const formId = attr(a, 'FormId')
    if (!formId) continue
    rows.push({
      formId: formId.toUpperCase(),
      outBox: attr(a, 'OutBox'),
      inBox: attr(a, 'InBox'),
      sentBox: attr(a, 'SentBox'),
      failBox: attr(a, 'FailBox'),
      maxConcurrentTasks: Number(attr(a, 'MaxDegreeOfParallelism')) || 0
    })
  }
  return rows
}

async function existsFile(p) {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

async function pushIfFile(list, p) {
  if (await existsFile(p)) list.push(p)
}

async function findDfwCandidates(basePath) {
  const candidates = []
  const home = os.homedir()
  const fixed = [
    path.join(home, 'AppData', 'Local', 'SIC', 'UserSetting', 'DFWJobSettings.xml'),
    path.join(home, 'AppData', 'Roaming', 'SIC', 'UserSetting', 'DFWJobSettings.xml')
  ]
  for (const p of fixed) await pushIfFile(candidates, p)

  // ClickOnce 部署目录里也常有模板/副本
  const clickOnceRoot = path.join(home, 'AppData', 'Local', 'Apps', '2.0')
  try {
    const shells = await fs.readdir(clickOnceRoot, { withFileTypes: true })
    for (const s of shells) {
      if (!s.isDirectory()) continue
      const shellPath = path.join(clickOnceRoot, s.name)
      let hashes
      try {
        hashes = await fs.readdir(shellPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const h of hashes) {
        if (!h.isDirectory()) continue
        const base = path.join(shellPath, h.name)
        await pushIfFile(candidates, path.join(base, 'modules', 'BatchImport', 'config', 'DFWJobSettings.xml'))
        await pushIfFile(candidates, path.join(base, 'UserSetting', 'DFWJobSettings.xml'))
        try {
          const vers = await fs.readdir(base, { withFileTypes: true })
          for (const v of vers) {
            if (!v.isDirectory()) continue
            await pushIfFile(candidates, path.join(base, v.name, 'modules', 'BatchImport', 'config', 'DFWJobSettings.xml'))
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  const roots = []
  if (String(basePath || '').trim()) roots.push(path.resolve(String(basePath).trim()))

  for (const root of roots) {
    let rootStat
    try {
      rootStat = await fs.stat(root)
    } catch {
      continue
    }
    if (!rootStat.isDirectory()) continue
    const direct = [
      path.join(root, 'DFWJobSettings.xml'),
      path.join(root, 'UserSetting', 'DFWJobSettings.xml'),
      path.join(root, 'SIC', 'UserSetting', 'DFWJobSettings.xml'),
      path.join(root, 'modules', 'BatchImport', 'config', 'DFWJobSettings.xml')
    ]
    for (const p of direct) await pushIfFile(candidates, p)

    const stack = [{ dir: root, depth: 0 }]
    while (stack.length) {
      const { dir, depth } = stack.pop()
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        if (ent.isFile() && ent.name.toLowerCase() === 'dfwjobsettings.xml') {
          candidates.push(full)
          continue
        }
        if (ent.isDirectory() && depth < 5 && !ent.name.startsWith('.') && ent.name.toLowerCase() !== 'node_modules') {
          stack.push({ dir: full, depth: depth + 1 })
        }
      }
    }
  }

  const uniq = [...new Set(candidates.map((p) => path.normalize(p)))]
  const scored = []
  for (const p of uniq) {
    try {
      const st = await fs.stat(p)
      scored.push({ path: p, mtime: st.mtimeMs })
    } catch {
      // ignore
    }
  }
  scored.sort((a, b) => b.mtime - a.mtime)
  return scored.map((x) => x.path)
}

export async function importSwBizDirs(basePath) {
  try {
    const files = await findDfwCandidates(basePath)
    if (!files.length) {
      return {
        ok: false,
        reason: '未找到 DFWJobSettings.xml。请确认已安装并启动过中国国际贸易单一窗口导入客户端，并在其目录/任务管理里配置过业务目录；安装文件夹可选填，也可留空读取本机 SIC 用户配置。',
        source: null,
        candidates: [],
        mapped: {},
        matchedFormIds: [],
        unmatchedFormIds: []
      }
    }

    let lastError = null
    for (const file of files) {
      try {
        const xml = await fs.readFile(file, 'utf8')
        const rows = parseSubFormSettings(xml)
        const mapped = {}
        const matchedFormIds = []
        const unmatchedFormIds = []
        for (const row of rows) {
          const bizId = SW_FORM_TO_BIZ[row.formId]
          if (!bizId) {
            unmatchedFormIds.push(row.formId)
            continue
          }
          matchedFormIds.push(row.formId)
          const next = {
            outBox: row.outBox,
            inBox: row.inBox,
            sentBox: row.sentBox,
            failBox: row.failBox,
            maxConcurrentTasks: row.maxConcurrentTasks > 0 ? row.maxConcurrentTasks : 1
          }
          const prev = mapped[bizId]
          if (!prev) {
            mapped[bizId] = next
            continue
          }
          const filled = (e) => [e.outBox, e.sentBox, e.inBox, e.failBox].filter(Boolean).length
          if (filled(next) > filled(prev)) mapped[bizId] = next
        }

        if (!Object.keys(mapped).length) {
          lastError = `已读到 ${file}，但没有可映射到本软件的业务目录（解析到 ${rows.length} 条，未映射：${[...new Set(unmatchedFormIds)].join('、') || '无'}）`
          continue
        }

        return {
          ok: true,
          reason: null,
          source: file,
          candidates: files,
          mapped,
          matchedFormIds,
          unmatchedFormIds: [...new Set(unmatchedFormIds)]
        }
      } catch (e) {
        lastError = `读取 ${file} 失败：${e.message}`
      }
    }

    return {
      ok: false,
      reason: lastError || '导入失败，未能解析到业务目录配置',
      source: files[0] ?? null,
      candidates: files,
      mapped: {},
      matchedFormIds: [],
      unmatchedFormIds: []
    }
  } catch (e) {
    return {
      ok: false,
      reason: `导入异常：${e.message}`,
      source: null,
      candidates: [],
      mapped: {},
      matchedFormIds: [],
      unmatchedFormIds: []
    }
  }
}
