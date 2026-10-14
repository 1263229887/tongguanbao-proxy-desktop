// 日志级别：写盘门槛（logger.js）、配置归一化（config.js）与界面下拉（ParamView）共用一份，
// 免得三处各写一遍枚举、加级别时对不上
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

export const LOG_LEVEL_OPTIONS = [
  { value: 'info', label: '标准（推荐）' },
  { value: 'debug', label: '详细（排障用，日志量明显变大）' },
  { value: 'warn', label: '只记警告与错误' },
  { value: 'error', label: '只记错误' }
]
