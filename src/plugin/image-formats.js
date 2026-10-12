export const RAW_EXTENSIONS = Object.freeze([
  'arw', 'dng', '3fr', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'raf', 'orf', 'rw2',
  'pef', 'srw', 'sr2', 'srf', 'erf', 'iiq', 'x3f', 'kdc', 'dcr', 'mef', 'mos',
  'mrw', 'rwl', 'raw',
]);
export const HEIF_EXTENSIONS = Object.freeze(['heic', 'heif', 'hif']);
const raw = new Set(RAW_EXTENSIONS);
const heif = new Set(HEIF_EXTENSIONS);
export const isRaw = ext => raw.has(String(ext || '').replace(/^\./, '').toLowerCase());
export const isHeif = ext => heif.has(String(ext || '').replace(/^\./, '').toLowerCase());
export const rawExtensions = raw;
export const heifExtensions = heif;
