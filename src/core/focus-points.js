import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exiftoolRequest } from './exiftool-pool.js';
import { localSetting } from './local-config.js';
import { nativeChildLaunch } from './performance-mode.js';

// Where the camera says it focused, for drawing on the photo only. Analysis reads its own focus data in focus.js.
// Every box is [x0, y0, x1, y1] in 0…1 of the upright image.
const execFileAsync = promisify(execFile);

export const FOCUS_POINT_TAGS = Object.freeze(['Orientation', 'FocusLocation', 'FocusFrameSize', 'AFAreas']);

const numbers = value => Array.isArray(value) ? value.map(Number)
  : typeof value === 'string' ? (value.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
  : Number.isFinite(value) ? [value] : [];

// Sensor coordinates to the upright image for EXIF orientations 1–8.
export function orient([x, y], orientation = 1) {
  switch (Number(orientation)) {
    case 2: return [1 - x, y];
    case 3: return [1 - x, 1 - y];
    case 4: return [x, 1 - y];
    case 5: return [y, x];
    case 6: return [1 - y, x];
    case 7: return [1 - y, 1 - x];
    case 8: return [y, 1 - x];
    default: return [x, y];
  }
}

function area(cx, cy, w, h, gridWidth, gridHeight, orientation) {
  if (![cx, cy, w, h, gridWidth, gridHeight].every(Number.isFinite) || gridWidth <= 0 || gridHeight <= 0) return null;
  if (cx < 0 || cy < 0 || cx > gridWidth || cy > gridHeight) return null;
  const a = orient([(cx - w / 2) / gridWidth, (cy - h / 2) / gridHeight], orientation);
  const b = orient([(cx + w / 2) / gridWidth, (cy + h / 2) / gridHeight], orientation);
  const unit = value => Math.min(1, Math.max(0, +value.toFixed(4)));
  return [unit(Math.min(a[0], b[0])), unit(Math.min(a[1], b[1])), unit(Math.max(a[0], b[0])), unit(Math.max(a[1], b[1]))];
}

// Sony: FocusLocation is "sensorWidth sensorHeight x y", FocusFrameSize "w h valid".
// Ricoh/Pentax: AFAreas repeats "gridW gridH cx cy w h flags"; flag bit 8 marks an area in focus.
export function parseFocusPoints(tags = {}) {
  const orientation = Number(tags.Orientation) || 1, areas = [];
  const location = numbers(tags.FocusLocation);
  if (location.length >= 4 && location[0] > 0 && location[1] > 0 && (location[2] || location[3])) {
    const [width, height, x, y] = location, size = numbers(tags.FocusFrameSize);
    const valid = size.length >= 2 && size[0] > 0 && size[1] > 0 && size[2] !== 0;
    const fallback = Math.max(width, height) * 0.02;
    const box = area(x, y, valid ? size[0] : fallback, valid ? size[1] : fallback, width, height, orientation);
    if (box) areas.push({ box, kind: valid ? 'frame' : 'point', inFocus: true });
    return { source: 'sony', areas };
  }
  const values = numbers(tags.AFAreas);
  for (let i = 0; i + 7 <= values.length; i += 7) {
    const [gridWidth, gridHeight, cx, cy, w, h, flags] = values.slice(i, i + 7);
    const box = area(cx, cy, w, h, gridWidth, gridHeight, orientation);
    if (box) areas.push({ box, kind: 'frame', inFocus: (flags & 8) !== 0 });
  }
  return areas.length ? { source: 'pentax', areas } : { source: null, areas };
}

const cache = new Map();
const CACHE_LIMIT = 500;

export async function readFocusPoints(filePath) {
  if (!filePath) return { source: null, areas: [] };
  if (cache.has(filePath)) return cache.get(filePath);
  const args = [...(process.platform === 'win32' ? ['-charset', 'filename=UTF8'] : []),
    '-j', '-n', ...FOCUS_POINT_TAGS.map(tag => `-${tag}`), filePath];
  const stdout = await exiftoolRequest(args, { fallback: async () => {
    const { command, args: options } = nativeChildLaunch(localSetting('EAGLE_EXIFTOOL', 'exiftool'), args);
    return (await execFileAsync(command, options, { maxBuffer: 1024 * 1024, timeout: 60000, windowsHide: true })).stdout;
  } });
  const result = parseFocusPoints(JSON.parse(stdout)?.[0] || {});
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(filePath, result);
  return result;
}
