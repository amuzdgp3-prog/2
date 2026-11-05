import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_LIMIT = 8000;
export const fold = (value) => value.toLowerCase().replaceAll('ё', 'е');
export const terms = (value) => fold(value).split(/\s+/u).filter(Boolean);
export const bounded = (value, limit = OUTPUT_LIMIT) => value.length <= limit ? value
  : `${value.slice(0, limit - 85)}\n… Выдача сокращена. Сузьте тему, путь или запрос.\n`;

export async function readInside(root, relative) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) {
    throw new Error('Ожидается относительный путь внутри проекта с прямыми слешами.');
  }
  const absolute = path.resolve(root, relative);
  const actual = await realpath(absolute);
  const base = await realpath(root);
  const contained = path.relative(base, actual);
  if (contained.startsWith('..') || path.isAbsolute(contained)) throw new Error('Путь выходит из проекта.');
  return readFile(actual, 'utf8');
}

export function parseDecisions(text) {
  const headings = [...text.matchAll(/^## (DECISION-(\d{3}))\. (.+)$/gm)];
  return headings.map((match, i) => ({
    id: match[2], title: match[3].trim(),
    line: text.slice(0, match.index).split('\n').length,
    text: text.slice(match.index, headings[i + 1]?.index ?? text.length).trim(),
  }));
}

export async function loadMemory(root) {
  const [source, topics, overrides] = await Promise.all([
    readInside(root, 'DECISIONS.md'),
    readInside(root, 'docs/memory/topics.json'),
    readInside(root, 'docs/memory/decision-overrides.json'),
  ]);
  return { decisions: parseDecisions(source), topics: JSON.parse(topics), overrides: JSON.parse(overrides) };
}

export function relatedOverrides(id, overrides) {
  const visited = new Set([id]);
  const result = [];
  for (const current of visited) {
    for (const edge of overrides.filter((item) => item.from === current)) {
      result.push(edge);
      visited.add(edge.to);
    }
  }
  return result;
}

export function formatDecision(memory, rawId) {
  const id = rawId.replace(/^DECISION-/i, '').padStart(3, '0');
  const decision = memory.decisions.find((item) => item.id === id);
  if (!decision) throw new Error(`Решение ${id} не найдено.`);
  const edges = relatedOverrides(id, memory.overrides);
  const warning = edges.length ? ['ИЗВЕСТНЫЕ УТОЧНЕНИЯ (читать до применения старого правила):',
    ...edges.map((item) => `DECISION-${item.from} → DECISION-${item.to}: ${item.scope}`),
    `Команда: node scripts/memory.mjs decision ${edges.at(-1).to}`, ''].join('\n')
    : 'Известных замен в каталоге нет; это не подтверждает актуальность всех пунктов.\n';
  return `${warning}\nDECISIONS.md:${decision.line}\n${decision.text}`;
}

const SOURCE_ROOTS = ['api/src', 'api/tests', 'web/src'];
const SOURCE_EXTRAS = ['web/vite.config.ts', 'api/tsconfig.json',
  'scripts/memory.mjs', 'scripts/memory-lib.mjs', 'scripts/memory.test.mjs'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.sql', '.css']);

export function sourceAllowed(relative) {
  return !relative.includes('\\') && !relative.split('/').some((part) => part === '..' || part.startsWith('.'))
    && (SOURCE_EXTRAS.includes(relative) || SOURCE_ROOTS.some((base) => relative.startsWith(`${base}/`)))
    && (EXTENSIONS.has(path.extname(relative)) || SOURCE_EXTRAS.includes(relative));
}

async function sourceFiles(root, relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const found = await Promise.all(entries.filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
    .map(async (entry) => {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(root, name);
      return entry.isFile() && sourceAllowed(name) ? [name] : [];
    }));
  return found.flat();
}

export function declarations(text) {
  const result = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|enum)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u);
    if (match) result.push({ name: match[1], line: i + 1 });
  }
  return result;
}

export function importPaths(text, file, paths) {
  const result = new Set();
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^;'"`]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
      ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((suffix) => base + suffix)];
    const resolved = candidates.find((candidate) => paths.has(candidate));
    if (resolved) result.add(resolved);
  }
  return [...result].sort();
}

export async function codeIndex(root) {
  // No cached graph: paths, line numbers and imports always belong to this working tree.
  // Only navigation metadata reaches the model, never the complete scanned source.
  const roots = [];
  for (const base of SOURCE_ROOTS) {
    // Do not follow directory links/junctions, even when they point to readable files.
    const info = await lstat(path.join(root, base));
    if (!info.isSymbolicLink()) roots.push(...await sourceFiles(root, base));
  }
  for (const extra of SOURCE_EXTRAS) {
    try { if ((await lstat(path.join(root, extra))).isFile()) roots.push(extra); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const paths = new Set(roots);
  return Promise.all([...paths].sort().map(async (file) => {
    const text = await readInside(root, file);
    const routes = [...text.matchAll(/\.(?:get|post|put|patch|delete)\s*(?:<[^;]*?>)?\s*\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    return { path: file, symbols: declarations(text), imports: importPaths(text, file, paths), routes };
  }));
}

export function rankCode(index, query) {
  const words = terms(query);
  return index.map((item) => {
    const name = fold(item.path);
    const symbols = fold(item.symbols.map((symbol) => symbol.name).join(' '));
    const routes = fold(item.routes.join(' '));
    const scores = words.map((word) => (name.includes(word) ? 3 : 0)
      + (symbols.includes(word) ? 5 : 0) + (routes.includes(word) ? 4 : 0));
    return { ...item, score: scores.every(Boolean) ? scores.reduce((a, b) => a + b, 0) : 0 };
  }).filter((item) => item.score).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export async function checkMemory(root, memory) {
  const errors = [];
  const ids = new Set(memory.decisions.map((item) => item.id));
  if (ids.size !== memory.decisions.length) errors.push('Повтор ID решения.');
  if (!ids.size) errors.push('Решения не найдены.');
  const topicIds = new Set();
  for (const topic of memory.topics) {
    if (!topic.id || topicIds.has(topic.id)) errors.push(`Повтор/пустой ID темы: ${topic.id}`);
    topicIds.add(topic.id);
    for (const key of ['entry', 'related', 'tests']) {
      if (!Array.isArray(topic[key]) || (key === 'entry' && !topic[key].length)) {
        errors.push(`Некорректный список ${topic.id}.${key}`); continue;
      }
      for (const file of topic[key]) {
        if (!/^(?:api\/(?:src|tests)\/|web\/|scripts\/|README\.md$|backup\.sh$|sync-from-prod\.sh$)/.test(file)
          || /(?:^|\/)(?:\.local|data|node_modules|dist|ACCESS\.txt|\.env)(?:\/|$)/.test(file)) {
          errors.push(`Недопустимый путь карты: ${file}`); continue;
        }
        try { await readInside(root, file); } catch { errors.push(`Отсутствует/небезопасен путь ${topic.id}: ${file}`); }
      }
    }
    for (const id of topic.decisions ?? []) if (!ids.has(id)) errors.push(`Нет DECISION-${id} в теме ${topic.id}`);
  }
  const edges = new Set();
  for (const edge of memory.overrides) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.to <= edge.from || !edge.scope?.trim()) {
      errors.push(`Некорректная замена ${edge.from} → ${edge.to}`);
    }
    const key = `${edge.from}/${edge.to}`;
    if (edges.has(key)) errors.push(`Повтор связи ${key}`);
    edges.add(key);
  }
  for (const file of ['START.md', 'CURRENT.md']) {
    const text = await readInside(root, `docs/memory/${file}`);
    if (text.length > (file === 'CURRENT.md' ? 6500 : 8500)) errors.push(`${file} разросся; сократите входной контекст.`);
    for (const link of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link[1])) continue;
      try { await readInside(root, path.posix.join('docs/memory', link[1].split('#')[0])); }
      catch { errors.push(`Битая ссылка ${file}: ${link[1]}`); }
    }
  }
  return errors;
}
