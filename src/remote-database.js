import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@libsql/client';
import { SCHEMA } from './database.js';

export async function openRemoteDatabase({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN } = {}) {
  if (!url) throw new Error('TURSO_DATABASE_URL не задан');
  const client = createClient({ url, authToken, intMode: 'number' });
  const context = new AsyncLocalStorage();
  const statements = SCHEMA.split(';').map(sql => sql.trim()).filter(Boolean);
  await client.batch(statements, 'write');
  const columns = (await client.execute('PRAGMA table_info(outbox)')).rows.map(c => c.name);
  if (!columns.includes('lease_until')) await client.execute('ALTER TABLE outbox ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('lease_owner')) await client.execute('ALTER TABLE outbox ADD COLUMN lease_owner TEXT');
  const execute = (sql, args) => (context.getStore() || client).execute({ sql, args });
  return {
    prepare(sql) {
      return {
        async get(...args) { return (await execute(sql, args)).rows[0]; },
        async all(...args) { return (await execute(sql, args)).rows; },
        async run(...args) {
          const result = await execute(sql, args);
          return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
        },
      };
    },
    async transaction(fn) {
      if (context.getStore()) throw new Error('Вложенная транзакция не поддерживается');
      const tx = await client.transaction('write');
      try {
        const result = await context.run(tx, fn);
        await tx.commit();
        return result;
      } catch (error) {
        if (!tx.closed) await tx.rollback();
        throw error;
      } finally { tx.close(); }
    },
    close() { client.close(); },
  };
}
