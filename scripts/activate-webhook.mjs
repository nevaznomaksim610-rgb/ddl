import { Telegram } from '../src/telegram.js';
import { parseEnv } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const base = 'https://gsom-deadlines-bot.vercel.app';
const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20000) });
if (!health.ok || !(await health.json()).ok) throw new Error('Production ещё не готов');
const telegram = new Telegram(process.env.BOT_TOKEN);
await telegram.call('setWebhook', {
  url: `${base}/api/telegram`,
  secret_token: process.env.WEBHOOK_SECRET,
  max_connections: 1,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false,
});
const info = await telegram.call('getWebhookInfo');
if (info.url !== `${base}/api/telegram`) throw new Error('Webhook не переключился');
const local = parseEnv(readFileSync('.env', 'utf8'));
const remote = parseEnv(readFileSync('.env.database', 'utf8'));
const deployment = parseEnv(readFileSync('.env.deployment', 'utf8'));
writeFileSync('.env', Object.entries({ ...local, ...remote, ...deployment }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n');
console.log(JSON.stringify({ webhook: info.url, pending_updates: info.pending_update_count, max_connections: info.max_connections }));
