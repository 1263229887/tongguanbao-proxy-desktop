// DEC 与 CEB 两个接口族共用同一把企业密钥、同一个后端通道，连接级事实必须共享：
// 鉴权失败/通道关闭对两族同时生效，时钟偏移（租约判断）也由统一心跳校准。
// 写入方：agent.js（心跳/拉取/回执）与 ceb-agent.js（拉取/回执）；读取方：两个引擎的轮询门禁与租约判断。
// 不放 UI 状态——各引擎自己的 state 仍各自广播，这里只放跨引擎的连接级事实。

const link = {
  clockOffsetMs: 0,
  authFailed: false,
  channelClosed: false
}

export function setLinkPatch(patch) {
  if (patch && typeof patch === 'object') Object.assign(link, patch)
}

export function getLink() {
  return link
}

/** 用服务器时间校准后的当前时间（心跳未建立时偏移为 0，退化为本机时间） */
export function nowWithOffset() {
  return Date.now() + (link.clockOffsetMs || 0)
}