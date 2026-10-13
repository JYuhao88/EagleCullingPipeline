export const SETTINGS = {
  performanceTurbo: ['eagle-culling-turbo', false], autoStart: ['eagle-culling-autostart', true],
  liveWriteback: ['eagle-culling-live-writeback', false], liveStar: ['eagle-culling-live-star', false],
  smartFolders: ['eagle-culling-smart-folders', true], idlePrefetch: ['eagle-culling-idle-prefetch', false]
};
export function readSetting(storage, id) {
  const [key, defaultValue] = SETTINGS[id];
  const value = storage.getItem(key);
  return defaultValue ? value !== '0' : value === '1';
}
export function writeSetting(storage, id, enabled) { storage.setItem(SETTINGS[id][0], enabled ? '1' : '0'); }
export function mountPanelSettings({ root, storage = globalThis.localStorage }) {
  const q = id => root.querySelector(`#${id}`);
  const show = name => {
    for (const id of ['panelHome', 'panelSettings', 'historyView', 'finishPanel']) if (q(id)) q(id).hidden = id !== name;
  };
  const dependencies = () => {
    for (const id of ['liveStar', 'smartFolders']) if (q(id)) q(id).disabled = !q('liveWriteback')?.checked;
  };
  for (const id of Object.keys(SETTINGS)) {
    const node = q(id); if (!node) continue;
    node.checked = readSetting(storage, id);
    node.addEventListener('change', () => { writeSetting(storage, id, node.checked); dependencies(); });
  }
  dependencies();
  q('openSettings')?.addEventListener('click', () => show('panelSettings'));
  for (const id of ['closeSettings', 'closeHistory']) q(id)?.addEventListener('click', () => show('panelHome'));
  q('allRuns')?.addEventListener('click', () => show('historyView'));
  q('settingsHelp')?.addEventListener('click', () => { show('panelHome'); q('welcome').hidden = false; });
  const missing = [];
  if (globalThis.eagle && !globalThis.eagle.smartFolder?.create) missing.push('智能文件夹需 Eagle 4.0 build22+');
  if (globalThis.eagle && !globalThis.eagle.item?.countSelected) missing.push('选择计数使用兼容读取');
  if (globalThis.eagle && !globalThis.eagle.window?.maximize && !globalThis.eagle.window?.setSize)
    missing.push('窗口尺寸需手动调整');
  if (q('apiCapability')) q('apiCapability').textContent = missing.join('；');
  return { show };
}
