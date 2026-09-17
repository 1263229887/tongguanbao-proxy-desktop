import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

// 环境标记由打包时 electron-builder 的 extraMetadata.appEnv 注入到 asar 内的 package.json。
// 读不到时按 prod 兜底：宁可少给能力，也不要把多服务器配置暴露给线上包。
function resolveEnv() {
  if (!app.isPackaged) return 'dev'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    return pkg.appEnv === 'test' ? 'test' : 'prod'
  } catch {
    return 'prod'
  }
}

export const APP_ENV = resolveEnv()

// dev 与 test 允许配置后台地址、实例名和多组服务器；prod 只允许填企业鉴权密钥
export const CAN_EDIT_SERVER = APP_ENV !== 'prod'
