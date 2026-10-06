import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { DeadlineBot } from '../src/bot.js';
import { parseDate, moscowNow, plusDays } from '../src/catalog.js';
import { TelegramError } from '../src/telegram.js';
import { deliver } from '../src/delivery.js';

function fixture(t, path = ':memory:') {
  const db = openDatabase(path);
  t.after(() => db.close());
  let now = new Date('2026-10-05T06:00:00Z');
  const bot = new DeadlineBot(db, { now: () => now });
  let sequence = 1;
  const message = async (id, text) => (await bot.process({ update_id: sequence++, message: { chat: { type: 'private', id }, from: { id, first_name: `Студент ${id}`, username: `student${id}` }, text } }));
  const callback = async (id, data) => (await bot.process({ update_id: sequence++, callback_query: { id: String(sequence), from: { id, first_name: `Студент ${id}`, username: `student${id}` }, message: { chat: { type: 'private', id } }, data } }));
  const register = async (id, program = 'management', group = '25.Б01-вшм') => {
    (await message(id, '/start')); (await callback(id, 'course:2')); (await callback(id, `program:${program}`)); (await callback(id, `group:${group}`));
  };
  const grant = async id => (await db.prepare('INSERT INTO admins(user_id,group_id,granted_at) VALUES(?,?,?)').run(id, (await bot.user(id))?.group_id || null, now.toISOString()));
  const nonce = async id => bot.session((await bot.user(id))).nonce;
  const latest = async id => JSON.parse((await db.prepare("SELECT payload FROM outbox WHERE user_id=? AND method='sendMessage' ORDER BY id DESC LIMIT 1").get(id)).payload);
  const add = async (id, title = 'Статистика: задачи 1–5') => {
    (await message(id, '/add')); (await callback(id, `kind:${(await nonce(id))}:homework`)); (await message(id, title)); (await message(id, '10.10.2026')); (await callback(id, `skip:${(await nonce(id))}`));
    const save = `save:${(await nonce(id))}`;
    (await callback(id, save));
    return { save, task: (await db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 1').get()) };
  };
  return { db, bot, message, callback, register, grant, nonce, latest, add, setNow: value => { now = new Date(value); } };
}

test('регистрация сохраняется один раз; чужие группы не принимаются', async t => {
  const f = fixture(t);
  (await f.message(1, '/start')); (await f.callback(1, 'course:3'));
  assert.equal((await f.bot.user(1)).group_id, null);
  assert.match((await f.latest(1)).text, /неактуальна/);
  (await f.callback(1, 'course:2')); (await f.callback(1, 'program:management')); (await f.callback(1, 'group:25.Б15-вшм'));
  assert.equal((await f.bot.user(1)).group_id, null);
  (await f.callback(1, 'group:25.Б03-вшм'));
  assert.equal((await f.bot.user(1)).group_id, '25.Б03-вшм');
  (await f.message(1, '/start')); (await f.callback(1, 'group:25.Б04-вшм'));
  assert.equal((await f.bot.user(1)).group_id, '25.Б03-вшм');
});

test('все три направления регистрируются; группа админа выбирается один раз', async t => {
  const f = fixture(t);
  (await f.grant(1)); (await f.register(1, 'public', '25.Б10-вшм'));
  (await f.register(2, 'international', '25.Б15-вшм'));
  assert.equal((await f.bot.admin(1)).group_id, '25.Б10-вшм');
  assert.equal((await f.bot.user(2)).program, 'international');
  (await f.grant(3)); (await f.register(3, 'public', '25.Б10-вшм'));
  assert.equal((await f.bot.user(3)).group_id, null);
  assert.match((await f.latest(3)).text, /уже есть админ/);
});

test('первый курс: свои направления и группы, чужой курс не принимается', async t => {
  const f = fixture(t);
  (await f.message(1, '/start')); (await f.callback(1, 'course:1'));
  assert.match((await f.latest(1)).text, /первого курса/);
  assert.ok(!JSON.stringify((await f.latest(1)).reply_markup).includes('program:management"'));
  (await f.callback(1, 'program:management'));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'program');
  (await f.callback(1, 'program:management1')); (await f.callback(1, 'group:25.Б01-вшм'));
  assert.equal((await f.bot.user(1)).group_id, null);
  (await f.callback(1, 'onboard:back'));
  assert.match((await f.latest(1)).text, /первого курса/);
  (await f.callback(1, 'onboard:back'));
  assert.match((await f.latest(1)).text, /Выбери курс/);
  (await f.callback(1, 'course:1')); (await f.callback(1, 'program:international1')); (await f.callback(1, 'group:26.Б13-вшм'));
  const user = (await f.bot.user(1));
  assert.deepEqual([user.course, user.program, user.group_id], [1, 'international1', '26.Б13-вшм']);
  (await f.grant(1)); (await f.callback(1, 'add:quick')); (await f.callback(1, `kind:${(await f.nonce(1))}:homework`));
  assert.match(JSON.stringify((await f.latest(1)).reply_markup), /Macroeconomics/);
  (await f.message(1, '/add')); (await f.callback(1, `kind:${(await f.nonce(1))}:test`));
  (await f.message(1, 'Математика: контрольная 1')); (await f.message(1, '10.10.2026')); (await f.callback(1, `skip:${(await f.nonce(1))}`)); (await f.callback(1, `save:${(await f.nonce(1))}`));
  (await f.register(2, 'international', '25.Б13-вшм'));
  (await f.message(2, '/status'));
  assert.match((await f.latest(2)).text, /пока нет текущих дедлайнов/);
  (await f.message(1, '/status'));
  assert.match((await f.latest(1)).text, /Математика: контрольная 1/);
});

test('внешние групповые сообщения игнорируются', async t => {
  const f = fixture(t);
  (await f.bot.process({ update_id: 10, message: { chat: { type: 'group', id: -5 }, from: { id: 1 }, text: '/start' } }));
  assert.equal((await f.bot.user(1)), undefined);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM outbox').get()).n, 0);
});

test('неадмин не может добавить задание или открыть поддельную кнопку', async t => {
  const f = fixture(t); (await f.register(1));
  (await f.message(1, '/add')); (await f.callback(1, 'add:quick')); (await f.callback(1, 'edit:title:1'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM tasks').get()).n, 0);
  assert.match((await f.latest(1)).text, /выдаёт владелец/);
});

test('неизвестные и служебные имена в callback не принимаются', async t => {
  const f = fixture(t); (await f.message(1, '/start')); (await f.callback(1, 'course:2'));
  (await f.callback(1, 'program:__proto__')); (await f.callback(1, 'program:constructor'));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'program');
  (await f.callback(1, 'program:management')); (await f.callback(1, 'group:25.Б01-вшм')); (await f.grant(1));
  (await f.callback(1, 'notify:__proto__')); assert.equal((await f.bot.user(1)).notifications, 'new');
  (await f.message(1, '/add')); (await f.callback(1, `kind:${(await f.nonce(1))}:constructor`));
  assert.equal(f.bot.session((await f.bot.user(1))).kind, undefined);
});

test('ручной ввод, подтверждение и повторная доставка update не создают дубликатов', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  (await f.register(2)); (await f.register(3, 'management', '25.Б02-вшм'));
  const { save, task } = (await f.add(1));
  assert.equal(task.title, 'Статистика: задачи 1–5');
  assert.equal(task.due_date, '2026-10-10');
  (await f.callback(1, save));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM tasks').get()).n, 1);
  assert.deepEqual((await f.db.prepare("SELECT user_id FROM outbox WHERE event_key LIKE 'task:%' ORDER BY user_id").all()).map(r => r.user_id), [1, 2]);
  const update = { update_id: 100, message: { chat: { type: 'private', id: 2 }, from: { id: 2, first_name: 'А' }, text: '/status' } };
  assert.equal((await f.bot.process(update)), true);
  const count = (await f.db.prepare('SELECT COUNT(*) n FROM outbox').get()).n;
  assert.equal((await f.bot.process(update)), false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM outbox').get()).n, count);
});

test('быстрый ввод позволяет выбрать только тип и дату', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  (await f.callback(1, 'add:quick')); (await f.callback(1, `kind:${(await f.nonce(1))}:test`)); (await f.callback(1, `subject:${(await f.nonce(1))}:none`));
  (await f.callback(1, `date:${(await f.nonce(1))}:1`)); (await f.callback(1, `skip:${(await f.nonce(1))}`)); (await f.callback(1, `save:${(await f.nonce(1))}`));
  const task = (await f.db.prepare('SELECT * FROM tasks').get());
  assert.equal(task.kind, 'test'); assert.equal(task.title, 'Контрольная'); assert.equal(task.due_date, '2026-10-06');
});

test('быстрый ввод предмета и сессии из английского списка', async t => {
  const f = fixture(t); (await f.register(1, 'international', '25.Б13-вшм')); (await f.grant(1));
  (await f.callback(1, 'add:quick')); (await f.callback(1, `kind:${(await f.nonce(1))}:session`)); (await f.callback(1, `subject:${(await f.nonce(1))}:4`));
  (await f.message(1, '20.10.2026')); (await f.message(1, 'Аудитория 101')); (await f.callback(1, `save:${(await f.nonce(1))}`));
  const task = (await f.db.prepare('SELECT * FROM tasks').get());
  assert.equal(task.title, 'Law — Сессия'); assert.equal(task.details, 'Аудитория 101');
});

test('устаревшие кнопки мастера не изменяют новое задание', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  (await f.callback(1, 'add:quick')); const oldNonce = (await f.nonce(1));
  (await f.callback(1, 'add:manual')); (await f.callback(1, `kind:${oldNonce}:test`));
  assert.equal(f.bot.session((await f.bot.user(1))).kind, undefined);
  assert.match((await f.latest(1)).text, /неактуальна/);
});

test('невалидные даты, пустые названия и длинный текст отклоняются', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  (await f.message(1, '/add')); (await f.callback(1, `kind:${(await f.nonce(1))}:homework`));
  (await f.message(1, ' ')); (await f.message(1, 'а'.repeat(201)));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'title');
  (await f.message(1, 'Предмет')); (await f.message(1, '31.02.2027')); (await f.message(1, '04.10.2026'));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'date');
  (await f.message(1, '10.10.2026')); (await f.message(1, 'а'.repeat(1501)));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'details');
  (await f.message(1, '/cancel')); assert.deepEqual(f.bot.session((await f.bot.user(1))), {});
});

test('админ не может читать или менять задания другой группы', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1)); const { task } = (await f.add(1));
  (await f.register(2, 'management', '25.Б02-вшм')); (await f.grant(2));
  (await f.callback(2, `edit:title:${task.id}`)); (await f.callback(2, `delete:${task.id}`));
  assert.match((await f.latest(2)).text, /другой группе/);
  assert.equal((await f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id)).state, 'active');
  (await f.message(2, '/status')); assert.doesNotMatch((await f.latest(2)).text, /Статистика/);
});

test('редактирование даты, типа, текста, закрытие и отмена', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1)); const { task } = (await f.add(1));
  (await f.callback(1, `edit:due_date:${task.id}`)); (await f.message(1, '15.10.2026'));
  (await f.callback(1, `edit:kind:${task.id}`)); (await f.callback(1, `kind:${(await f.nonce(1))}:session`));
  (await f.callback(1, `edit:title:${task.id}`)); (await f.message(1, 'Экзамен'));
  (await f.callback(1, `edit:details:${task.id}`)); (await f.message(1, 'Билеты 1–10'));
  (await f.callback(1, `edit:details:${task.id}`)); (await f.callback(1, `clear:${(await f.nonce(1))}`));
  const edited = (await f.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
  assert.equal(edited.kind, 'session'); assert.equal(edited.due_date, '2026-10-15'); assert.equal(edited.title, 'Экзамен'); assert.equal(edited.details, '');
  (await f.callback(1, `close:${task.id}`)); (await f.callback(1, `remove:${(await f.nonce(1))}`));
  assert.equal((await f.bot.tasks('25.Б01-вшм')).length, 0);
  assert.equal((await f.db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id)).state, 'completed');
  const second = (await f.add(1)).task;
  (await f.callback(1, `delete:${second.id}`)); (await f.callback(1, 'cancel'));
  assert.equal((await f.bot.tasks('25.Б01-вшм')).length, 1);
  (await f.callback(1, `delete:${second.id}`)); (await f.callback(1, `remove:${(await f.nonce(1))}`));
  assert.equal((await f.db.prepare('SELECT state FROM tasks WHERE id=?').get(second.id)).state, 'deleted');
});

test('отзыв прав посреди ввода запрещает сохранение', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  (await f.message(1, '/add')); (await f.callback(1, `kind:${(await f.nonce(1))}:homework`)); (await f.message(1, 'Работа')); (await f.message(1, '10.10.2026')); (await f.callback(1, `skip:${(await f.nonce(1))}`));
  (await f.db.prepare('DELETE FROM admins WHERE user_id=1').run());
  (await f.callback(1, `save:${(await f.nonce(1))}`));
  assert.equal((await f.bot.tasks('25.Б01-вшм')).length, 0);
});

test('ежедневная сводка по Москве: один раз в день, ближайшие и просроченные', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1)); (await f.add(1)); (await f.register(2)); (await f.callback(2, 'notify:daily'));
  f.setNow('2026-10-05T05:59:59Z'); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'daily:%'").get()).n, 0);
  f.setNow('2026-10-05T06:00:00Z'); (await f.bot.schedule()); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'daily:%'").get()).n, 1);
  const payload = JSON.parse((await f.db.prepare("SELECT payload FROM outbox WHERE event_key LIKE 'daily:%'").get()).payload);
  assert.match(payload.text, /Статистика/);
  f.setNow('2026-10-11T06:00:00Z'); (await f.bot.schedule());
  const overdue = JSON.parse((await f.db.prepare("SELECT payload FROM outbox WHERE event_key LIKE 'daily:%' ORDER BY id DESC LIMIT 1").get()).payload);
  assert.match(overdue.text, /просрочено/);
  (await f.callback(2, 'notify:off')); f.setNow('2026-10-12T06:00:00Z'); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'daily:%'").get()).n, 2);
});

test('изменения данных днём не порождают повторную ежедневную сводку', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1)); (await f.callback(1, 'notify:daily')); (await f.bot.schedule());
  for (let i = 0; i < 20; i++) (await f.add(1, 'а'.repeat(200)));
  (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'daily:%'").get()).n, 1);
});

test('еженедельное напоминание админу; отключение не влияет на уведомления студента', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1));
  f.setNow('2026-10-05T14:59:00Z'); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'admin:%'").get()).n, 0);
  f.setNow('2026-10-05T15:00:00Z'); (await f.bot.schedule()); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'admin:%'").get()).n, 1);
  f.setNow('2026-10-06T15:00:00Z'); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'admin:%'").get()).n, 1);
  (await f.callback(1, 'reminder:daily')); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'admin:%'").get()).n, 2);
  (await f.callback(1, 'reminder:off')); f.setNow('2026-10-07T15:00:00Z'); (await f.bot.schedule());
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE event_key LIKE 'admin:%'").get()).n, 2);
  assert.equal((await f.bot.user(1)).notifications, 'new');
});

test('сводки и status укладываются в лимит Telegram при большом числе заданий', async t => {
  const f = fixture(t); (await f.register(1)); (await f.grant(1)); (await f.register(2));
  for (let i = 0; i < 8; i++) {
    const task = (await f.add(1, `Задание ${i}`)).task;
    (await f.db.prepare('UPDATE tasks SET details=? WHERE id=?').run('а'.repeat(1500), task.id));
  }
  const before = (await f.db.prepare('SELECT MAX(id) n FROM outbox').get()).n;
  (await f.message(2, '/status'));
  const texts = (await f.db.prepare("SELECT payload FROM outbox WHERE id>? AND method='sendMessage'").all(before)).map(r => JSON.parse(r.payload).text);
  assert.ok(texts.length > 1); assert.ok(texts.every(text => text.length <= 3500)); assert.equal(texts.join('').match(/#\d+/g).length, 8);
  (await f.callback(2, 'notify:daily')); (await f.bot.schedule());
  const digest = (await f.db.prepare("SELECT payload FROM outbox WHERE event_key LIKE 'daily:%'").all()).map(r => JSON.parse(r.payload).text);
  assert.ok(digest.length > 1); assert.ok(digest.every(text => text.length <= 3500));
});

test('перезапуск сохраняет регистрацию, незаконченный ввод и очередь уведомлений', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'deadline-test-'));
  let second;
  t.after(() => { second?.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'bot.sqlite');
  const first = openDatabase(path); const bot = new DeadlineBot(first, { now: () => new Date('2026-10-05T06:00:00Z') });
  for (const [i, text] of ['/start', '/id'].entries()) (await bot.process({ update_id: i + 1, message: { chat: { type: 'private', id: 1 }, from: { id: 1, first_name: 'А' }, text } }));
  (await first.prepare("UPDATE users SET group_id='25.Б01-вшм',course=2,program='management',session=? WHERE id=1").run(JSON.stringify({ step: 'title', nonce: 'persisted', kind: 'homework' })));
  first.close();
  second = openDatabase(path);
  const restored = new DeadlineBot(second);
  assert.equal((await restored.user(1)).group_id, '25.Б01-вшм'); assert.equal(restored.session((await restored.user(1))).nonce, 'persisted');
  assert.ok((await second.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL').get()).n > 0);
  assert.equal((await second.prepare("SELECT value FROM meta WHERE key='offset'").get()).value, '3');
});

test('транзакция откатывает частично обработанный update; повтор затем успешен', async t => {
  const f = fixture(t); const original = f.bot.handleMessage;
  f.bot.handleMessage = () => { throw new Error('test failure'); };
  (await assert.rejects(async () => (await f.message(1, '/start')), /test failure/));
  assert.equal((await f.bot.user(1)), undefined);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM processed_updates').get()).n, 0);
  f.bot.handleMessage = original; (await f.message(1, '/start'));
  assert.equal(f.bot.session((await f.bot.user(1))).step, 'course');
});

test('валидация календаря и смена даты по Москве', () => {
  assert.equal(parseDate('29.02.2028', '2026-10-05'), '2028-02-29');
  assert.equal(parseDate('29.02.2027', '2026-10-05'), null);
  assert.equal(parseDate('31.04.2027', '2026-10-05'), null);
  assert.equal(parseDate('01.01.2032', '2026-10-05'), null);
  assert.equal(moscowNow(new Date('2026-10-05T21:00:00Z')).day, '2026-10-06');
  assert.equal(plusDays('2026-12-31', 1), '2027-01-01');
});

test('доставка восстанавливается после сети и соблюдает retry_after', async t => {
  const f = fixture(t); (await f.register(1));
  (await f.db.prepare('DELETE FROM outbox').run());
  (await f.bot.enqueue('test', 1, 'sendMessage', { chat_id: 1, text: 'test' }));
  let fail = true; let calls = 0; let now = 1000;
  const telegram = { call: async () => { calls++; if (fail) throw new TelegramError(429, 'Too Many Requests', 7); } };
  const options = { pace: 0, now: () => now, log: () => {} };
  await deliver(f.db, telegram, options);
  assert.equal((await f.db.prepare('SELECT next_attempt FROM outbox').get()).next_attempt, 8000);
  fail = false; now = 7999; await deliver(f.db, telegram, options); assert.equal(calls, 1);
  now = 8000; await deliver(f.db, telegram, options); assert.equal(calls, 2);
  assert.ok((await f.db.prepare('SELECT sent_at FROM outbox').get()).sent_at);
});

test('блокировка бота отмечает недоступность; новый start восстанавливает доставку', async t => {
  const f = fixture(t); (await f.register(1)); (await f.db.prepare('DELETE FROM outbox').run());
  (await f.bot.enqueue('test', 1, 'sendMessage', { chat_id: 1, text: 'test' }));
  await deliver(f.db, { call: async () => { throw new TelegramError(403, 'bot blocked'); } }, { pace: 0 });
  assert.equal((await f.bot.user(1)).reachable, 0);
  (await f.message(1, '/start')); assert.equal((await f.bot.user(1)).reachable, 1);
});

test('отключение режима до доставки отменяет накопленные уведомления', async t => {
  const f = fixture(t); (await f.register(1)); (await f.db.prepare('DELETE FROM outbox').run());
  (await f.bot.enqueue('task:1:created:1', 1, 'sendMessage', { chat_id: 1, text: 'test' }));
  (await f.db.prepare("UPDATE users SET notifications='off' WHERE id=1").run());
  let calls = 0;
  await deliver(f.db, { call: async () => { calls++; } }, { pace: 0 });
  assert.equal(calls, 0); assert.equal((await f.db.prepare('SELECT failed FROM outbox').get()).failed, 1);
});
