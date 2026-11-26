// Pure model for the My week agenda. Everything comes from the loaded days and the
// engine's typical schedule; nothing is invented here.
import { formatTime } from '../engine/capacity.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { fmtShortDate } from './dom.mjs';

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

export function buildAgenda({ state, derived }) {
  const schedule = derived.evaluation.typical;
  return derived.week.dayIndices.map(index => {
    const day = state.days[index];
    const byDay = schedule.byDay?.find(entry => entry.index === index);
    const entries = [];
    for (const [start, end] of day.busyWindows ?? []) {
      entries.push({ kind: 'busy', sort: toMinutes(start), label: 'Busy', time: `${start}–${end}` });
    }
    for (const group of groupAssigned(byDay?.assigned)) {
      entries.push({
        kind: 'work',
        sort: group.startMinutes,
        label: group.late ? `${group.title} (after its target day)` : group.title,
        time: `${formatTime(group.startMinutes)}–${formatTime(group.endMinutes)}`
      });
    }
    entries.sort((a, b) => a.sort - b.sort);
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
      freeHours: (byDay?.capacity ?? 0) / 60,
      hasWindows: (day.workWindows ?? []).length > 0
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
