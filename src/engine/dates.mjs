const DAY_MS = 86_400_000;
export const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms / DAY_MS : NaN;
}

export const dateAt = day => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function weekday(day) {
  return ((day + 4) % 7 + 7) % 7;
}

export const weekdayName = date =>
  ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][weekday(dayNumber(date))];
