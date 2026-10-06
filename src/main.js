import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { DeadlineBot } from './bot.js';
import { Telegram, TelegramError } from './telegram.js';
import { deliver } from './delivery.js';

mkdirSync('data', { recursive: true });
const lock = resolve('data/bot.pid');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); console.error(`Бот уже запущен (PID ${pid})`); process.exit(2); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  unlinkSync(lock);
}
try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
catch { console.error('Другой экземпляр бота уже запускается'); process.exit(2); }

let db;
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const telegram = new Telegram(process.env.BOT_TOKEN);
  db = openDatabase();
  const dailyHour = Number(process.env.DAILY_HOUR || 9);
  const adminHour = Number(process.env.ADMIN_REMINDER_HOUR || 18);
  if (![dailyHour, adminHour].every(h => Number.isInteger(h) && h >= 0 && h <= 23)) throw new Error('Часы уведомлений должны быть целыми числами от 0 до 23');
  const bot = new DeadlineBot(db, { dailyHour, adminHour });
  const me = await telegram.call('getMe');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('У бота уже настроен webhook. Сначала нужно отключить прежний запуск.');
  await telegram.call('setMyCommands', { commands: [
    { command: 'start', description: 'Регистрация и главное меню' },
    { command: 'status', description: 'Дедлайны моей группы' },
    { command: 'notifications', description: 'Режим уведомлений' },
    { command: 'admin', description: 'Админка группы' },
    { command: 'add', description: 'Добавить задание (для админа)' },
    { command: 'cancel', description: 'Отменить ввод' },
    { command: 'id', description: 'Мой Telegram ID' },
    { command: 'help', description: 'Помощь' },
  ], language_code: 'ru' });
  await telegram.call('setMyCommands', { commands: [
    { command: 'start', description: 'Регистрация и главное меню' },
    { command: 'status', description: 'Дедлайны моей группы' },
    { command: 'notifications', description: 'Режим уведомлений' },
    { command: 'admin', description: 'Админка группы' },
    { command: 'add', description: 'Добавить задание (для админа)' },
    { command: 'cancel', description: 'Отменить ввод' },
    { command: 'id', description: 'Мой Telegram ID' },
    { command: 'help', description: 'Помощь' },
  ] });
  await telegram.call('setMyDescription', { description: 'Дедлайны ВШМ СПбГУ: выбери свою группу второго курса, смотри задания и получай уведомления. Админы групп добавляют и обновляют работы.' });
  await telegram.call('setMyShortDescription', { short_description: 'Дедлайны учёбы и уведомления для групп ВШМ СПбГУ.' });
  console.log(`${new Date().toISOString()} Бот @${me.username} запущен, PID ${process.pid}`);
  let failures = 0;
  while (!stopping) {
    try {
      (await bot.schedule());
      await deliver(db, telegram);
      writeFileSync('data/health.json', JSON.stringify({ username: me.username, pid: process.pid, last_poll: new Date().toISOString(), last_error: null }));
      const offset = Number((await db.prepare("SELECT value FROM meta WHERE key='offset'").get())?.value || 0);
      const updates = await telegram.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        (await bot.process(update));
        await deliver(db, telegram);
      }
      failures = 0;
    } catch (error) {
      if (error instanceof TelegramError && [401, 409].includes(error.code)) throw error;
      failures += 1;
      console.error(`${new Date().toISOString()} ${error.message}`);
      writeFileSync('data/health.json', JSON.stringify({ username: me.username, pid: process.pid, last_error: error.message, at: new Date().toISOString() }));
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
} catch (error) {
  console.error(`Запуск остановлен: ${error.message}`);
  process.exitCode = 2;
} finally {
  db?.close();
  if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
}
