export const SETTINGS = {
  performanceTurbo: ['eagle-culling-turbo', false], autoStart: ['eagle-culling-autostart', true],
  useAiTags: ['eagle-culling-ai-tags', false], liveWriteback: ['eagle-culling-live-writeback', false],
  idlePrefetch: ['eagle-culling-idle-prefetch', false]
};
export function readSetting(storage, id) {
  const [key, defaultValue] = SETTINGS[id];
  const value = storage.getItem(key);
  return defaultValue ? value !== '0' : value === '1';
}
export function writeSetting(storage, id, enabled) { storage.setItem(SETTINGS[id][0], enabled ? '1' : '0'); }
export function mountPanelSettings({ root, storage = globalThis.localStorage, onShow = () => {} }) {
  const q = id => root.querySelector(`#${id}`);
  const show = name => {
    for (const id of ['panelHome', 'panelSettings', 'historyView', 'finishPanel', 'libraryView']) if (q(id)) q(id).hidden = id !== name;
    onShow(name);
  };
  const dependencies = () => {
    if (q('aiTagOptions')) q('aiTagOptions').hidden = !q('useAiTags')?.checked;
  };
  for (const id of Object.keys(SETTINGS)) {
    const node = q(id); if (!node) continue;
    node.checked = readSetting(storage, id);
    node.addEventListener('change', () => { writeSetting(storage, id, node.checked); dependencies(); });
  }
  dependencies();
  q('openSettings')?.addEventListener('click', () => show('panelSettings'));
  q('closeSettings')?.addEventListener('click', () => show('panelHome'));
  q('closeHistory')?.addEventListener('click', () => show('panelSettings'));
  q('allRuns')?.addEventListener('click', () => show('historyView'));
  const missing = [];
  if (globalThis.eagle && !globalThis.eagle.item?.countSelected) missing.push('选择计数使用兼容读取');
  if (globalThis.eagle && !globalThis.eagle.window?.maximize && !globalThis.eagle.window?.setSize)
    missing.push('窗口尺寸需手动调整');
  if (q('apiCapability')) q('apiCapability').textContent = missing.join('；');
  return { show };
}
