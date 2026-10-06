import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const local = parseEnv(readFileSync('.env', 'utf8'));
const previous = existsSync('.env.deployment') ? parseEnv(readFileSync('.env.deployment', 'utf8')) : {};
const settings = {
  BOT_TOKEN: local.BOT_TOKEN,
  WEBHOOK_SECRET: previous.WEBHOOK_SECRET || randomBytes(32).toString('hex'),
  CRON_SECRET: previous.CRON_SECRET || randomBytes(32).toString('hex'),
  DAILY_HOUR: '9',
  ADMIN_REMINDER_HOUR: '18',
};
writeFileSync('.env.deployment', Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
for (const [key, value] of Object.entries(settings)) {
  const sensitive = key.endsWith('SECRET') || key === 'BOT_TOKEN';
  const result = spawnSync('cmd.exe', ['/d', '/c', `npx --yes vercel env add ${key} production --force --yes${sensitive ? ' --sensitive' : ''}`], { input: value, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { console.error(`Не удалось установить ${key}: ${result.stderr}`); process.exit(1); }
  console.log(`${key}: установлен`);
}
