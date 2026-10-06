import { openRemoteDatabase } from '../src/remote-database.js';
import { Telegram } from '../src/telegram.js';
import { existsSync } from 'node:fs';

const base = 'https://gsom-deadlines-bot.vercel.app';
const db = await openRemoteDatabase();
try {
  const before = (await db.prepare('SELECT COUNT(*) n FROM outbox').get()).n;
  const updateId = (await db.prepare('SELECT MAX(id) id FROM processed_updates').get()).id;
  if (updateId === null) throw new Error('Нет сохранённого update для проверки повторной доставки');
  const health = await fetch(`${base}/api/health`);
  console.log('health', health.status, await health.json());
  const denied = await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: updateId }) });
  console.log('unauthenticated_webhook', denied.status);
  if (denied.status !== 401) throw new Error('Webhook не защищён');
  for (let i = 0; i < 2; i++) {
    const replay = await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.WEBHOOK_SECRET }, body: JSON.stringify({ update_id: updateId }), signal: AbortSignal.timeout(55000) });
    console.log(`duplicate_webhook_${i + 1}`, replay.status, await replay.json());
    if (!replay.ok) throw new Error('Повторный webhook завершился ошибкой');
  }
  const after = (await db.prepare('SELECT COUNT(*) n FROM outbox').get()).n;
  console.log('duplicate_created_no_messages', before === after);
  if (before !== after) throw new Error('Повторный update породил новые сообщения');
  for (const endpoint of ['daily', 'reminders']) {
    const result = await fetch(`${base}/api/${endpoint}`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(55000) });
    console.log(endpoint, result.status, await result.json());
    if (!result.ok) throw new Error(`Не работает ${endpoint}`);
  }
  const webhook = await new Telegram(process.env.BOT_TOKEN).call('getWebhookInfo');
  console.log('telegram', JSON.stringify({ webhook: webhook.url, pending_updates: webhook.pending_update_count, last_error_date: webhook.last_error_date || null }));
  console.log('delivery_queue', (await db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL AND failed=0').get()).n);
  console.log('local_process_stopped', !existsSync('data/bot.pid') && !existsSync('data/supervisor.pid'));
} finally { db.close(); }
