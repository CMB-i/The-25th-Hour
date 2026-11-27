// Elapsed time is not free time. The engine loads whole weeks from Monday and counts every work window in them,
// including hours that are already gone. This module makes a COPY of the loaded days in which everything before
// "now" is marked busy, using the same busyWindows structure the engine already reads for classes and meetings.
// The copy is only ever handed to the engine. It is never stored and never drawn as a Busy block.
import { formatTime } from '../engine/capacity.mjs';

const KOLKATA_MS = 19_800_000; // the campus time zone the whole app assumes (UTC+05:30)

/** Campus date and minutes since midnight for a Date. */
export function campusClock(now) {
  const shifted = new Date(now.getTime() + KOLKATA_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60
  };
}

/** Minutes of today already gone, rounded UP to the next half hour (11:00:20 -> 11:30). */
export function elapsedCutoff(now) {
  return Math.min(1440, Math.ceil(campusClock(now).minutes / 30 - 1e-9) * 30);
}

/**
 * Copy of `days` with the past made unavailable. Days before today are busy all day; today is busy up to the
 * cutoff. `elapsed` is 'past' | 'partial' on those copies so the UI can say "Past" in words. Days from today
 * onward keep their own windows. The input is never changed.
 */
export function effectiveDays(days, now) {
  const { date } = campusClock(now);
  const cutoff = elapsedCutoff(now);
  return days.map(day => {
    const copy = (day.busyWindows ?? []).map(window => [...window]);
    if (day.date < date) {
      return { ...day, busyWindows: [...copy, ['00:00', '24:00']], elapsed: 'past' };
    }
    if (day.date === date && cutoff > 0) {
      return { ...day, busyWindows: [...copy, ['00:00', formatTime(cutoff)]], elapsed: 'partial', elapsedUntil: cutoff };
    }
    return day;
  });
}

/** The loaded-day index of today, or -1 when today is outside the loaded weeks. */
export function todayIndexOf(days, now) {
  const { date } = campusClock(now);
  return days.findIndex(day => day.date === date);
}
