import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readLibraryItem } from '../core/library-catalog.js';
import { readFocusPoints } from '../core/focus-points.js';
import { CORS_HEADERS, json } from './http.js';
import { displayImage } from './runs-routes.js';
import { itemAdjustments, saveItemAdjustments, validateAdjustments } from './adjustments-routes.js';

// The detail view and adjustments for a photo that has not been analyzed: everything comes from the Eagle library
// folder, nothing from an analysis. Display files share the display cache, so the cache budget trims them.
export function createItemMediaRouter({ runStore, cacheRoot, readBody }) {
  const displayRoot = libraryPath => path.join(cacheRoot || path.join(runStore.root, 'cache'), 'display', 'items',
    createHash('sha256').update(libraryPath).digest('hex').slice(0, 16));

  return async function route(req, res, url) {
    const match = url.pathname.match(/^\/items\/([^/]+)\/(display|focus-points|adjustments)$/);
    if (!match) return false;
    const libraryPath = url.searchParams.get('libraryPath') || '';
    if (!/\.library[\\/]?$/.test(libraryPath)) return json(res, 400, { error: '需要 Eagle 资源库路径' });
    const itemId = match[1], kind = match[2];
    if (!/^[A-Za-z0-9]{1,64}$/.test(itemId)) return json(res, 400, { error: 'invalid item id' });
    if (kind === 'adjustments') {
      if (!runStore.root) return json(res, 404, { error: 'adjustments unavailable' });
      if (req.method === 'GET') return json(res, 200, await itemAdjustments(runStore.root, libraryPath, [itemId]));
      if (req.method !== 'PUT') return false;
      let value;
      try { value = validateAdjustments(await readBody(req)); } catch (error) { return json(res, 400, { error: error.message }); }
      return json(res, 200, await saveItemAdjustments(runStore.root, libraryPath, itemId, value));
    }
    if (req.method !== 'GET') return false;
    const item = await readLibraryItem(libraryPath, itemId);
    if (!item) return json(res, 404, { error: 'item not found' });
    if (kind === 'focus-points') {
      const size = { width: Number(item.width) || null, height: Number(item.height) || null };
      try { return json(res, 200, { ...await readFocusPoints(item.filePath), ...size }); }
      catch { return json(res, 200, { source: null, areas: [], ...size }); }
    }
    // The file's modification time is part of the name, so an edited original gets a new display image.
    const unitId = `${item.id}-${Math.floor(item.mtimeMs).toString(36)}`;
    const state = { units: [{ id: unitId, primaryItemId: item.id, itemIds: [item.id] }], items: [item],
      results: [{ unitId, previewPath: item.thumbnailPath || undefined }] };
    try {
      const result = await displayImage({ dir: () => displayRoot(libraryPath) }, 'item', unitId, state,
        Number(url.searchParams.get('edge')));
      if (!result) return json(res, 404, { error: 'display not found' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300',
        'x-display-source': result.source, 'x-display-edge': String(result.edge),
        'access-control-expose-headers': 'x-display-source, x-display-edge', ...CORS_HEADERS });
      return res.end(await readFile(result.path));
    } catch { return json(res, 404, { error: 'display not found' }); }
  };
}
