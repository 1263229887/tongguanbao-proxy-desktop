// 业务类型目录配置的共用目录表：大标题 + 小标题（多数相同，货物申报/报关单暂存不同）
export const BUSINESS_TYPES = [
  { id: 'default', title: '默认', subtitle: '默认' },
  { id: 'agency', title: '报关代理委托申报', subtitle: '报关代理委托申报' },
  { id: 'ecImport', title: '跨境电商进口', subtitle: '跨境电商进口' },
  { id: 'ecExport', title: '跨境电商出口', subtitle: '跨境电商出口' },
  { id: 'goods', title: '货物申报', subtitle: '报关单暂存' },
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
