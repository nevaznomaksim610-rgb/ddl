import { TelegramError } from './telegram.js';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function deliver(db, telegram, { limit = 40, pace = 80, now = () => Date.now(), deadline = Infinity, log = console.error } = {}) {
  const rows = (await db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND failed=0 AND next_attempt<=? AND lease_until<=? ORDER BY id LIMIT ?').all(now(), now(), limit));
  for (const row of rows) {
    if (now() >= deadline) break;
    const owner = randomUUID();
    const claimed = await db.prepare('UPDATE outbox SET lease_until=?,lease_owner=? WHERE id=? AND lease_until<=? AND sent_at IS NULL AND failed=0 RETURNING id').get(now() + 90000, owner, row.id, now());
    if (!claimed) continue;
    const user = row.user_id ? (await db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id)) : null;
    const payload = JSON.parse(row.payload);
    let allowed = !user || user.reachable;
    if (row.event_key.startsWith('daily:')) allowed = allowed && user?.notifications === 'daily';
    if (row.event_key.startsWith('task:')) allowed = allowed && user?.notifications === 'new';
    if (row.event_key.startsWith('admin:')) {
      const admin = (await db.prepare('SELECT * FROM admins WHERE user_id=?').get(row.user_id));
      allowed = allowed && admin && admin.reminders !== 'off';
    }
    if (!allowed) { (await db.prepare('UPDATE outbox SET failed=1,lease_until=0 WHERE id=? AND lease_owner=?').run(row.id, owner)); continue; }
    try {
      await telegram.call(row.method, payload);
      (await db.prepare('UPDATE outbox SET sent_at=?,attempts=attempts+1,lease_until=0 WHERE id=? AND lease_owner=?').run(new Date(now()).toISOString(), row.id, owner));
      if (pace) await sleep(pace);
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      if (error.code === 401 || error.code === 409) throw error;
      if (error.code === 403) {
        if (row.user_id) (await db.prepare('UPDATE users SET reachable=0 WHERE id=?').run(row.user_id));
        (await db.prepare('UPDATE outbox SET failed=1,attempts=attempts+1,lease_until=0 WHERE id=? AND lease_owner=?').run(row.id, owner));
      } else if (error.code === 400 || (row.method === 'answerCallbackQuery' && row.attempts >= 1)) {
        (await db.prepare('UPDATE outbox SET failed=1,attempts=attempts+1,lease_until=0 WHERE id=? AND lease_owner=?').run(row.id, owner));
        log(`Ошибка доставки ${row.id}: ${error.message}`);
      } else {
        const delay = error.retryAfter ? error.retryAfter * 1000 : Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 7));
        (await db.prepare('UPDATE outbox SET attempts=attempts+1,next_attempt=?,lease_until=0 WHERE id=? AND lease_owner=?').run(now() + delay, row.id, owner));
        log(`Повтор доставки ${row.id} через ${Math.round(delay / 1000)} сек.: ${error.message}`);
        if (error.code === 429) break;
      }
    }
  }
}
