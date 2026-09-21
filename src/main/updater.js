// 在线更新暂未接入，且不走 GitHub Releases。
// 保留查询接口，避免渲染层调用报错；实际不发起网络检查。

const update = { status: 'disabled', version: null, note: '在线更新暂未接入，请使用安装包升级' }

export function onUpdateState() {}

export function getUpdateState() {
  return { ...update }
}

export function setupUpdater() {
  // no-op：不初始化 electron-updater
}

export function checkForUpdates() {
  return { ok: false, reason: '在线更新暂未接入' }
}

export function quitAndInstall() {
  return { ok: false, reason: '在线更新暂未接入' }
}
