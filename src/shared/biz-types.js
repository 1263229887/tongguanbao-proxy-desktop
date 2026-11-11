// 业务类型目录配置的共用目录表：大标题 + 小标题（多数相同，货物申报/报关单暂存不同）
// channelBased=true 的业务不用 bizDirs 四目录，改用渠道列表（cebChannels）：每个渠道一套自己的客户端收发目录
export const BUSINESS_TYPES = [
  { id: 'default', title: '默认', subtitle: '默认' },
  { id: 'agency', title: '报关代理委托申报', subtitle: '报关代理委托申报' },
  { id: 'ecImport', title: '跨境电商进口', subtitle: '跨境电商进口' },
  { id: 'ecExport', title: '跨境电商出口', subtitle: '跨境电商出口' },
  { id: 'goods', title: '货物申报', subtitle: '报关单暂存' },
  { id: 'ceb', title: '跨境电商申报', subtitle: '9610 清单 / 9710·9810 前置申报', channelBased: true },
  { id: 'manifest', title: '海运/空运舱单申报', subtitle: '海运/空运舱单申报' },
  { id: 'amend', title: '报关单修撤', subtitle: '报关单修撤' }
]

export const DIR_FIELDS = [
  { key: 'outBox', label: '待发送文件目录', short: '待发送' },
  { key: 'sentBox', label: '发送完毕的文件', short: '已发送' },
  { key: 'inBox', label: '回执 / 异常情况说明文件', short: '回执' },
  { key: 'failBox', label: '服务器端校验失败文件', short: '校验失败' }
]

// 单一窗口导入客户端 DFWJobSettings.xml 里的 FormId → 本软件业务类型
// 只映射本软件已有的业务；对方多出来的 FormId 不会导入
export const SW_FORM_TO_BIZ = {
  OTHERS: 'default',
  ACD: 'agency',
  IMPCEB: 'ecImport',
  EXPCEB: 'ecExport',
  DECCUS001: 'goods',
  MFT: 'manifest',
  DECCUS102: 'amend'
}

export function emptyBizDir() {
  return { outBox: '', sentBox: '', inBox: '', failBox: '', maxConcurrentTasks: 3 }
}

export function countFilledDirs(entry) {
  if (!entry) return 0
  return DIR_FIELDS.filter((d) => entry[d.key]).length
}

// ---------- 跨境电商（CEB）渠道 ----------
// 路由是后端协议标识（CB-AGENT-01），决定领哪条队列；渠道是本地投递去向，
// 每个渠道对应现场一个独立的传输客户端（如深圳公服客户端），各有自己的收发目录。
// 任务归属渠道按报文 BaseTransfer.dxpId 匹配；dxpId 留空的渠道作为该路由的兜底目录。
export const CEB_ROUTES = [
  { id: 'SZ_PUBLIC_DIRECT', label: '直报（公服客户端）', messageTypes: ['CEB303', 'CEB505', 'CEB603'] },
  { id: 'SW_INVENTORY_TEMP', label: '清单暂存单一（单一窗口清单模块）', messageTypes: ['CEB603'] }
]

export const CEB_ROUTE_IDS = CEB_ROUTES.map((r) => r.id)

export const CEB_TRADE_MODES = ['9610', '9710', '9810']

// 渠道目录字段：发送/接收必填（引擎要用），备份/失败选填（深圳公服客户端的 Bak/Err，供现场核对投递证据）
export const CEB_DIR_FIELDS = [
  { key: 'sendDir', label: '发送目录', short: '发送', required: true },
  { key: 'receiveDir', label: '接收目录（回执）', short: '接收', required: true },
  { key: 'bakDir', label: '备份目录（选填）', short: '备份', required: false },
  { key: 'errDir', label: '失败目录（选填）', short: '失败', required: false }
]

export function emptyCebChannel() {
  return { id: '', name: '', route: 'SZ_PUBLIC_DIRECT', dxpId: '', sendDir: '', receiveDir: '', bakDir: '', errDir: '', enabled: true }
}

/** 渠道是否可投递：启用且发送目录已配（接收目录只影响回执上传，不阻塞投递） */
export function cebChannelDeliverable(ch) {
  return !!(ch && ch.enabled !== false && String(ch.sendDir || '').trim())
}

/** 渠道是否完整（启动业务/升级恢复的校验口径）：启用且发送、接收目录都已配 */
export function cebChannelReady(ch) {
  return !!(ch && ch.enabled !== false && String(ch.sendDir || '').trim() && String(ch.receiveDir || '').trim())
}
