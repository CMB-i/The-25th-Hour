// Pure model for the My week agenda. Everything comes from the loaded days and the
// engine's typical schedule; nothing is invented here.
import { formatTime, makeSlots } from '../engine/capacity.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { fmtShortDate } from './dom.mjs';
import { labelInfo } from './ics-labels.mjs';

/** Groups consecutive scheduled slots for the same task into one entry. */
function groupAssigned(assigned = []) {
  const groups = [];
  for (const slot of [...assigned].sort((a, b) => a.start - b.start)) {
    const prev = groups[groups.length - 1];
    if (prev && prev.title === slot.taskTitle && prev.endMinutes === slot.start && prev.late === Boolean(slot.late)) {
      prev.endMinutes = slot.end;
    } else {
      groups.push({ title: slot.taskTitle, startMinutes: slot.start, endMinutes: slot.end, late: Boolean(slot.late) });
    }
  }
  return groups;
}

/** "16:00" -> "4:00 pm". */
export function clock12(time) {
  const [hh, mm] = String(time).split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'pm' : 'am'}`;
}

/**
 * Work the engine placed after its task's deadline is not shown: the UI plans only what fits before the deadline
 * and shows what does not as a shortfall marker. (The engine may still place such work; that is handled here.)
 */
export function onTimeSlots(assigned = [], dayIndex, tasks = []) {
  const due = new Map(tasks.map(task => [task.id, task.targetDay]));
  return assigned.filter(slot => !slot.late && (due.get(slot.taskId) === undefined || dayIndex <= due.get(slot.taskId)));
}

export function buildAgenda({ state, derived }) {
  const schedule = derived.evaluation.typical;
  const numbers = derived.numbers;
  return derived.week.dayIndices.map(index => {
    const day = state.days[index];
    const byDay = schedule.byDay?.find(entry => entry.index === index);
    const entries = [];
    for (const [start, end] of day.busyWindows ?? []) {
      const info = labelInfo(state.busyLabels?.[`${day.date}|${start}|${end}`]);
      // Show the real class time when the calendar gave one; the engine's rounded block is what is counted.
      const shownFrom = info.from || start;
      const shownTo = info.to || end;
      entries.push({
        kind: 'busy', sort: toMinutes(start), label: info.title, room: info.room,
        time: `${clock12(shownFrom)} to ${clock12(shownTo)}`, start, end,
        from: toMinutes(start), to: end === '24:00' ? 1440 : toMinutes(end),
        shownFrom: toMinutes(shownFrom), shownTo: shownTo === '24:00' ? 1440 : toMinutes(shownTo)
      });
    }
    const onTime = onTimeSlots(byDay?.assigned, index, derived.activeTasks);
    for (const group of groupAssigned(onTime)) {
      entries.push({
        kind: 'work',
        sort: group.startMinutes,
        from: group.startMinutes,
        to: group.endMinutes,
        late: group.late,
        label: group.late ? `${group.title} (after its target day)` : group.title,
        time: `${clock12(formatTime(group.startMinutes))} to ${clock12(formatTime(group.endMinutes))}`
      });
    }
    entries.sort((a, b) => a.sort - b.sort);
    const free = dayFreeTime({ day: derived.planDays?.[index] ?? day, sleep: state.sleep, assigned: onTime });
    const due = derived.activeTasks
      .filter(task => task.targetDay === index)
      .map(task => ({ id: task.id, title: task.title, hours: task.likely, isProposal: Boolean(task.isProposal) }));
    return {
      index,
      date: day.date,
      weekday: weekdayName(day.date),
      short: `${weekdayName(day.date).slice(0, 3)} ${fmtShortDate(day.date).split(' ')[0]}`,
      label: `${weekdayName(day.date)} ${fmtShortDate(day.date)}`,
      entries,
      due,
      freeHours: free.freeMinutes / 60,
      capacityHours: free.openMinutes / 60,
      free,
      hasWindows: (day.workWindows ?? []).length > 0,
      shortHours: numbers && numbers.short > 0 && numbers.dayIndex === index ? numbers.short : 0,
      elapsed: derived.planDays?.[index]?.elapsed ?? null,
      elapsedUntil: derived.planDays?.[index]?.elapsed === 'past' ? 1440 : (derived.planDays?.[index]?.elapsedUntil ?? 0)
    };
  });
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Calendar status in words, evidence-based. */
export function calendarStatus(state, nowMs = Date.now()) {
  if (!state.calendarImportedAt) {
    return { kind: 'none', stale: false };
  }
  const imported = Date.parse(state.calendarImportedAt);
  const stale = !Number.isFinite(imported) || nowMs - imported > 86_400_000;
  return { kind: 'imported', stale, at: state.calendarImportedAt };
}

const SLOT = 30;

/** Sleep as [start, end] minute ranges inside one day, the same way the engine blocks it. */
export function sleepRangesOf(sleep) {
  const start = toMinutes(sleep.start);
  const end = toMinutes(sleep.end);
  if (start === end) return [];
  return start < end ? [[start, end]] : [[start, 1440], [0, end]];
}

function mergeSlots(starts) {
  const bands = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const last = bands[bands.length - 1];
    if (last && last.end === start) last.end = start + SLOT;
    else bands.push({ start, end: start + SLOT });
  }
  return bands;
}

/**
 * Where one day's free time comes from, as arithmetic the student can check:
 *   work window  -  busy blocks  -  protected sleep  =  open to work,  and  open  -  planned deadline work  =  free.
 * Uses the engine's own slots, so it always matches what the checks count.
 * `bands` are the contiguous free stretches (after planned work), for drawing and labelling.
 */
export function dayFreeTime({ day, sleep, assigned = [] }) {
  const windows = (day.workWindows ?? []).map(([from, to]) => [toMinutes(from), to === '24:00' ? 1440 : toMinutes(to)]);
  const windowMinutes = windows.reduce((sum, [from, to]) => sum + (to - from), 0);
  const open = new Set(makeSlots([day], sleep).map(slot => slot.start));
  const planned = new Set(assigned.map(slot => slot.start));
  const freeStarts = [...open].filter(start => !planned.has(start));
  const sleepRanges = sleepRangesOf(sleep);
  let busyMinutes = 0;
  let sleepMinutes = 0;
  let elapsedMinutes = 0;
  const gone = day.elapsed === 'past' ? 1440 : (day.elapsedUntil ?? 0);
  for (const [from, to] of windows) {
    for (let t = from; t < to; t += SLOT) {
      if (open.has(t)) continue;
      if (t < gone) { elapsedMinutes += SLOT; continue; } // time that has already gone by is not free time
      const asleep = sleepRanges.some(([a, b]) => t < b && a < t + SLOT);
      if (asleep) sleepMinutes += SLOT;
      else busyMinutes += SLOT;
    }
  }
  const plannedMinutes = [...planned].filter(start => open.has(start)).length * SLOT;
  const openMinutes = open.size * SLOT;
  return {
    windowMinutes, busyMinutes, sleepMinutes, elapsedMinutes, openMinutes, plannedMinutes,
    freeMinutes: freeStarts.length * SLOT,
    bands: mergeSlots(freeStarts)
  };
}

/** "3.5h" style, never "3.0h". */
export function hoursText(minutes) {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

/** Free hours across the shown week, counting only days that are not already over. */
export function weekFreeTotal(agenda, todayDate) {
  return agenda
    .filter(day => !todayDate || day.date >= todayDate)
    .reduce((sum, day) => sum + day.freeHours, 0);
}
