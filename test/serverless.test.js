import test from 'node:test';
import assert from 'node:assert/strict';
import { openRemoteDatabase } from '../src/remote-database.js';
import { openDatabase, transaction } from '../src/database.js';
import { DeadlineBot } from '../src/bot.js';
import { deliver } from '../src/delivery.js';
import { authenticate } from '../src/serverless.js';
import webhook from '../api/telegram.js';
import daily from '../api/daily.js';

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('публичный webhook и cron отклоняют запросы без секрета', async () => {
  const r = response(); await webhook({ method: 'POST', headers: {}, body: { update_id: 1 } }, r);
  assert.equal(r.code, 401);
  const cron = response(); await daily({ method: 'GET', headers: {} }, cron); assert.equal(cron.code, 401);
  const wrongMethod = response(); await webhook({ method: 'GET', headers: {} }, wrongMethod); assert.equal(wrongMethod.code, 405);
  assert.equal(authenticate('secret', 'secret'), true);
  assert.equal(authenticate('', ''), false);
  assert.equal(authenticate('secret', 'different'), false);
});

test('асинхронный SQL API сохраняет и откатывает операции мастера', async t => {
  const db = await openRemoteDatabase({ url: 'file::memory:' });
  t.after(() => db.close());
  const bot = new DeadlineBot(db, { now: () => new Date('2026-10-05T06:00:00Z') });
  let sequence = 1;
  const message = text => bot.process({ update_id: sequence++, message: { chat: { type: 'private', id: 1 }, from: { id: 1, first_name: 'А' }, text } });
  const callback = data => bot.process({ update_id: sequence++, callback_query: { id: String(sequence), from: { id: 1, first_name: 'А' }, message: { chat: { type: 'private', id: 1 } }, data } });
  await message('/start'); await callback('course:2'); await callback('program:management'); await callback('group:25.Б01-вшм');
  await db.prepare("INSERT INTO admins(user_id,group_id,granted_at) VALUES(1,'25.Б01-вшм','2026-10-05')").run();
  await message('/add');
  const nonce = () => bot.user(1).then(u => bot.session(u).nonce);
  await callback(`kind:${await nonce()}:homework`); await message('Статистика'); await message('10.10.2026'); await callback(`skip:${await nonce()}`); await callback(`save:${await nonce()}`);
  assert.equal((await bot.tasks('25.Б01-вшм'))[0].title, 'Статистика');
  await assert.rejects(transaction(db, async () => { await db.prepare("UPDATE users SET name='BAD' WHERE id=1").run(); throw new Error('rollback'); }), /rollback/);
  assert.equal((await bot.user(1)).name, 'А');
  await callback('notify:daily'); await bot.schedule();
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'daily:%'").get()).n, 1);
});

test('две одновременные отправки не доставляют одно сообщение дважды', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare("INSERT INTO outbox(event_key,method,payload) VALUES('concurrent','sendMessage','{}')").run();
  let calls = 0;
  const telegram = { call: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); } };
  await Promise.all([deliver(db, telegram, { pace: 0 }), deliver(db, telegram, { pace: 0 })]);
  assert.equal(calls, 1);
  assert.ok(db.prepare('SELECT sent_at FROM outbox').get().sent_at);
});
