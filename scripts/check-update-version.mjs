import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function checkUpdateVersion(tag, cwd = process.cwd()) {
  const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(cwd, 'src/plugin/manifest.json'), 'utf8'));
  const inspector = JSON.parse(await readFile(path.join(cwd, 'src/inspector/manifest.json'), 'utf8'));
  if (packageJson.version !== inspector.version) throw new Error('package.json 与检查器 manifest 版本不一致');
  if (packageJson.version !== manifest.version) throw new Error('package.json 与插件 manifest 版本不一致');
  if (tag && (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${packageJson.version}`)) {
    throw new Error('发布 tag 与 package.json / manifest 版本不一致');
  }
  return packageJson.version;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkUpdateVersion(process.argv[2]).then(version => console.log(`版本一致：v${version}`)).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
