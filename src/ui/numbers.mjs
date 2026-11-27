// The one place "needed, available, short" is worked out. Every screen that states a shortfall (the verdict,
// the cost screen, My week and its grid marker, Reset, Home) reads it from here, from the same evaluated
// schedule, so the same plan can never show two different numbers.
import { deadlineCost } from '../engine/evaluate.mjs';

/**
 * Needed, available and short, in hours, at the binding deadline of a schedule (the day with the least slack).
 * `short` is 0 when it fits. Returns null when nothing is due.
 */
export function planNumbers(schedule, days) {
  const cost = deadlineCost(schedule, days);
  if (!cost) return null;
  return {
    dayIndex: cost.dayIndex,
    date: cost.date,
    weekday: cost.weekday,
    needed: cost.requiredHours,
    available: cost.availableHours,
    short: cost.shortfallHours,
    spare: Math.max(0, cost.marginHours),
    margin: cost.marginHours,
    fits: schedule.feasible && cost.shortfallHours <= 0,
    tasks: cost.tasks
  };
}

/** "1 hour", "0.5 hours". */
export function hoursWord(hours) {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

/** "1h", "0.5h". */
export function hoursShort(hours) {
  return `${Math.round(hours * 10) / 10}h`;
}
