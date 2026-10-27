import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
assert.ok(output, 'Usage: node tools/package.mjs <output.zip>');
const archive = resolve(output);
assert.ok(archive.endsWith('.zip'), 'Output must be a ZIP file');
assert.ok(!existsSync(archive), 'Output already exists; choose a new path');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const files = new Set();

function addAsset(asset) {
  assert.equal(typeof asset, 'string', 'Asset paths must be strings');
  assert.ok(!isAbsolute(asset), `Expected a relative asset path: ${asset}`);
  const absolute = resolve(root, asset);
  assert.ok(absolute.startsWith(root + sep), `Asset is outside the extension: ${asset}`);
  const file = relative(root, absolute).split(sep).join('/');
  assert.ok(!file.split('/').some((part) => part.startsWith('.')), `Hidden asset rejected: ${file}`);
  assert.ok(!/^(?:node_modules|tests|tools|docs|work|outputs|dist)\//.test(file), `Development file rejected: ${file}`);
  assert.ok(statSync(absolute).isFile(), `Asset is not a file: ${file}`);
  if (files.has(file)) return;
  files.add(file);

  if (file.endsWith('.html')) {
    const html = readFileSync(absolute, 'utf8');
    for (const [, resource] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      addAsset(join(dirname(file), resource));
    }
  }
  if (file.endsWith('.js')) {
    const source = readFileSync(absolute, 'utf8');
    for (const [, argumentsText] of source.matchAll(/\bimportScripts\(([^)]+)\)/g)) {
      for (const [, resource] of argumentsText.matchAll(/["']([^"']+)["']/g)) {
        addAsset(join(dirname(file), resource));
      }
    }
  }
}

addAsset('manifest.json');
if (manifest.action?.default_popup) addAsset(manifest.action.default_popup);
if (manifest.background?.service_worker) addAsset(manifest.background.service_worker);
for (const asset of Object.values(manifest.icons ?? {})) addAsset(asset);
for (const asset of Object.values(typeof manifest.action?.default_icon === 'object'
  ? manifest.action.default_icon : { default: manifest.action?.default_icon })) {
  if (asset) addAsset(asset);
}
for (const entry of manifest.content_scripts ?? []) {
  for (const asset of [...(entry.js ?? []), ...(entry.css ?? [])]) addAsset(asset);
}
for (const entry of manifest.web_accessible_resources ?? []) {
  for (const asset of entry.resources ?? []) {
    assert.ok(!/[?*]/.test(asset), 'List web-accessible assets explicitly when packaging');
    addAsset(asset);
  }
}

mkdirSync(dirname(archive), { recursive: true });
const entries = [...files].sort();
execFileSync('zip', ['-q', '-X', archive, ...entries], { cwd: root, stdio: 'inherit' });
const packagedEntries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .trim().split('\n').sort();
assert.deepEqual(packagedEntries, entries, 'ZIP contents differ from the production asset list');
const packagedManifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
assert.deepEqual(packagedManifest, manifest, 'Packaged manifest differs from the source');
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
console.log(JSON.stringify({ archive, version: manifest.version, files: entries, sha256 }, null, 2));
