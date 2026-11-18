import { dateAt, dayNumber, weekday } from './dates.mjs';
import { makeSlots } from './capacity.mjs';

export const LOADED_WEEKS = 5;

export function rollingDays(anchorDate, weeklyWorkWindows = []) {
  const anchor = dayNumber(anchorDate);
  if (!Number.isFinite(anchor)) throw Error('Choose a valid date for the loaded weeks.');
  const monday = anchor - (weekday(anchor) + 6) % 7;
  const days = Array.from({length:LOADED_WEEKS * 7}, (_, i) => {
    const day = monday + i;
    return {date:dateAt(day), workWindows:(weeklyWorkWindows[weekday(day)] ?? []).map(window => [...window]), busyWindows:[]};
  });
  makeSlots(days);
  return days;
}

export function weekView(days, weekIndex) {
  if (!Number.isInteger(weekIndex) || weekIndex < 0 || !days.length) throw Error('Invalid week selection.');
  const first = dayNumber(days[0].date);
  const start = first - (weekday(first) + 6) % 7 + weekIndex * 7;
  return {startDate:dateAt(start), endDate:dateAt(start + 6),
    dayIndices:days.flatMap((day,index) => {
      const offset = dayNumber(day.date) - start;
      return offset >= 0 && offset < 7 ? [index] : [];
    })};
}

export function rebasePlan(days, tasks, newDays) {
  const indices = new Map(newDays.map((day,index) => [day.date,index]));
  const oldDays = new Map(days.map(day => [day.date,day]));
  return {
    days:newDays.map(day => ({...day,busyWindows:(oldDays.get(day.date)?.busyWindows ?? []).map(window => [...window])})),
    tasks:tasks.map(task => {
      const targetDay = indices.get(days[task.targetDay].date);
      const hardDay = indices.get(days[task.hardDay].date);
      const earliestDate = days[task.earliestDay].date;
      const earliestDay = earliestDate < newDays[0].date ? 0 : indices.get(earliestDate);
      if ([targetDay,hardDay,earliestDay].some(index => index === undefined)) {
        throw Error(`Loaded weeks must include the active dates for ${task.title}.`);
      }
      return {...task,targetDay,hardDay,earliestDay};
    })
  };
}
