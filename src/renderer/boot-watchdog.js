// 白屏看门狗：断网/缓存损坏时模块请求可能永久挂起或启动异常，#app 一直为空。
// 10s 后仍未挂载就给出可见提示与重载入口；应用晚于提示挂载时自动撤掉提示。
const BOOT_TIMEOUT_MS = 10000
const CHECK_INTERVAL_MS = 1500

let tip = null
let startedAt = Date.now()

function mounted() {
  const el = document.getElementById('app')
  return !!(el && el.childElementCount > 0)
}

function removeTip() {
  tip?.remove()
  tip = null
}

function showTip() {
  const box = document.createElement('div')
  box.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:#f3f5f8;color:#475569;font:14px/1.8 system-ui,"Microsoft YaHei",sans-serif;text-align:center'
  )
  box.innerHTML =
    '<div><div style="margin-bottom:12px">界面加载异常，未能正常启动</div>' +
    '<button id="__boot_retry" type="button" style="padding:6px 22px;border:1px solid #cbd5e1;border-radius:6px;' +
    'background:#fff;color:#334155;font-size:13px;cursor:pointer">重新加载</button>' +
    '<div style="margin-top:10px;font-size:12px;color:#94a3b8">仍无法进入请重启程序</div></div>'
  document.body.appendChild(box)
  box.querySelector('#__boot_retry').addEventListener('click', () => location.reload())
  tip = box
  console.error('[boot-watchdog] #app 超时未挂载，已显示兜底提示')
}

setInterval(() => {
  if (mounted()) {
    removeTip()
    return
  }
  if (!tip && Date.now() - startedAt >= BOOT_TIMEOUT_MS) showTip()
}, CHECK_INTERVAL_MS)
