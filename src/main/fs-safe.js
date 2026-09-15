import fs from 'node:fs/promises'
import path from 'node:path'

// 先写同名 .part 再 rename：同目录 rename 原子，避免同机其他程序读到写了一半的文件。
export async function atomicWrite(dir, name, data) {
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `${name}.part`)
  const final = path.join(dir, name)
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, final)
  return final
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}
