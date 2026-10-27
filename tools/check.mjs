import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3, 'Expected a Manifest V3 extension');
assert.equal(manifest.version, metadata.version, 'Manifest and package versions must match');

function checkAsset(asset) {
  assert.equal(typeof asset, 'string', 'Asset paths must be strings');
  const fullPath = resolve(root, asset);
  assert.ok(fullPath.startsWith(root + sep), `Asset must stay inside the extension: ${asset}`);
  assert.ok(existsSync(fullPath), `Missing extension asset: ${asset}`);
  return fullPath;
}

const popup = manifest.action?.default_popup;
const assets = [
  manifest.background?.service_worker,
  popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(typeof manifest.action?.default_icon === 'object'
    ? manifest.action.default_icon : { default: manifest.action?.default_icon }),
  ...(manifest.content_scripts ?? []).flatMap(({ js = [], css = [] }) => [...js, ...css]),
].filter(Boolean);
for (const asset of assets) checkAsset(asset);

if (popup) {
  const html = readFileSync(checkAsset(popup), 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    checkAsset(join(dirname(popup), asset));
  }
}

function checkScripts(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) checkScripts(fullPath);
    else if (/\.(?:c|m)?js$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'inherit' });
    }
  }
}
for (const directory of ['scripts', 'tests', 'tools']) checkScripts(join(root, directory));
console.log('JavaScript syntax, extension assets, and version consistency passed.');
