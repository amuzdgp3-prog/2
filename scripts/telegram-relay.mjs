#!/usr/bin/env node
//
// Релей очереди уведомлений в Telegram (DECISION-092).
//
// Зачем он есть. Прод в России не достаёт до api.telegram.org: TCP:443 до подсетей Telegram
// зависает на уровне провайдера (DECISION-074). При этом обычный HTTPS к самому 2.apixspb.ru с
// любой машины работает. Поэтому сервер в Telegram не стучится вовсе — он кладёт сообщения в
// telegram_outbox, а этот скрипт запускается там, где Telegram доступен (домашняя машина с VPN),
// забирает очередь по HTTPS и отправляет сам.
//
// Почему «очередь + опрос», а не прокси/туннель с домашней машины на сервер: домашняя машина
// обычно за NAT, пробрасывать к ней порт — лишняя зависимость от роутера и от того, что машина
// включена именно в момент отправки. При опросе выключенная машина просто не мешает: сообщения
// подождут в очереди и уйдут, когда она включится.
//
// Почему скрипт самодостаточный (обычный .mjs без зависимостей и без импортов из api/): его
// место — не на сервере, а на машине с Telegram, и переносится он копированием одного файла.
// Привязка к node_modules и сборке api/ сделала бы такой перенос работой, а не копированием.
//
// Запуск: node scripts/telegram-relay.mjs      (одна итерация опроса, под cron)
//         node scripts/telegram-relay.mjs --loop  (бесконечный цикл с паузой POLL_SECONDS)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(PROJECT_DIR, 'scripts', '.telegram-relay-state.json');

// У глобального fetch нет таймаута по умолчанию — ровно этот баг уже ловили на проде и для
// Telegram, и для iVend: без таймаута зависшее соединение висит вечно и держит процесс.
const HTTP_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS ?? 30_000);
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 300);
// После скольких подряд неудачных опросов прода сообщить владельцу, что прод молчит. Это тот
// случай, который сам прод сообщить не может по определению: если лежит всё, то и очередь
// недоступна. Релей — единственный, кто видит это снаружи.
const DEAD_PROD_THRESHOLD = Number(process.env.DEAD_PROD_THRESHOLD ?? 3);

function readEnvFile() {
  const path = join(PROJECT_DIR, '.env');
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const fileEnv = readEnvFile();
const cfg = {
  apiBase: process.env.API_BASE ?? fileEnv.API_BASE ?? 'https://2.apixspb.ru',
  login: process.env.ADMIN_LOGIN ?? fileEnv.ADMIN_LOGIN,
  password: process.env.ADMIN_PASSWORD ?? fileEnv.ADMIN_PASSWORD,
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? fileEnv.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_OWNER_CHAT_ID ?? fileEnv.TELEGRAM_OWNER_CHAT_ID,
  telegramApi: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
};

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { consecutiveProdFailures: 0, deadProdReported: false };
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (error) {
    log('не удалось сохранить состояние:', error.message);
  }
}

async function http(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

async function login() {
  const response = await http(`${cfg.apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: cfg.login, password: cfg.password }),
  });
  if (!response.ok) throw new Error(`login ${response.status}`);
  const { token } = await response.json();
  if (!token) throw new Error('login без токена');
  return token;
}

async function sendTelegramText(text) {
  const response = await http(`${cfg.telegramApi}/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text }),
  });
  if (!response.ok) throw new Error(`telegram sendMessage ${response.status} ${await response.text()}`);
}

async function sendTelegramDocument(buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  if (caption) form.append('caption', caption);
  form.append(
    'document',
    new Blob([new Uint8Array(buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename,
  );
  const response = await http(`${cfg.telegramApi}/bot${cfg.botToken}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) throw new Error(`telegram sendDocument ${response.status} ${await response.text()}`);
}

async function deliver(token, message) {
  if (message.kind === 'text') {
    await sendTelegramText(String(message.payload.text ?? ''));
    return;
  }
  if (message.kind === 'monthly_report') {
    const response = await http(`${cfg.apiBase}/api/telegram-outbox/${message.id}/file`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`скачивание файла ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { year, month } = message.payload;
    const filename = `Отчет ${year}-${String(month).padStart(2, '0')}.xlsx`;
    await sendTelegramDocument(buffer, filename, filename);
    return;
  }
  throw new Error(`неизвестный kind: ${message.kind}`);
}

async function runOnce() {
  const state = readState();
  let token;
  let pending;
  try {
    token = await login();
    const response = await http(`${cfg.apiBase}/api/telegram-outbox/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`pending ${response.status}`);
    pending = await response.json();
  } catch (error) {
    // Прод недоступен. Считаем подряд идущие неудачи и один раз сообщаем владельцу напрямую —
    // сам прод об этом сообщить не может, он же и не отвечает.
    state.consecutiveProdFailures += 1;
    log(`прод не отвечает (${state.consecutiveProdFailures} подряд): ${error.message}`);
    if (state.consecutiveProdFailures >= DEAD_PROD_THRESHOLD && !state.deadProdReported) {
      try {
        await sendTelegramText(
          `2.apixspb.ru не отвечает уже ${state.consecutiveProdFailures} проверки подряд: ${error.message}`,
        );
        state.deadProdReported = true;
        log('владельцу отправлено предупреждение о недоступности прода');
      } catch (notifyError) {
        log('не удалось предупредить владельца:', notifyError.message);
      }
    }
    writeState(state);
    return;
  }

  if (state.consecutiveProdFailures > 0) {
    if (state.deadProdReported) {
      await sendTelegramText('2.apixspb.ru снова отвечает').catch(() => {});
    }
    state.consecutiveProdFailures = 0;
    state.deadProdReported = false;
  }
  writeState(state);

  if (pending.length === 0) return;
  log(`в очереди ${pending.length}`);

  for (const message of pending) {
    try {
      await deliver(token, message);
      const ack = await http(`${cfg.apiBase}/api/telegram-outbox/${message.id}/ack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!ack.ok) throw new Error(`ack ${ack.status}`);
      log(`#${message.id} (${message.kind}) отправлено`);
    } catch (error) {
      log(`#${message.id} (${message.kind}) не ушло: ${error.message}`);
      await http(`${cfg.apiBase}/api/telegram-outbox/${message.id}/fail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message }),
      }).catch(() => {});
    }
  }
}

function assertConfigured() {
  const missing = ['login', 'password', 'botToken', 'chatId'].filter((key) => !cfg[key]);
  if (missing.length > 0) {
    log(`не настроено: ${missing.join(', ')} — проверьте .env`);
    process.exit(1);
  }
}

assertConfigured();

if (process.argv.includes('--loop')) {
  log(`релей запущен, опрос раз в ${POLL_SECONDS} с`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce().catch((error) => log('итерация упала:', error.message));
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }
} else {
  await runOnce();
}
