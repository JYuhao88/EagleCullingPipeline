import { rename } from 'node:fs/promises';
const transientWindowsErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Preserve atomic replacement; never unlink the old file to work around a sharing violation.
// Options allow deterministic tests without requiring Windows or real sleeps.
export async function replaceFile(temporary, destination, {
  platform = process.platform, renameFile = rename,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(temporary, destination); }
    catch (error) {
      if (platform !== 'win32' || !transientWindowsErrors.has(error.code) || attempt >= 9) throw error;
      await wait(Math.min(1000, 50 * 2 ** attempt));
    }
  }
}
