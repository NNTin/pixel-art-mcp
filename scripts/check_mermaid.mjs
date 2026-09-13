/** CI check: every ```mermaid block in docs must actually render, catching the same parse
 * errors GitHub's markdown renderer hits (unbalanced arrows, stray semicolons, etc). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipDirs = new Set(['.git', 'node_modules', '.venv', 'vendor', 'tmp']);

function findMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function extractMermaidBlocks(source) {
  const blocks = [];
  const lines = source.split('\n');
  let inBlock = false;
  let start = 0;
  let buffer = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && line.trim() === '```mermaid') {
      inBlock = true;
      start = i + 1;
      buffer = [];
    } else if (inBlock && line.trim() === '```') {
      inBlock = false;
      blocks.push({ line: start + 1, text: buffer.join('\n') });
    } else if (inBlock) {
      buffer.push(line);
    }
  }
  return blocks;
}

const puppeteerConfigPath = path.join(os.tmpdir(), 'mermaid-puppeteer-config.json');
fs.writeFileSync(puppeteerConfigPath, JSON.stringify({ args: ['--no-sandbox'] }));

const files = findMarkdownFiles(root);
let total = 0;
let failed = 0;

for (const file of files) {
  const relFile = path.relative(root, file);
  const blocks = extractMermaidBlocks(fs.readFileSync(file, 'utf8'));
  for (const block of blocks) {
    total += 1;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-check-'));
    const inputPath = path.join(tmpDir, 'diagram.mmd');
    const outputPath = path.join(tmpDir, 'diagram.svg');
    fs.writeFileSync(inputPath, block.text);
    try {
      execFileSync(
        'npx',
        ['--yes', '@mermaid-js/mermaid-cli', '-i', inputPath, '-o', outputPath, '-p', puppeteerConfigPath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      failed += 1;
      console.error(`\n${relFile}:${block.line}: mermaid diagram failed to render`);
      console.error((error.stderr ?? error.stdout ?? error.message).toString().trim());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

if (total === 0) {
  console.log('No mermaid diagrams found.');
} else if (failed === 0) {
  console.log(`All ${total} mermaid diagram(s) rendered successfully.`);
} else {
  console.error(`\n${failed}/${total} mermaid diagram(s) failed to render.`);
  process.exit(1);
}
