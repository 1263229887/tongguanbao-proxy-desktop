import axios from 'axios'

// 渲染进程执行全部 HTTP：DevTools → Network 可直接看入参/返回。
// 主进程通过 IPC 把 {id,url,method,headers,body,timeoutMs} 丢过来。

function normalizeBody(body) {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  return body
}

export function initNetClient() {
  if (!window.intake?.onNetRequest) return

  window.intake.onNetRequest(async (req) => {
    const { id, url, method = 'POST', headers = {}, body, timeoutMs = 20000 } = req || {}
    try {
      const res = await axios({
        url,
        method,
        headers,
        data: normalizeBody(body),
        timeout: timeoutMs,
        // 业务成功以 body.code 为准，这里先收下非 2xx 便于 Network 查看
        validateStatus: () => true,
        transitional: { clarifyTimeoutError: true }
      })
      window.intake.sendNetResult({
        id,
        ok: true,
        status: res.status,
        statusText: res.statusText,
        data: res.data,
        headers: res.headers,
        url
      })
    } catch (e) {
      window.intake.sendNetResult({
        id,
        ok: false,
        error: e.message || String(e),
        code: e.code || '',
        url
      })
    }
  })
}
