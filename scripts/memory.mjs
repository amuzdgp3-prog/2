import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bounded, checkMemory, codeIndex, fold, formatDecision, loadMemory, rankCode,
  relatedOverrides, sourceAllowed, terms } from './memory-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'help', ...args] = process.argv.slice(2);
const query = args.join(' ').trim();
const help = `Память и адресная навигация (без npm install, БД и сети):
  node scripts/memory.mjs topic [тема]     — точки входа, решения и тесты
  node scripts/memory.mjs find <запрос>    — пути, объявления и маршруты; максимум 8 файлов
  node scripts/memory.mjs outline <путь>  — до 24 объявлений + прямые импорты/потребители
  node scripts/memory.mjs search <текст>  — до 6 решений из журнала
  node scripts/memory.mjs decision <NNN>  — одно решение и известные уточнения
  node scripts/memory.mjs check           — ссылки, ID, область замен и размер входа
Всегда свежие строки. Импорты эвристические: динамические связи проверять отдельно.
Выдача ограничена 8 000 символами; сузьте обрезанный запрос.`;

try {
  let output;
  if (command === 'help') output = help;
  else if (command === 'find' || command === 'outline') {
    if (!query) throw new Error('Укажите запрос или путь.');
    if (command === 'outline' && !sourceAllowed(query)) throw new Error('Путь вне разрешённого исходного кода.');
    const index = await codeIndex(root);
    if (command === 'find') {
      const hits = rankCode(index, query);
      output = hits.slice(0, 8).map((item) => {
        const matches = item.symbols.filter((symbol) => terms(query).some((word) => fold(symbol.name).includes(word)));
        return `${item.path}\n  ${(matches.length ? matches : item.symbols).slice(0, 4)
          .map((symbol) => `${symbol.name}:${symbol.line}`).join(', ')}${item.routes.length ? `\n  routes: ${item.routes.slice(0, 4).join(', ')}` : ''}`;
      }).join('\n');
      output = `${hits.length} совпадений; показано ${Math.min(8, hits.length)}.\n${output || 'Сузьте/измените запрос; это не полнотекстовый поиск.'}`;
    } else {
      const file = index.find((item) => item.path === query);
      if (!file) throw new Error('Файл не найден в разрешённом индексе.');
      const callers = index.filter((item) => item.imports.includes(query)).map((item) => item.path);
      const list = (items, count) => `${items.slice(0, count).join('\n') || '—'}${items.length > count ? `\n… ещё ${items.length - count}` : ''}`;
      output = `${file.path}\nОбъявления (${file.symbols.length}):\n${list(file.symbols.map((s) => `${s.line}: ${s.name}`), 24)}
Прямые локальные импорты (${file.imports.length}):\n${list(file.imports, 12)}
Импортируется из (${callers.length}):\n${list(callers, 12)}
Эвристика статических импортов; SQL, динамические вызовы и регистрация требуют отдельной проверки.`;
    }
  } else {
    const memory = await loadMemory(root);
    if (command === 'topic') {
      if (!query) output = memory.topics.map((topic) => `${topic.id}: ${topic.title}`).join('\n');
      else {
        const words = terms(query);
        const topics = memory.topics.filter((topic) => words.every((word) => fold(`${topic.id} ${topic.title} ${topic.keywords}`).includes(word)));
        output = topics.slice(0, 3).map((topic) => `${topic.id}: ${topic.title}\n${topic.note}
Вход:\n${topic.entry.join('\n')}
При необходимости:\n${topic.related.join('\n')}
Тесты (сначала подтвердить отдельную тестовую БД):\n${topic.tests.join('\n')}
Решения: ${topic.decisions.map((id) => `DECISION-${id}`).join(', ')}`).join('\n\n');
        output = `${topics.length} тем; показано ${Math.min(3, topics.length)}.\n${output || 'Тема не найдена. Попробуйте topic или find.'}`;
      }
    } else if (command === 'decision') {
      if (!query) throw new Error('Укажите ID решения.');
      output = formatDecision(memory, query);
    } else if (command === 'search') {
      if (!query) throw new Error('Укажите текст поиска.');
      const words = terms(query);
      const hits = memory.decisions.filter((item) => words.every((word) => fold(item.text).includes(word)))
        .sort((a, b) => Number(words.every((word) => fold(b.title).includes(word)))
          - Number(words.every((word) => fold(a.title).includes(word))) || b.id.localeCompare(a.id));
      output = `${hits.length} решений; показано ${Math.min(6, hits.length)}.\n` + hits.slice(0, 6).map((item) => {
        const edges = relatedOverrides(item.id, memory.overrides);
        return `DECISION-${item.id}: ${item.title}\n  DECISIONS.md:${item.line}${edges.length
          ? `\n  Уточнения: ${edges.map((edge) => `${edge.from}→${edge.to} (${edge.scope})`).join('; ')}` : ''}`;
      }).join('\n');
    } else if (command === 'check') {
      const errors = await checkMemory(root, memory);
      if (errors.length) { output = errors.join('\n'); process.exitCode = 1; }
      else output = `OK: ${memory.topics.length} тем, ${memory.decisions.length} решений, ${memory.overrides.length} связей уточнений.
Пути/ID/ссылки и размеры проверены. Актуальность бизнес-правил и состояние прода этим не доказаны.`;
    } else throw new Error(`Неизвестная команда: ${command}`);
  }
  console.log(bounded(output));
} catch (error) {
  console.error(bounded(`Ошибка: ${error.message}`));
  process.exitCode = 1;
}
