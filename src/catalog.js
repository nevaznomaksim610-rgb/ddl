export const PROGRAMS = {
  management: {
    name: 'Менеджмент (с дополнительной квалификацией «Бизнес-аналитик»)',
    label: 'Менеджмент / Бизнес-аналитик',
    groups: Array.from({ length: 8 }, (_, i) => `25.Б${String(i + 1).padStart(2, '0')}-вшм`),
    subjects: ['Маркетинг', 'Предпринимательство', 'Статистика', 'Управление человеческими ресурсами', 'Финансовый анализ', 'Этика управления'],
  },
  public: {
    name: 'Государственное и муниципальное управление',
    label: 'Государственное и муниципальное управление',
    groups: ['25.Б10-вшм', '25.Б11-вшм'],
    subjects: [],
  },
  international: {
    name: 'Международный менеджмент',
    label: 'Международный менеджмент',
    groups: ['25.Б13-вшм', '25.Б15-вшм'],
    subjects: ['Chinese', 'Entrepreneurship', 'Financial Analysis', 'International Economics', 'Law', 'Marketing', 'Statistics'],
  },
};

export const GROUPS = Object.fromEntries(Object.entries(PROGRAMS).flatMap(([program, info]) => info.groups.map(name => [name, program])));
export const TYPES = { homework: 'Домашняя работа', test: 'Контрольная', session: 'Сессия' };
export const MODES = { daily: 'Каждый день в 09:00', new: 'Только новые работы и изменения', off: 'Выключены' };

export function moscowNow(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours(), weekday: local.getUTCDay() };
}

export function plusDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function parseDate(text, today) {
  const match = text.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const iso = `${y}-${m}-${d}`;
  const date = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso || iso < today || Number(y) > Number(today.slice(0, 4)) + 5) return null;
  return iso;
}

export function formatDate(iso) {
  return iso.split('-').reverse().join('.');
}

export function deadlineText(item, today) {
  const days = Math.round((Date.parse(`${item.due_date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  const timing = days < 0 ? `просрочено на ${-days} дн.` : days === 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} дн.`;
  return `#${item.id} · ${TYPES[item.kind]}\n${item.title}\n📅 ${formatDate(item.due_date)} · ${timing}${item.details ? `\n${item.details}` : ''}`;
}
