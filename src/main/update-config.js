// 在线更新服务器（对接文档《前置机在线更新投放对接文档》§8）。
// base 即后端服务根（测试环境是 http://192.168.200.1:48080，生产环境走对外域名反代）：
//   客户端 feed   = {base}/agent-update/
//   投放上传接口 = {base}/admin-api/declaration/agent-update
// 生产域名如有变化，只需改这里的 prod.base。
export const UPDATE_SERVERS = {
  test: {
    base: 'http://192.168.200.1:48080'
  },
  prod: {
    base: 'https://www.danaai.net/astongai'
  }
}

export function updateServerFor(env) {
  return UPDATE_SERVERS[env] ?? UPDATE_SERVERS.test
}

export function feedUrlFor(env) {
  return `${updateServerFor(env).base}/agent-update/`
}

export function uploadApiFor(env) {
  return `${updateServerFor(env).base}/admin-api/declaration/agent-update`
}
