import { openDatabase, transaction } from '../src/database.js';
import { openRemoteDatabase } from '../src/remote-database.js';

const local = openDatabase();
const remote = await openRemoteDatabase();
const tables = ['users', 'admins', 'tasks', 'outbox', 'meta', 'processed_updates', 'audit'];
try {
  await transaction(remote, async () => {
    for (const table of tables) {
      const existing = await remote.prepare(`SELECT COUNT(*) n FROM ${table}`).get();
      if (existing.n) throw new Error(`Удалённая таблица ${table} уже содержит данные: импорт отменён`);
    }
    for (const table of tables) {
      const rows = local.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const columns = Object.keys(row);
        await remote.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c]));
      }
      console.log(`${table}: перенесено ${rows.length}`);
    }
  });
  for (const table of tables) {
    const source = local.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    const target = (await remote.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n;
    if (source !== target) throw new Error(`Не совпадает количество строк: ${table}`);
  }
  console.log('Количество строк всех таблиц совпадает');
} finally { local.close(); remote.close(); }
