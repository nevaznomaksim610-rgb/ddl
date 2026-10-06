import { authenticate, database, createBot, drain } from '../src/serverless.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authenticate(req.headers['x-telegram-bot-api-secret-token'], process.env.WEBHOOK_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  const update = req.body;
  if (!update || !Number.isSafeInteger(update.update_id)) return res.status(400).json({ error: 'invalid_update' });
  try {
    const db = await database();
    const bot = createBot(db);
    await bot.process(update);
    await bot.schedule();
    const pending = await drain(db);
    if (pending) return res.status(503).json({ error: 'delivery_pending' });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook failed:', error.message);
    return res.status(500).json({ error: 'webhook_failed' });
  }
}
