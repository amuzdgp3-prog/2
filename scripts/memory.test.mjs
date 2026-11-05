import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bounded, checkMemory, codeIndex, formatDecision, loadMemory,
  OUTPUT_LIMIT, parseDecisions, rankCode, readInside, relatedOverrides, sourceAllowed } from './memory-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'scripts/memory.mjs'), ...args],
  { encoding: 'utf8', cwd: tmpdir() });

test('repo navigation references all exist and the starter context stays bounded', async () => {
  assert.deepEqual(await checkMemory(root, await loadMemory(root)), []);
});

test('old claw rule warns before its original text; preserved ROI is explicit', async () => {
  const memory = await loadMemory(root);
  const text = formatDecision(memory, 'DECISION-090');
  assert.ok(text.indexOf('090 → DECISION-091') < text.indexOf('## DECISION-090'));
  assert.match(text, /текущего обслуживания/);
  const roi = formatDecision(memory, '012');
  assert.match(roi, /НЕ отменён/);
});

test('partial replacements follow the whole known chain without assuming full cancellation', () => {
  const edges = [{ from: '053', to: '054', scope: 'mobile' }, { from: '054', to: '082', scope: 'columns' }];
  assert.deepEqual(relatedOverrides('053', edges), edges);
  assert.deepEqual(relatedOverrides('999', edges), []);
});

test('decision extraction supports gaps, CRLF and exact section boundaries', () => {
  const decisions = parseDecisions('intro\r\n## DECISION-061. Old\r\nbody\r\n## DECISION-063. New\r\nnew body');
  assert.deepEqual(decisions.map((d) => d.id), ['061', '063']);
  assert.equal(decisions[0].line, 2);
  assert.doesNotMatch(decisions[0].text, /new body/);
});

test('code navigation resolves .js imports to TS/TSX and reflects changes/deletions immediately', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'apix-memory-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    assert.ok(path.basename(fixture).startsWith('apix-memory-'));
    return rm(fixture, { recursive: true, force: true });
  });
  for (const folder of ['api/src', 'api/tests', 'web/src', '.local', 'api/dist']) await mkdir(path.join(fixture, folder), { recursive: true });
  await writeFile(path.join(fixture, 'api/src/calc.ts'), 'export function calculateRoi() { return 1; }\n');
  await writeFile(path.join(fixture, 'api/src/routes.ts'), "import { calculateRoi } from './calc.js';\napp.get('/api/roi', () => 1);\n");
  await writeFile(path.join(fixture, 'web/src/App.tsx'), "import Screen from './Screen.js';\nexport default function App() {}\n");
  await writeFile(path.join(fixture, 'web/src/Screen.tsx'), 'export default function Screen() {}\n');
  await writeFile(path.join(fixture, '.local/env.json'), '{"password":"DO_NOT_INDEX"}');
  await writeFile(path.join(fixture, 'api/dist/secret.ts'), 'export const DO_NOT_INDEX = 1;');
  let index = await codeIndex(fixture);
  assert.deepEqual(index.find((f) => f.path === 'api/src/routes.ts').imports, ['api/src/calc.ts']);
  assert.deepEqual(index.find((f) => f.path === 'web/src/App.tsx').imports, ['web/src/Screen.tsx']);
  assert.equal(rankCode(index, 'calculateRoi')[0].path, 'api/src/calc.ts');
  assert.equal(rankCode(index, '/api/roi')[0].path, 'api/src/routes.ts');
  assert.doesNotMatch(JSON.stringify(index), /DO_NOT_INDEX/);
  await writeFile(path.join(fixture, 'api/src/calc.ts'), '\n\nexport function replacementRoi() {}');
  index = await codeIndex(fixture);
  assert.equal(rankCode(index, 'calculateRoi').length, 0);
  assert.equal(rankCode(index, 'replacementRoi')[0].symbols[0].line, 3);
  await rm(path.join(fixture, 'api/src/calc.ts'));
  index = await codeIndex(fixture);
  assert.deepEqual(index.find((f) => f.path === 'api/src/routes.ts').imports, []);
});

test('path traversal and secret/non-source paths are rejected', async () => {
  for (const file of ['../ACCESS.txt', '.local/env.json', 'api/src/../../ACCESS.txt', 'api/src/.env', 'api/dist/config.js', 'data/db.sql']) {
    assert.equal(sourceAllowed(file), false, file);
  }
  await assert.rejects(readInside(root, '../ACCESS.txt'), /внутри проекта/);
});

test('stale maps and invalid replacement references fail verification', async () => {
  const memory = await loadMemory(root);
  const changed = structuredClone(memory);
  changed.topics[0].entry = ['api/src/removed-file.ts'];
  changed.overrides.push({ from: '999', to: '001', scope: '' });
  const errors = await checkMemory(root, changed);
  assert.ok(errors.some((error) => error.includes('removed-file.ts')));
  assert.ok(errors.some((error) => error.includes('999')));
});

test('Russian topics, direct symbols and decisions work independently of cwd', () => {
  assert.match(cli('topic', 'клешня'), /api\/src\/domain\/clawStats\.ts/);
  assert.match(cli('topic', 'отчёт'), /monthlyExcelReport\.ts/);
  assert.match(cli('find', 'TOY_COST_SQL'), /clawStats\.ts/);
  assert.match(cli('outline', 'api/src/domain/ownerMonthRoi.ts'), /lastServicesRoi/);
  assert.match(cli('search', 'бэкап'), /DECISION-088/);
});

test('broad requests never flood the context', () => {
  assert.ok(bounded('x'.repeat(50000)).length <= OUTPUT_LIMIT);
  assert.match(bounded('x'.repeat(50000)), /Сузьте/);
  for (const args of [['find', 'const'], ['search', 'и'], ['decision', '090']]) {
    assert.ok(cli(...args).trimEnd().length <= OUTPUT_LIMIT);
  }
});
