import { randomUUID } from 'node:crypto';
import { PROGRAMS, GROUPS, TYPES, MODES, moscowNow, plusDays, parseDate, formatDate, deadlineText } from './catalog.js';
import { transaction } from './database.js';

const button = (text, callback_data) => ({ text, callback_data });
const keyboard = rows => ({ inline_keyboard: rows });
const cancel = [button('Отмена', 'cancel')];

export class DeadlineBot {
  constructor(db, { now = () => new Date(), dailyHour = 9, adminHour = 18 } = {}) {
    this.db = db;
    this.now = now;
    this.dailyHour = dailyHour;
    this.adminHour = adminHour;
  }

  async user(id) { return (await this.db.prepare('SELECT * FROM users WHERE id=?').get(id)); }
  async admin(id) { return (await this.db.prepare('SELECT * FROM admins WHERE user_id=?').get(id)); }
  session(user) { return JSON.parse(user.session); }
  async setSession(id, value = {}) { (await this.db.prepare('UPDATE users SET session=? WHERE id=?').run(JSON.stringify(value), id)); }
  today() { return moscowNow(this.now()).day; }

  async enqueue(key, userId, method, payload) {
    (await this.db.prepare('INSERT OR IGNORE INTO outbox(event_key,user_id,method,payload) VALUES(?,?,?,?)').run(key, userId, method, JSON.stringify(payload)));
  }

  async send(user, text, markup) {
    this.sequence += 1;
    (await this.enqueue(`${this.event}:${this.sequence}`, user.id, 'sendMessage', { chat_id: user.chat_id, text, ...(markup ? { reply_markup: markup } : {}) }));
  }

  async sendChunks(user, header, items) {
    let text = header;
    for (const item of items) {
      const part = `\n\n${deadlineText(item, this.today())}`;
      if (text.length + part.length > 3500) { (await this.send(user, text)); text = ''; }
      text += part;
    }
    (await this.send(user, text || header));
  }

  async process(update) {
    return (await transaction(this.db, async () => {
      if ((await this.db.prepare('SELECT 1 FROM processed_updates WHERE id=?').get(update.update_id))) return false;
      this.event = `update:${update.update_id}`;
      this.sequence = 0;
      const callback = update.callback_query;
      const message = callback?.message || update.message;
      const from = callback?.from || message?.from;
      if (message?.chat?.type === 'private' && from && !from.is_bot) {
        (await this.db.prepare(`INSERT INTO users(id,chat_id,username,name,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,username=excluded.username,name=excluded.name,reachable=1,updated_at=excluded.updated_at`)
          .run(from.id, message.chat.id, from.username?.toLowerCase() || null, [from.first_name, from.last_name].filter(Boolean).join(' '), this.now().toISOString()));
        const user = (await this.user(from.id));
        if (callback) {
          (await this.enqueue(`${this.event}:answer`, user.id, 'answerCallbackQuery', { callback_query_id: callback.id }));
          (await this.handleCallback(user, callback.data || ''));
        } else (await this.handleMessage(user, message.text || ''));
      }
      (await this.db.prepare('INSERT INTO processed_updates(id,processed_at) VALUES(?,?)').run(update.update_id, this.now().toISOString()));
      (await this.db.prepare(`INSERT INTO meta(key,value) VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(update.update_id + 1)));
      return true;
    }));
  }

  async home(user) {
    const admin = (await this.admin(user.id));
    const rows = [[{ text: '📚 Дедлайны' }, { text: '🔔 Уведомления' }]];
    if (admin) rows.push([{ text: '⚙️ Админка' }]);
    (await this.send(user, `Твоя группа: ${user.group_id}\n\n/status — все текущие дедлайны\n/notifications — режим уведомлений${admin ? '\n/admin — управление заданиями' : ''}\n/id — твой Telegram ID`, { keyboard: rows, resize_keyboard: true, is_persistent: true }));
  }

  async courses(user) {
    (await this.setSession(user.id, { step: 'course' }));
    (await this.send(user, 'Выбери курс. Курс, направление и группа сохраняются один раз.', keyboard([[button('1 курс', 'course:1'), button('2 курс', 'course:2')]])));
  }

  async programs(user) {
    (await this.setSession(user.id, { step: 'program' }));
    (await this.send(user, 'Выбери направление второго курса:', keyboard([...Object.entries(PROGRAMS).map(([key, p]) => [button(p.label, `program:${key}`)]), [button('Назад', 'onboard:back')]])));
  }

  async groups(user, program) {
    (await this.setSession(user.id, { step: 'group', program }));
    const groups = PROGRAMS[program].groups;
    const rows = [];
    for (let i = 0; i < groups.length; i += 2) rows.push(groups.slice(i, i + 2).map(g => button(g, `group:${g}`)));
    (await this.send(user, 'Выбери свою группу:', keyboard([...rows, [button('Назад', 'onboard:back')]])));
  }

  async notifications(user) {
    (await this.send(user, `Сейчас: ${MODES[user.notifications]}.\n\nЕжедневно — ближайшие 7 дней и просроченные задания, в ${String(this.dailyHour).padStart(2, '0')}:00 по Москве.\nТолько новые — сообщение при добавлении работы, а также при изменении или отмене задания.`, keyboard([
      [button('Каждый день', 'notify:daily')], [button('Только новые работы', 'notify:new')], [button('Выключить', 'notify:off')],
    ])));
  }

  async tasks(group) {
    return (await this.db.prepare("SELECT * FROM tasks WHERE group_id=? AND state='active' ORDER BY due_date,id").all(group));
  }

  async status(user) {
    const tasks = (await this.tasks(user.group_id));
    (await this.sendChunks(user, tasks.length ? `📚 Дедлайны группы ${user.group_id}\nПо московскому времени. Задания без времени — до конца указанного дня.` : `У группы ${user.group_id} пока нет текущих дедлайнов.`, tasks));
  }

  async requireAdmin(user) {
    const admin = (await this.admin(user.id));
    if (!admin) { (await this.send(user, 'Доступ к админке выдаёт владелец бота. Отправь ему свой ID из /id.')); return null; }
    if (!admin.group_id) {
      const occupant = (await this.db.prepare('SELECT user_id FROM admins WHERE group_id=? AND user_id<>?').get(user.group_id, user.id));
      if (occupant) { (await this.send(user, 'У этой группы уже есть админ. Владелец бота должен назначить замену.')); return null; }
      (await this.db.prepare('UPDATE admins SET group_id=? WHERE user_id=?').run(user.group_id, user.id));
      admin.group_id = user.group_id;
    }
    if (admin.group_id !== user.group_id) { (await this.send(user, 'Админка назначена другой группе. Обратись к владельцу бота.')); return null; }
    return admin;
  }

  async adminMenu(user) {
    if (!(await this.requireAdmin(user))) return;
    (await this.setSession(user.id));
    (await this.send(user, `Админ группы ${user.group_id}:`, keyboard([
      [button('Добавить по типу и дате', 'add:quick')],
      [button('Ввести задание вручную', 'add:manual')],
      [button('Изменить / закрыть / удалить', 'tasks:0')],
      [button('Расписание актуально ✓', 'admin:checked')],
      [button('Напоминания админу', 'admin:reminders')],
    ])));
  }

  async adminTasks(user, page = 0) {
    if (!(await this.requireAdmin(user))) return;
    const tasks = (await this.tasks(user.group_id));
    const last = Math.max(0, Math.ceil(tasks.length / 8) - 1);
    page = Math.min(Math.max(0, page), last);
    const rows = tasks.slice(page * 8, page * 8 + 8).map(t => [button(`#${t.id} · ${formatDate(t.due_date)} · ${t.title.slice(0, 40)}`, `task:${t.id}`)]);
    const nav = [];
    if (page > 0) nav.push(button('←', `tasks:${page - 1}`));
    if (page < last) nav.push(button('→', `tasks:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([button('В админку', 'admin:menu')]);
    (await this.send(user, tasks.length ? `Выбери задание (${page + 1}/${last + 1}):` : 'Текущих заданий пока нет.', keyboard(rows)));
  }

  async ownedTask(user, id) {
    if (!(await this.requireAdmin(user))) return null;
    const task = (await this.db.prepare("SELECT * FROM tasks WHERE id=? AND group_id=? AND state='active'").get(id, user.group_id));
    if (!task) (await this.send(user, 'Задание недоступно: оно закрыто, удалено или относится к другой группе.'));
    return task;
  }

  async taskMenu(user, task) {
    (await this.send(user, deadlineText(task, this.today()), keyboard([
      [button('Изменить название', `edit:title:${task.id}`), button('Изменить дату', `edit:due_date:${task.id}`)],
      [button('Изменить тип', `edit:kind:${task.id}`), button('Описание', `edit:details:${task.id}`)],
      [button('Закрыть', `close:${task.id}`), button('Удалить', `delete:${task.id}`)],
      [button('К списку', 'tasks:0')],
    ])));
  }

  async startAdd(user, mode) {
    if (!(await this.requireAdmin(user))) return;
    const session = { step: 'kind', mode, nonce: randomUUID().slice(0, 8) };
    (await this.setSession(user.id, session));
    (await this.askKind(user, session));
  }

  async askKind(user, session) {
    (await this.send(user, 'Выбери тип задания:', keyboard([...Object.entries(TYPES).map(([key, label]) => [button(label, `kind:${session.nonce}:${key}`)]), cancel])));
  }

  async askDate(user, session) {
    (await this.setSession(user.id, { ...session, step: 'date' }));
    const prefix = `date:${session.nonce}:`;
    (await this.send(user, 'Дата дедлайна? Введи ДД.ММ.ГГГГ или выбери кнопку. Без времени — до 23:59 по Москве.', keyboard([
      [button('Сегодня', `${prefix}0`), button('Завтра', `${prefix}1`)],
      [button('Через 3 дня', `${prefix}3`), button('Через неделю', `${prefix}7`)], cancel,
    ])));
  }

  async askDetails(user, session, date) {
    (await this.setSession(user.id, { ...session, step: 'details', due_date: date }));
    (await this.send(user, 'Добавь описание: что сделать, ссылка, аудитория. Можно пропустить.', keyboard([[button('Без описания', `skip:${session.nonce}`)], cancel])));
  }

  async preview(user, session) {
    (await this.setSession(user.id, { ...session, step: 'confirm' }));
    (await this.send(user, `Проверь задание для ${user.group_id}:\n\n${TYPES[session.kind]}\n${session.title}\n📅 ${formatDate(session.due_date)}${session.details ? `\n${session.details}` : ''}`, keyboard([
      [button('Сохранить и оповестить', `save:${session.nonce}`)], cancel,
    ])));
  }

  async audit(user, action, task, data) {
    (await this.db.prepare('INSERT INTO audit(actor_id,action,task_id,data,created_at) VALUES(?,?,?,?,?)').run(user.id, action, task?.id || null, JSON.stringify(data), this.now().toISOString()));
  }

  async broadcast(task, label, version) {
    for (const recipient of (await this.db.prepare("SELECT * FROM users WHERE group_id=? AND notifications='new' AND reachable=1").all(task.group_id))) {
      (await this.enqueue(`task:${task.id}:${version}:${recipient.id}`, recipient.id, 'sendMessage', {
        chat_id: recipient.chat_id, text: `${label}\nГруппа ${task.group_id}\n\n${deadlineText(task, this.today())}`,
      }));
    }
  }

  async save(user, session) {
    if (!(await this.requireAdmin(user))) return;
    if (session.due_date < this.today()) { (await this.send(user, 'Дата уже прошла. Выбери новый дедлайн.')); (await this.askDate(user, session)); return; }
    const now = this.now().toISOString();
    const result = (await this.db.prepare('INSERT INTO tasks(group_id,kind,title,due_date,details,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(user.group_id, session.kind, session.title, session.due_date, session.details || '', user.id, now, now));
    const task = (await this.db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(result.lastInsertRowid)));
    (await this.audit(user, 'create', task, task));
    (await this.setSession(user.id));
    (await this.broadcast(task, '🆕 Новое задание', 'created'));
    (await this.send(user, `Задание #${task.id} сохранено. Уведомления поставлены в очередь для подписчиков группы.`, keyboard([[button('Добавить ещё', 'add:quick')], [button('В админку', 'admin:menu')]])));
  }

  async editValue(user, session, value) {
    const task = (await this.ownedTask(user, session.task_id));
    if (!task) { (await this.setSession(user.id)); return; }
    const allowed = ['title', 'due_date', 'kind', 'details'];
    if (!allowed.includes(session.field)) throw new Error('Неизвестное поле задания');
    (await this.db.prepare(`UPDATE tasks SET ${session.field}=?,updated_at=? WHERE id=?`).run(value, this.now().toISOString(), task.id));
    (await this.audit(user, 'edit', task, { field: session.field, before: task[session.field], after: value }));
    (await this.setSession(user.id));
    const edited = (await this.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
    (await this.broadcast(edited, '✏️ Задание изменено', this.event));
    (await this.send(user, 'Изменения сохранены.'));
    (await this.taskMenu(user, edited));
  }

  async handleMessage(user, text) {
    const command = text.trim().split(/\s/)[0].split('@')[0].toLowerCase();
    if (command === '/id') { (await this.send(user, `Твой Telegram ID: ${user.id}${user.username ? `\n@${user.username}` : ''}`)); return; }
    if (command === '/start') {
      (await this.setSession(user.id));
      if (user.group_id) (await this.home(user)); else (await this.courses(user));
      return;
    }
    if (!user.group_id) { (await this.courses(user)); return; }
    if (command === '/cancel') { (await this.setSession(user.id)); (await this.send(user, 'Ввод отменён.')); return; }
    if (command === '/status' || text === '📚 Дедлайны') { (await this.setSession(user.id)); (await this.status(user)); return; }
    if (command === '/notifications' || text === '🔔 Уведомления') { (await this.setSession(user.id)); (await this.notifications(user)); return; }
    if (command === '/admin' || text === '⚙️ Админка') { (await this.adminMenu(user)); return; }
    if (command === '/add') { (await this.startAdd(user, 'manual')); return; }
    if (command === '/help') { (await this.home(user)); (await this.send(user, '/cancel — отменить ввод. Для доступа к админке отправь владельцу свой /id.')); return; }
    const session = this.session(user);
    if (session.step && ['title', 'date', 'details', 'edit'].includes(session.step)) {
      if (!(await this.requireAdmin(user))) { (await this.setSession(user.id)); return; }
      if (text.startsWith('/')) { (await this.send(user, 'Неизвестная команда. /cancel — отменить ввод.')); return; }
      if (session.step === 'title') {
        if (!text.trim() || text.trim().length > 200) { (await this.send(user, 'Название должно содержать от 1 до 200 символов.')); return; }
        (await this.askDate(user, { ...session, title: text.trim() }));
      } else if (session.step === 'date') {
        const date = parseDate(text, this.today());
        if (!date) { (await this.send(user, 'Нужна существующая дата в формате ДД.ММ.ГГГГ: сегодня или позже, не более чем на 5 лет вперёд.')); return; }
        if (session.field === 'due_date') (await this.editValue(user, session, date)); else (await this.askDetails(user, session, date));
      } else if (session.step === 'details') {
        if (!text.trim() || text.length > 1500) { (await this.send(user, 'Описание: от 1 до 1500 символов. Или нажми «Без описания».')); return; }
        (await this.preview(user, { ...session, details: text.trim() }));
      } else if (session.field === 'title') {
        if (!text.trim() || text.trim().length > 200) { (await this.send(user, 'Название: от 1 до 200 символов.')); return; }
        (await this.editValue(user, session, text.trim()));
      } else if (session.field === 'details') {
        if (!text.trim() || text.length > 1500) { (await this.send(user, 'Описание: от 1 до 1500 символов.')); return; }
        (await this.editValue(user, session, text.trim()));
      }
      return;
    }
    if (session.step) (await this.send(user, 'Выбери кнопку в последнем сообщении или отправь /cancel.'));
    else (await this.home(user));
  }

  async stale(user) { (await this.send(user, 'Эта кнопка уже неактуальна. Используй последнее сообщение или /start.')); }

  async handleCallback(user, data) {
    let session = this.session(user);
    const [action, arg, value] = data.split(':');
    if (action === 'course' || action === 'program' || action === 'group' || action === 'onboard') {
      if (user.group_id) { (await this.home(user)); return; }
      if (action === 'onboard') { (await this.programs(user)); return; }
      if (action === 'course' && session.step === 'course') {
        if (arg === '1') { (await this.send(user, 'Первый курс пока не подключён. Сейчас доступен второй курс.')); (await this.courses(user)); }
        else if (arg === '2') (await this.programs(user));
        else (await this.stale(user));
      } else if (action === 'program' && session.step === 'program' && Object.hasOwn(PROGRAMS, arg)) (await this.groups(user, arg));
      else if (action === 'group' && session.step === 'group' && GROUPS[arg] === session.program) {
        const admin = (await this.admin(user.id));
        if (admin && (!admin.group_id || admin.group_id !== arg)) {
          if (admin.group_id) { (await this.send(user, `Тебе выданы права на группу ${admin.group_id}. Выбери её.`)); return; }
          if ((await this.db.prepare('SELECT 1 FROM admins WHERE group_id=?').get(arg))) { (await this.send(user, 'У этой группы уже есть админ. Свяжись с владельцем бота.')); return; }
          (await this.db.prepare('UPDATE admins SET group_id=? WHERE user_id=?').run(arg, user.id));
        }
        (await this.db.prepare('UPDATE users SET course=2,program=?,group_id=?,session=\'{}\' WHERE id=?').run(session.program, arg, user.id));
        const registered = (await this.user(user.id));
        (await this.home(registered));
        (await this.notifications(registered));
      } else (await this.stale(user));
      return;
    }
    if (!user.group_id) { (await this.courses(user)); return; }
    if (action === 'notify') {
      if (!Object.hasOwn(MODES, arg)) { (await this.stale(user)); return; }
      (await this.db.prepare('UPDATE users SET notifications=? WHERE id=?').run(arg, user.id));
      (await this.send(user, `Уведомления: ${arg === 'daily' ? `каждый день в ${String(this.dailyHour).padStart(2, '0')}:00 по Москве` : MODES[arg]}.`));
      return;
    }
    if (action === 'cancel') { (await this.setSession(user.id)); (await this.send(user, 'Ввод отменён.')); return; }
    if (!(await this.requireAdmin(user))) return;
    if (action === 'admin') {
      if (arg === 'menu') (await this.adminMenu(user));
      else if (arg === 'checked') {
        (await this.audit(user, 'schedule_checked', null, { group: user.group_id }));
        (await this.send(user, 'Проверка расписания отмечена.'));
      } else if (arg === 'reminders') {
        const admin = (await this.admin(user.id));
        const names = { weekly: 'Каждый понедельник', daily: 'Каждый день', off: 'Выключены' };
        (await this.send(user, `Напоминания админу: ${names[admin.reminders]}. В ${String(this.adminHour).padStart(2, '0')}:00 по Москве.`, keyboard([
          [button('По понедельникам', 'reminder:weekly')], [button('Каждый день', 'reminder:daily')], [button('Выключить', 'reminder:off')],
        ])));
      }
      return;
    }
    if (action === 'reminder' && ['weekly', 'daily', 'off'].includes(arg)) {
      (await this.db.prepare('UPDATE admins SET reminders=? WHERE user_id=?').run(arg, user.id));
      (await this.send(user, arg === 'off' ? 'Напоминания админу выключены.' : `Напоминания админу: ${arg === 'daily' ? 'ежедневно' : 'по понедельникам'}, ${String(this.adminHour).padStart(2, '0')}:00 по Москве.`));
      return;
    }
    if (action === 'add' && ['quick', 'manual'].includes(arg)) { (await this.startAdd(user, arg)); return; }
    if (action === 'tasks' && /^\d+$/.test(arg)) { (await this.adminTasks(user, Number(arg))); return; }
    if (action === 'task' && /^\d+$/.test(arg)) { const task = (await this.ownedTask(user, Number(arg))); if (task) (await this.taskMenu(user, task)); return; }
    if (action === 'edit' && ['title', 'due_date', 'kind', 'details'].includes(arg) && /^\d+$/.test(value)) {
      if (!(await this.ownedTask(user, Number(value)))) return;
      session = { step: 'edit', field: arg, task_id: Number(value), nonce: randomUUID().slice(0, 8) };
      (await this.setSession(user.id, session));
      if (arg === 'due_date') (await this.askDate(user, session));
      else if (arg === 'kind') { (await this.setSession(user.id, { ...session, step: 'kind' })); (await this.askKind(user, session)); }
      else (await this.send(user, arg === 'title' ? 'Введи новое название (до 200 символов):' : 'Введи новое описание (до 1500 символов):', keyboard(arg === 'details' ? [[button('Убрать описание', `clear:${session.nonce}`)], cancel] : [cancel])));
      return;
    }
    if (['close', 'delete'].includes(action) && /^\d+$/.test(arg)) {
      const task = (await this.ownedTask(user, Number(arg)));
      if (!task) return;
      const nonce = randomUUID().slice(0, 8);
      (await this.setSession(user.id, { step: 'remove', task_id: task.id, operation: action, nonce }));
      (await this.send(user, `${action === 'close' ? 'Закрыть' : 'Удалить'} задание #${task.id} «${task.title}»? Оно исчезнет из текущих дедлайнов группы.`, keyboard([[button('Подтвердить', `remove:${nonce}`)], cancel])));
      return;
    }
    if (arg !== session.nonce) { (await this.stale(user)); return; }
    if (action === 'kind' && session.step === 'kind' && Object.hasOwn(TYPES, value)) {
      if (session.field === 'kind') { (await this.editValue(user, session, value)); return; }
      session = { ...session, kind: value };
      if (session.mode === 'manual') {
        (await this.setSession(user.id, { ...session, step: 'title' }));
        (await this.send(user, 'Введи название задания и предмет (до 200 символов):', keyboard([cancel])));
      } else {
        (await this.setSession(user.id, { ...session, step: 'subject' }));
        const subjects = PROGRAMS[user.program].subjects;
        (await this.send(user, 'Выбери предмет или сразу перейди к дате:', keyboard([
          ...subjects.map((s, i) => [button(s, `subject:${session.nonce}:${i}`)]),
          [button('Только тип и дата', `subject:${session.nonce}:none`)],
          [button('Вписать название вручную', `subject:${session.nonce}:manual`)], cancel,
        ])));
      }
    } else if (action === 'subject' && session.step === 'subject') {
      if (value === 'manual') {
        (await this.setSession(user.id, { ...session, step: 'title' }));
        (await this.send(user, 'Введи название задания и предмет (до 200 символов):', keyboard([cancel])));
      } else if (value === 'none' || (/^\d+$/.test(value) && PROGRAMS[user.program].subjects[Number(value)])) {
        const subject = value === 'none' ? '' : PROGRAMS[user.program].subjects[Number(value)];
        (await this.askDate(user, { ...session, title: subject ? `${subject} — ${TYPES[session.kind]}` : TYPES[session.kind] }));
      } else (await this.stale(user));
    } else if (action === 'date' && session.step === 'date' && ['0', '1', '3', '7'].includes(value)) {
      const date = plusDays(this.today(), Number(value));
      if (session.field === 'due_date') (await this.editValue(user, session, date)); else (await this.askDetails(user, session, date));
    } else if (action === 'skip' && session.step === 'details') (await this.preview(user, { ...session, details: '' }));
    else if (action === 'save' && session.step === 'confirm') (await this.save(user, session));
    else if (action === 'clear' && session.step === 'edit' && session.field === 'details') (await this.editValue(user, session, ''));
    else if (action === 'remove' && session.step === 'remove') {
      const task = (await this.ownedTask(user, session.task_id));
      if (!task) { (await this.setSession(user.id)); return; }
      (await this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(session.operation === 'close' ? 'completed' : 'deleted', this.now().toISOString(), task.id));
      (await this.audit(user, session.operation, task, task));
      (await this.broadcast(task, session.operation === 'close' ? '✅ Задание закрыто' : '🗑 Задание отменено', this.event));
      (await this.setSession(user.id));
      (await this.send(user, `Задание #${task.id} ${session.operation === 'close' ? 'закрыто' : 'удалено'}.`));
    } else (await this.stale(user));
  }

  async schedule({ daily = true, admin: adminReminders = true } = {}) {
    const { day, hour, weekday } = moscowNow(this.now());
    (await transaction(this.db, async () => {
      if (daily && hour >= this.dailyHour) {
        for (const user of (await this.db.prepare("SELECT * FROM users WHERE group_id IS NOT NULL AND notifications='daily' AND reachable=1").all())) {
          const runKey = `daily_run:${user.id}`;
          if ((await this.db.prepare('SELECT value FROM meta WHERE key=?').get(runKey))?.value === day) continue;
          const tasks = (await this.tasks(user.group_id)).filter(t => t.due_date <= plusDays(day, 7));
          const header = `🔔 Дедлайны ${user.group_id} на ${formatDate(day)}\nБлижайшие 7 дней и просроченные работы.`;
          const chunks = [header];
          for (const task of tasks) {
            const part = `\n\n${deadlineText(task, day)}`;
            if (chunks.at(-1).length + part.length > 3500) chunks.push(header);
            chunks[chunks.length - 1] += part;
          }
          if (!tasks.length) chunks[0] += '\n\nБлижайших дедлайнов нет.';
          for (const [i, text] of chunks.entries()) {
            await this.enqueue(`daily:${day}:${user.id}:${i}`, user.id, 'sendMessage', { chat_id: user.chat_id, text });
          }
          (await this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(runKey, day));
        }
      }
      if (adminReminders && hour >= this.adminHour) {
        for (const admin of (await this.db.prepare(`SELECT a.*,u.chat_id FROM admins a JOIN users u ON u.id=a.user_id
          WHERE a.group_id IS NOT NULL AND u.reachable=1 AND a.reminders<>'off'`).all())) {
          if (admin.reminders === 'weekly' && weekday !== 1) continue;
          (await this.enqueue(`admin:${day}:${admin.user_id}`, admin.user_id, 'sendMessage', {
            chat_id: admin.chat_id,
            text: `📝 Проверь дедлайны группы ${admin.group_id}: добавь новые работы, уточни даты и закрой завершённые.`,
            reply_markup: keyboard([[button('Открыть админку', 'admin:menu')], [button('Расписание актуально ✓', 'admin:checked')]]),
          }));
        }
      }
    }));
  }
}
