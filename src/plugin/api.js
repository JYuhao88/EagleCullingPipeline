import { STAR_HEADER, applyEagleStars, starSyncEnabled } from './star-sync.js';

export function createApi(base, storage = globalThis.localStorage) {
  const root = base.replace(/\/$/, "");
  const request = async function request(path, options = {}) {
    if (options.method === 'POST' && starSyncEnabled(storage)) {
      options = { ...options, headers: { ...options.headers, [STAR_HEADER]: '1' } };
    }
    const response = await fetch(`${root}${path}`, options);
    let body = null;
    try { body = await response.json(); } catch { body = await response.text(); }
    if (!response.ok) {
      const error = new Error(body?.error || response.statusText);
      error.status = response.status; error.body = body; throw error;
    }
    if (body?.eagleStars?.length) {
      const warning = await applyEagleStars(globalThis.eagle, body.eagleStars);
      if (warning) body.starWarning = warning;
    }
    return body;
  };
  request.base = root;
  return request;
}

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('读取 Eagle 选择超时，请先减少选中数量并重试。')), 10000);
  })]); } finally { clearTimeout(timer); }
}
export async function eagleContext({ includeFolderItems = false, selected = true, lightweight = false } = {}) {
  const eagleApi = globalThis.eagle;
  if (!eagleApi) return { libraryPath: "", itemIds: [], folders: [], libraryName: "浏览器预览" };
  const library = eagleApi.library;
  const selectionCount = selected && lightweight && eagleApi.item?.countSelected
    ? await bounded(eagleApi.item.countSelected()) : null;
  const items = selected && selectionCount === null && eagleApi.item?.getSelected ? await bounded(eagleApi.item.getSelected()) : [];
  const folders = selected && eagleApi.folder?.getSelected ? await bounded(eagleApi.folder.getSelected()) : [];
  const folderItems = includeFolderItems && folders.length && eagleApi.item?.get
    ? await bounded(eagleApi.item.get({ folders: folders.map(folder => folder.id) })) : [];
  return {
    libraryPath: library?.path || "",
    libraryName: library?.name || library?.path?.split(/[\\/]/).pop() || "当前资源库",
    libraryCount: selected && eagleApi.item?.countAll ? await bounded(eagleApi.item.countAll()) : null,
    folderCount: folders.length && eagleApi.item?.count ? await bounded(eagleApi.item.count({ folders: folders.map(folder => folder.id) }))
      : folderItems.length,
    selectionCount: selectionCount ?? items.length, itemIds: items.map(item => item.id || item), folders,
    folderItemIds: folderItems.map(item => item.id || item)
  };
}

export function isEagleEnvironment() {
  return Boolean(globalThis.eagle?.library);
}

const fallbackBase = 'http://127.0.0.1:43125';
export async function resolveBase({ locationRef = globalThis.location,
  storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const origin = locationRef?.protocol === 'http:' ? locationRef.origin : '';
  if (origin && typeof fetchImpl === 'function') {
    try {
      const response = await fetchImpl(`${origin}/health`);
      const body = await response.json();
      if (response.ok && body.service === 'eagle-culling') return origin;
    } catch {
      // The plugin may be served by a static web server.
    }
  }
  return storage?.getItem('eagle-culling-base') || fallbackBase;
}
