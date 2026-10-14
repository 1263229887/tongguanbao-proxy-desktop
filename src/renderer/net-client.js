import axios from 'axios'

// 渲染进程执行全部 HTTP：DevTools → Network 可直接看入参/返回。
// 主进程通过 IPC 把 {id,url,method,headers,body,timeoutMs} 丢过来。

function normalizeBody(body) {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  return body
}

/**
 * 主进程把日志文件的字节通过 IPC 结构化克隆过来（Uint8Array），在这里现组成 FormData。
 * FormData/Blob 本身过不了 IPC，所以只能拆成「字节 + 字段元数据」传输。
 * Content-Type 不用管：axios 在浏览器环境遇到 FormData 会主动清掉它，交给 XHR 生成带 boundary 的头。
 */
function buildFormData({ fields, file }) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields || {})) {
    form.append(key, value == null ? '' : String(value))
  }
  if (file) {
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || [])
    const blob = new Blob([bytes], { type: file.contentType || 'application/octet-stream' })
    form.append(file.field || 'file', blob, file.name)
  }
  return form
}

export function initNetClient() {
  if (!window.intake?.onNetRequest) return

  window.intake.onNetRequest(async (req) => {
    const { id, url, method = 'POST', headers = {}, body, multipart, timeoutMs = 20000 } = req || {}
    try {
      const res = await axios({
        url,
        method,
        headers,
        data: multipart ? buildFormData(multipart) : normalizeBody(body),
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
