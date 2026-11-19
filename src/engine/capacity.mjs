import { dayNumber } from './dates.mjs';

export const SLOT_MINUTES = 30;
export const DEFAULT_SLEEP = Object.freeze({start: '23:00', end: '07:00'});
const DAY_MINUTES = 1440;
const overlaps = (start, end, from, to) => start < to && from < end;

export function clockMinutes(time, allowMidnightEnd = false) {
  if (allowMidnightEnd && time === '24:00') return DAY_MINUTES;
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw Error(`Invalid time: ${time}. Use HH:MM.`);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function formatTime(minutes) {
  return [Math.floor(minutes / 60), minutes % 60].map(n => String(n).padStart(2, '0')).join(':');
}

function sleepRanges(sleep) {
  const start = clockMinutes(sleep?.start);
  const end = clockMinutes(sleep?.end);
  if (start % SLOT_MINUTES || end % SLOT_MINUTES) throw Error('Sleep times must use half-hour increments.');
  if (start === end) return [];
  return start < end ? [[start, end]] : [[start, DAY_MINUTES], [0, end]];
}

export function plannedSleepMinutes(sleep = DEFAULT_SLEEP) {
  return sleepRanges(sleep).reduce((total, [start, end]) => total + end - start, 0);
}

function parseWindows(windows, aligned, date) {
  const name = aligned ? 'Work' : 'Busy';
  if (!Array.isArray(windows)) throw Error(`${name} windows must be an array on ${date}.`);
  return windows.map(window => {
    if (!Array.isArray(window) || window.length !== 2) throw Error(`Invalid ${name.toLowerCase()} window on ${date}.`);
    const start = clockMinutes(window[0]);
    const end = clockMinutes(window[1], true);
    if (start >= end || (aligned && (start % SLOT_MINUTES || end % SLOT_MINUTES))) {
      throw Error(`${name} windows must be same-day${aligned ? ' and half-hour aligned' : ''}: ${date}.`);
    }
    return [start, end];
  });
}

export function makeSlots(days, sleep = DEFAULT_SLEEP) {
  if (!Array.isArray(days)) throw Error('Loaded days must be an array.');
  const protectedRanges = sleepRanges(sleep);
  const slots = [];
  let previous = -Infinity;
  days.forEach((day, dayIndex) => {
    const date = day?.date;
    const ordinal = dayNumber(date);
    if (!Number.isFinite(ordinal) || ordinal <= previous) throw Error('Loaded dates must be valid, unique and chronological.');
    previous = ordinal;
    const work = parseWindows(day.workWindows ?? [], true, date);
    const blocked = [...protectedRanges, ...parseWindows(day.busyWindows ?? [], false, date)];
    const starts = new Set();
    for (const [begin, finish] of work) {
      for (let start = begin; start < finish; start += SLOT_MINUTES) {
        if (!blocked.some(([from, to]) => overlaps(start, start + SLOT_MINUTES, from, to))) starts.add(start);
      }
    }
    for (const start of [...starts].sort((a, b) => a - b)) {
      const end = start + SLOT_MINUTES;
      slots.push({date, dayIndex, start, end, label: `${formatTime(start)}–${formatTime(end)}`});
    }
  });
  return slots;
}
