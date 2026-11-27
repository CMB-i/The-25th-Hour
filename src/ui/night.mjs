// Night: the wind-down theme and the "This can wait till morning" claim.
// The claim is only made when an engine run confirms it (see verifyWait).
import { effectiveDays } from './elapsed.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { evaluate } from '../engine/evaluate.mjs';
import { campusDate } from '../engine/feedback.mjs';

const toMinutes = time => {
  const [hh, mm] = String(time).split(':').map(Number);
  return hh * 60 + mm;
};

/** Wind-down starts an hour before sleep and lasts until the sleep window ends. */
export function windDownStart(sleep) {
  return ((toMinutes(sleep.start) - 60) % 1440 + 1440) % 1440;
}

export function isNight(now, sleep) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = windDownStart(sleep);
  const end = toMinutes(sleep.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** "11:20 PM" for the eyebrow. */
export function clockText(now) {
  const hh = now.getHours();
  const mm = now.getMinutes();
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}

/** The first day work can start after waking: tomorrow before midnight, today after it. */
export function morningIndex(state, now) {
  const today = state.days.findIndex(day => day.date === campusDate(now.toISOString()));
  if (today < 0) return -1;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= windDownStart(state.sleep) ? today + 1 : today;
}

/**
 * Does the work still fit if nothing starts before morning? Runs the engine with the new work, and every
 * task that is still due from morning on, unable to start earlier (so nothing else is assumed to get done
 * tonight). Returns the numbers for the page, or null when the claim cannot be confirmed.
 */
export function verifyWait({ state, derived, proposal, now }) {
  if (!isNight(now, state.sleep)) return null;
  const morning = morningIndex(state, now);
  if (morning < 0 || morning >= state.days.length) return null;
  if (proposal.targetDay < morning) return null; // due before it could start
  const shift = task => task.targetDay >= morning
    ? { ...task, earliestDay: Math.max(task.earliestDay ?? 0, morning) }
    : task;
  // Work already due before morning is outside this claim: its time has gone, and it is reported elsewhere.
  const tasks = [...derived.activeTasks.filter(task => task.targetDay >= morning).map(shift), shift(proposal)];
  let result;
  try {
    result = evaluate(tasks, effectiveDays(state.days, now), derived.options);
  } catch {
    return null;
  }
  if (!result.typical.feasible || result.verdict === 'infeasible') return null;

  const window = [];
  for (let index = morning; index <= proposal.targetDay; index++) window.push(index);
  let capacity = 0;
  let others = 0;
  for (const index of window) {
    const entry = result.typical.byDay.find(item => item.index === index);
    if (!entry) continue;
    capacity += entry.capacity;
    others += entry.assigned.filter(slot => slot.taskId !== proposal.id).length * 30;
  }
  const free = Math.max(0, (capacity - others) / 60);
  return {
    morningIndex: morning,
    dayNames: window.map(index => weekdayName(state.days[index].date)),
    dueName: weekdayName(state.days[proposal.targetDay].date),
    need: proposal.likely,
    free,
    spare: Math.max(0, free - proposal.likely),
    tight: result.verdict === 'at-risk'
  };
}

export function namesJoined(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
