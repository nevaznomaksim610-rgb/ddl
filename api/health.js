import { database, REVISION } from '../src/serverless.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const db = await database();
    await db.prepare('SELECT 1').get();
    return res.status(200).json({ ok: true, revision: REVISION });
  } catch (error) {
    console.error('Database health failed:', error.message);
    return res.status(503).json({ ok: false, revision: REVISION });
  }
}
