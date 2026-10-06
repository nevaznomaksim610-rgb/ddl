import { openDatabase, transaction } from './database.js';
import { openRemoteDatabase } from './remote-database.js';
import { GROUPS } from './catalog.js';

const db = process.env.TURSO_DATABASE_URL ? await openRemoteDatabase() : openDatabase();
const [action, target, group] = process.argv.slice(2);

async function resolveId(target) {
  if (/^[1-9]\d*$/.test(target || '')) {
    const id = Number(target);
    if (Number.isSafeInteger(id)) return id;
  }
  if (/^@\w+$/.test(target || '')) {
    const user = (await db.prepare('SELECT id FROM users WHERE username=?').get(target.slice(1).toLowerCase()));
    if (user) return user.id;
    throw new Error('Пользователь должен сначала нажать /start. Или используй Telegram ID.');
  }
  throw new Error('Укажи Telegram ID или @username зарегистрированного пользователя');
}

try {
  if (action === 'users') {
    console.table((await db.prepare('SELECT id,name,username,group_id,notifications FROM users ORDER BY updated_at DESC').all()));
  } else if (action === 'admins') {
    console.table((await db.prepare('SELECT a.user_id,u.name,u.username,a.group_id,a.reminders FROM admins a LEFT JOIN users u ON u.id=a.user_id').all()));
  } else if (action === 'grant') {
    const id = (await resolveId(target));
    (await transaction(db, async () => {
      const user = (await db.prepare('SELECT * FROM users WHERE id=?').get(id));
      const assignedGroup = group || user?.group_id || null;
      if (assignedGroup && !Object.hasOwn(GROUPS, assignedGroup)) throw new Error('Такой группы нет в каталоге');
      if (user?.group_id && assignedGroup !== user.group_id) throw new Error('Группа админа должна совпадать с его зарегистрированной группой');
      if (assignedGroup && (await db.prepare('SELECT 1 FROM admins WHERE group_id=? AND user_id<>?').get(assignedGroup, id))) throw new Error('У группы уже есть админ. Сначала отзови его права командой revoke.');
      (await db.prepare(`INSERT INTO admins(user_id,group_id,granted_at) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET group_id=excluded.group_id`).run(id, assignedGroup, new Date().toISOString()));
      (await db.prepare('INSERT INTO audit(actor_id,action,data,created_at) VALUES(?,?,?,?)').run(0, 'grant_admin', JSON.stringify({ user_id: id, group_id: assignedGroup }), new Date().toISOString()));
      console.log(`Права админа выданы: ${id}; группа: ${assignedGroup || 'выберет при регистрации'}`);
    }));
  } else if (action === 'revoke') {
    const id = (await resolveId(target));
    (await transaction(db, async () => {
      (await db.prepare('DELETE FROM admins WHERE user_id=?').run(id));
      (await db.prepare("UPDATE users SET session='{}' WHERE id=?").run(id));
      (await db.prepare('INSERT INTO audit(actor_id,action,data,created_at) VALUES(?,?,?,?)').run(0, 'revoke_admin', JSON.stringify({ user_id: id }), new Date().toISOString()));
    }));
    console.log(`Права админа отозваны: ${id}`);
  } else {
    console.log('node --env-file=.env src/manage.js users | admins | grant <ID|@username> [группа] | revoke <ID|@username>');
    if (action) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db.close(); }
