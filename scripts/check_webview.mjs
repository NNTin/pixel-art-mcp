/** Development-only test: reads the consumer checkout; writes solely under --output. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const consumer = path.resolve(arg('--consumer', '../pixel-index/vendor/pixel-agents'));
const assets = path.resolve(arg('--assets', 'tmp/asset-workflow'));
const output = path.resolve(arg('--output', path.join(assets, 'webview')));
assert(output !== consumer && !output.startsWith(consumer + path.sep), 'Output must be outside the read-only consumer');
fs.mkdirSync(output, { recursive: true });
const require = createRequire(path.join(consumer, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const git = (...options) => execFileSync('git', ['-C', consumer, ...options], { encoding: 'utf8' }).trim();
const before = git('status', '--porcelain', '--untracked-files=all');
const commit = git('rev-parse', 'HEAD');
async function bundle(options, name) {
  const result = await build({ bundle: true, write: false, logLevel: 'warning', ...options });
  const filename = path.join(output, name);
  fs.writeFileSync(filename, result.outputFiles[0].contents);
  return filename;
}
const decoderFile = await bundle({
  stdin: { contents: `export * from '${consumer}/core/src/assets/pngDecoder.ts';
    export * from '${consumer}/core/src/assets/manifestUtils.ts';`, resolveDir: consumer },
  platform: 'node', format: 'cjs',
}, 'decoder.cjs');
const { pngToSpriteData, decodeCharacterPng, decodePetPng, flattenManifest } = require(decoderFile);
const read = filename => fs.readFileSync(filename);
const json = filename => JSON.parse(read(filename));
const data = { catalog: [], sprites: {}, examples: [], characters: [], pets: [], commit };
const checks = [];
function furniture(folder, prefix) {
  const manifest = json(path.join(folder, 'manifest.json'));
  const flattened = flattenManifest(manifest, { ...manifest, groupId: prefix + manifest.id });
  for (const entry of flattened) {
    entry.id = prefix + entry.id;
    if (entry.animationGroup) entry.animationGroup = prefix + entry.animationGroup;
    data.sprites[entry.id] = pngToSpriteData(read(path.join(folder, entry.file)), entry.width, entry.height);
    assert(data.sprites[entry.id].flat().some(Boolean), `Nonempty decoded ${entry.id}`);
  }
  data.catalog.push(...flattened);
  return flattened;
}
const stock = path.join(consumer, 'webview-ui/public/assets');
data.characters.push(decodeCharacterPng(read(path.join(stock, 'characters/char_0.png'))));
for (const name of ['DESK', 'WOODEN_CHAIR']) furniture(path.join(stock, 'furniture', name), 'STOCK_');
for (const key of fs.readdirSync(assets).sort()) {
  const folder = path.join(assets, key);
  if (!fs.existsSync(path.join(folder, 'asset-specification.json'))) continue;
  const metadata = json(path.join(folder, 'spritesheet.json'));
  const spec = metadata.asset;
  const example = { key, spec, playback: metadata.playback, layouts: metadata.layouts, ids: [] };
  const expected = (angle, frame) => {
    const cell = metadata.frames.find(e => e.angle === angle && e.frame === frame);
    const size = metadata.layouts.find(e => e.angle === angle);
    return pngToSpriteData(read(path.join(folder, cell.filename)), size.width, size.height);
  };
  if (spec.kind === 'furniture') {
    const dir = path.join(folder, 'pixel-agents/assets/furniture');
    for (const variant of fs.readdirSync(dir).sort()) example.ids.push(...furniture(path.join(dir, variant), '').map(e => e.id));
    const oldDir = path.join(root, 'tmp', key, 'pixel-agents/assets/furniture');
    example.beforeIds = [];
    if (fs.existsSync(oldDir)) for (const variant of fs.readdirSync(oldDir).sort()) {
      example.beforeIds.push(...furniture(path.join(oldDir, variant), 'BEFORE_').map(e => e.id));
    }
  } else if (spec.kind === 'character') {
    const decoded = decodeCharacterPng(read(path.join(folder, 'pixel-agents-character/character.png')));
    const frames = ['walk', 'typing', 'reading'].flatMap(k => spec.clips[k].frames);
    for (const [direction, angle] of [['down', 0], ['up', 180], ['right', 90]]) {
      frames.forEach((frame, i) => assert.deepEqual(decoded[direction][i], expected(angle, frame)));
    }
    example.palette = data.characters.length;
    data.characters.push(decoded);
    checks.push('Character decoded slots equal individually inspected semantic poses');
  } else {
    const decoded = decodePetPng(read(path.join(folder, metadata.package.image)));
    for (const [direction, angle] of [['Down', 0], ['Up', 180], ['Right', 90]]) {
      for (const clip of direction === 'Right' ? ['walk'] : ['walk', 'idle']) {
        spec.clips[clip].frames.forEach((frame, i) => assert.deepEqual(decoded[clip + direction][i], expected(angle, frame)));
      }
    }
    example.petType = data.pets.length;
    data.pets.push(decoded);
    checks.push('Pet mixed-width decoded slots equal individually inspected semantic poses');
  }
  data.examples.push(example);
}
assert.equal(data.examples.length, Object.keys(json(path.join(root, 'examples/asset-specs.json'))).length, 'Generate all examples first');
await bundle({ entryPoints: [path.join(root, 'scripts/webview/check.ts')], platform: 'browser', format: 'iife', alias: { '@consumer': consumer } }, 'check.js');
fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Actual Pixel Agents renderer</title>
<style>body{font:16px system-ui;background:#1d252c;color:#e6eef4;margin:24px}canvas{image-rendering:pixelated}section{margin-bottom:24px}.row{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}h2{font-size:20px}</style>
<h1>Actual Pixel Agents renderer</h1><p>Consumer ${commit} · built-in reference agent · generated packages decoded by consumer code</p><main></main>
<script>window.fixture=${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script src="check.js"></script>`);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  await page.waitForFunction(() => window.webviewResult !== undefined);
  const result = await page.evaluate(() => window.webviewResult);
  assert.deepEqual(errors, []);
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const example of data.examples) {
    await page.locator(`#${example.key}`).screenshot({ path: path.join(output, example.key + '.png') });
    // Also exercise every control in each offline preview: no production browser dependency.
    const preview = await browser.newPage({ reducedMotion: 'reduce' });
    await preview.goto(pathToFileURL(path.join(assets, example.key, 'preview.html')).href);
    await preview.waitForFunction(() => window.assetPreviewReady === true);
    for (const clip of Object.keys(example.spec.clips)) for (const angle of [0, 90, 180, 270]) {
      await preview.selectOption('#clip', clip);
      await preview.selectOption('#direction', String(angle));
      assert((await preview.locator('#details').textContent()).includes('source frame'));
    }
    if (example.spec.kind === 'furniture') {
      await preview.selectOption('#activation', 'on');
      await preview.selectOption('#interaction', 'seated');
    }
    await preview.close();
  }
  const after = git('status', '--porcelain', '--untracked-files=all');
  assert.equal(after, before, 'Consumer repository must remain unchanged');
  const report = { ...result, checks: [...checks, ...result.checks], consumer, commit, consumerUnchanged: true, examples: data.examples.map(e => e.key) };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, examples: report.examples, output }, null, 2));
} finally { await browser.close(); }
