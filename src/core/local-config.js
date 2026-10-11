import { readFileSync } from 'node:fs';

// Local settings never travel with the public source or a Ray working_dir.
const configFile = new URL('../../config/local.json', import.meta.url);
let config = {};
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('expected a JSON object');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Invalid config/local.json: ${error.message}`);
}

export function localSetting(name, fallback = '') {
  const value = process.env[name] ?? config[name] ?? fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string in config/local.json`);
  if (value.includes('<') || value.includes('>')) throw new Error(`Configure ${name} with a real local value`);
  return value;
}

export function requireLocalSetting(name) {
  const value = localSetting(name);
  if (!value) throw new Error(`Set ${name} in the environment or config/local.json`);
  return value;
}
