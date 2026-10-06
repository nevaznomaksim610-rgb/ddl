import { timingSafeEqual } from 'node:crypto';
import { openRemoteDatabase } from './remote-database.js';
import { DeadlineBot } from './bot.js';
import { Telegram } from './telegram.js';
import { deliver } from './delivery.js';

export const REVISION = 'vercel-webhook-v1';
let databasePromise;
export function database() {
  if (!databasePromise) {
    databasePromise = openRemoteDatabase().catch(error => { databasePromise = null; throw error; });
  }
  return databasePromise;
}

export function authenticate(value, secret) {
  if (!secret || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBot(db) {
  return new DeadlineBot(db, { dailyHour: Number(process.env.DAILY_HOUR || 9), adminHour: Number(process.env.ADMIN_REMINDER_HOUR || 18) });
}

export async function drain(db, telegram = new Telegram(process.env.BOT_TOKEN)) {
  const deadline = Date.now() + 40000;
  do {
    await deliver(db, telegram, { limit: 40, deadline });
    const pending = await db.prepare('SELECT COUNT(*) n, MIN(MAX(next_attempt,lease_until)) wake FROM outbox WHERE sent_at IS NULL AND failed=0').get();
    if (!pending.n) return 0;
    if (pending.wake > deadline) return pending.n;
    const delay = Math.min(3000, Math.max(100, pending.wake - Date.now()));
    await new Promise(resolve => setTimeout(resolve, delay));
  } while (Date.now() < deadline);
  return (await db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL AND failed=0').get()).n;
}

export async function runCron(req, res, mode) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authenticate(req.headers.authorization, `Bearer ${process.env.CRON_SECRET || ''}`) || !process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const db = await database();
    await createBot(db).schedule({ daily: mode === 'daily', admin: mode === 'admin' });
    await drain(db);
    const pending = await db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL AND failed=0').get();
    return res.status(200).json({ ok: true, pending: pending.n });
  } catch (error) {
    console.error('Cron failed:', error.message);
    return res.status(500).json({ error: 'cron_failed' });
  }
}
