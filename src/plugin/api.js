export function createApi(base) {
  const root = base.replace(/\/$/, "");
  const request = async function request(path, options = {}) {
    const response = await fetch(`${root}${path}`, options);
    let body = null;
    try { body = await response.json(); } catch { body = await response.text(); }
    if (!response.ok) throw new Error(body?.error || response.statusText);
    return body;
  };
  request.base = root;
  return request;
}

export async function eagleContext() {
  const eagleApi = globalThis.eagle;
  if (!eagleApi) return { libraryPath: "", itemIds: [] };
  return {
    libraryPath: eagleApi.library?.path || "",
    itemIds: eagleApi.item?.getSelected ? (await eagleApi.item.getSelected()).map(item => item.id || item) : []
  };
}

export function isEagleEnvironment() {
  return Boolean(globalThis.eagle?.library);
}
