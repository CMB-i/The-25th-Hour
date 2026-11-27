// Pure model for Home: the hero line, the week strip and Recent checks. Everything comes from the
// plan and the engine's schedule; nothing here is invented or hard-coded.
import { weekdayName } from '../engine/dates.mjs';
import { deadlineCost } from '../engine/evaluate.mjs';
import { campusDate } from '../engine/feedback.mjs';
import { weekView } from '../engine/weeks.mjs';
import { conflictClause, dayLabel, hoursPhrase } from './check-model.mjs';
import { hasWorkWindows } from './hours-editor.mjs';
import { dayFreeTime, hoursText, onTimeSlots } from './week-model.mjs';

const WEEKDAYS_UPPER = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export function dayPart(hour) {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

/** "WEDNESDAY EVENING", or "GOOD EVENING, SAM" when the student gave a name. */
export function greetingEyebrow(now, name = '') {
  const part = dayPart(now.getHours());
  const who = String(name ?? '').trim();
  if (who) return `GOOD ${part === 'night' ? 'EVENING' : part.toUpperCase()}, ${who.toUpperCase()}`;
  return `${WEEKDAYS_UPPER[now.getDay()]} ${part.toUpperCase()}`;
}

function namesList(titles) {
  if (titles.length <= 2) return titles.join(' and ');
  return `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`;
}

/**
 * One observation about the loaded week, computed from engine output only.
 * Returns null when there is nothing in the plan to observe.
 */
export function observeWeek(state, derived) {
  const { evaluation } = derived;
  const typicalCost = deadlineCost(evaluation.typical, state.days);
  if (!derived.activeTasks.length || !typicalCost || !hasWorkWindows(state.days)) return null;
  if (!evaluation.typical.feasible) {
    const clause = conflictClause(evaluation.typical, state.days);
    if (clause?.kind === 'hours') {
      const dueThen = derived.activeTasks.filter(task => state.days[task.targetDay]?.date === clause.date);
      const titles = dueThen.map(task => task.title);
      const subject = titles.length
        ? `Your ${namesList(titles)} ${titles.length === 1 ? 'is' : 'are'} due ${dayLabel(clause.date)}`
        : `You have work due ${dayLabel(clause.date)}`;
      return { text: `${subject} and you're ${hoursPhrase(clause.hours)} short.`, atRisk: true, kind: 'short' };
    }
    return { text: clause ? `You're ${clause.text}.` : 'A deadline is already out of reach.', atRisk: true, kind: 'short' };
  }
  if (evaluation.verdict === 'at-risk') {
    return {
      text: `Everything fits, but ${dayLabel(typicalCost.date)} has only ${hoursPhrase(Math.max(0, typicalCost.marginHours))} to spare.`,
      atRisk: true,
      kind: 'tight'
    };
  }
  return {
    text: `You have ${hoursPhrase(Math.max(0, typicalCost.marginHours))} of real slack by ${weekdayName(typicalCost.date)}.`,
    atRisk: false,
    kind: 'slack',
    marginHours: typicalCost.marginHours,
    boundaryIndex: typicalCost.dayIndex
  };
}

/**
 * Real free time in the work windows for the rest of this week (today included), straight from the
 * engine's slots: work window minus busy blocks minus sleep minus planned work.
 */
export function freeThisWeek({ state, derived, now }) {
  const today = todayIndex(state, now);
  const weekIndex = today >= 0 ? Math.floor(today / 7) : derived.weekIndex;
  const week = weekView(state.days, weekIndex);
  const byDay = derived.evaluation.typical.byDay ?? [];
  let freeMinutes = 0;
  let windowMinutes = 0;
  for (const index of week.dayIndices) {
    if (today >= 0 && index < today) continue;
    const entry = byDay.find(item => item.index === index);
    const free = dayFreeTime({ day: derived.planDays?.[index] ?? state.days[index], sleep: state.sleep, assigned: onTimeSlots(entry?.assigned, index, derived.activeTasks) });
    freeMinutes += free.freeMinutes;
    windowMinutes += free.windowMinutes;
  }
  return { freeMinutes, windowMinutes, share: windowMinutes ? freeMinutes / windowMinutes : 0 };
}

/** Index of today in the loaded days, or -1 when today is outside them. */
export function todayIndex(state, now) {
  return state.days.findIndex(day => day.date === campusDate(now.toISOString()));
}

/** "Monday and Tuesday are full." for the days up to the boundary whose free time is used up. */
function fullDaysSentence(state, derived, fromIndex, toIndex) {
  const byDay = derived.evaluation.typical.byDay ?? [];
  const full = [];
  for (let index = Math.max(0, fromIndex); index <= toIndex; index++) {
    const entry = byDay.find(item => item.index === index);
    if (!entry || entry.capacity <= 0) continue;
    if (entry.assigned.length * 30 >= entry.capacity) full.push(weekdayName(state.days[index].date));
  }
  if (!full.length) return 'No day is full yet.';
  if (full.length === 1) return `${full[0]} is full.`;
  return `${full.slice(0, -1).join(', ')} and ${full[full.length - 1]} are full.`;
}

/** Nothing due: say what is true about the free time, not that the week is open. */
function emptyHero({ state, derived, now, eyebrow }) {
  const { freeMinutes, share } = freeThisWeek({ state, derived, now });
  const free = hoursText(freeMinutes);
  const ask = "Nothing is due yet. Tell me what you're thinking of taking on.";
  if (freeMinutes <= 0) {
    return { eyebrow, kind: 'empty', title: 'The rest of this week is full.', sub: 'Classes, busy blocks and sleep take all your work hours.' };
  }
  if (share >= 0.75) {
    return { eyebrow, kind: 'empty', title: 'Your week is wide open.', sub: `${free} free in your work hours. ${ask}` };
  }
  return {
    eyebrow, kind: 'empty',
    title: `You have ${free} free this week.`,
    sub: `That is what is left of your work hours after classes and busy blocks. ${ask}`
  };
}

/**
 * Hero: eyebrow, headline and one plain sentence. `kind` tells the page how to style it.
 */
export function buildHero({ state, derived, now }) {
  const eyebrow = greetingEyebrow(now, state.displayName);
  if (!hasWorkWindows(state.days)) {
    return {
      eyebrow, kind: 'nohours',
      title: 'Your week is a blank page.',
      sub: "I don't know your work hours yet, so I can't tell you how much slack you have.",
      link: 'Set my work hours'
    };
  }
  if (!derived.activeTasks.length) return emptyHero({ state, derived, now, eyebrow });
  const observation = observeWeek(state, derived);
  if (!observation) return emptyHero({ state, derived, now, eyebrow });
  if (observation.kind === 'slack') {
    const today = todayIndex(state, now);
    const sentence = fullDaysSentence(state, derived, today < 0 ? 0 : today, observation.boundaryIndex);
    return { eyebrow, kind: 'slack', title: observation.text, sub: `${sentence} Worth knowing before the next yes.`, observation };
  }
  return {
    eyebrow,
    kind: observation.kind,
    title: observation.text,
    sub: observation.kind === 'short' ? "Let's see what can move." : 'Worth knowing before the next yes.',
    observation
  };
}

/** Planned versus room to work for the week containing today (or the shown week). Read-only. */
export function buildWeekStrip({ state, derived, now }) {
  const today = todayIndex(state, now);
  const weekIndex = today >= 0 ? Math.floor(today / 7) : derived.weekIndex;
  const week = weekView(state.days, weekIndex);
  const typical = derived.evaluation.typical;
  const over = new Set((typical.misses ?? []).map(miss => miss.dueDay));
  const cols = week.dayIndices.map(index => {
    const entry = typical.byDay?.find(item => item.index === index);
    const cap = (entry?.capacity ?? 0) / 60;
    const used = (onTimeSlots(entry?.assigned, index, derived.activeTasks).length * 30) / 60;
    const free = dayFreeTime({ day: derived.planDays?.[index] ?? state.days[index], sleep: state.sleep, assigned: onTimeSlots(entry?.assigned, index, derived.activeTasks) });
    return {
      index,
      past: (derived.planDays?.[index]?.elapsed ?? null) === 'past',
      cap,
      freeHours: free.freeMinutes / 60,
      used: Math.min(used, cap),
      over: over.has(index),
      label: weekdayName(state.days[index].date).slice(0, 1),
      isToday: index === today
    };
  });
  const maxCap = Math.max(1, ...cols.map(col => col.cap));
  const px = Math.min(12, 84 / maxCap);
  const slack = cols.reduce((sum, col) => sum + col.freeHours, 0);
  const perDay = cols.map(col => col.past ? `${weekdayName(state.days[col.index].date)} past` : `${weekdayName(state.days[col.index].date)} ${hoursText(col.freeHours * 60)} free`).join(', ');
  const label = `This week: ${hoursText(slack * 60)} free in your work hours. ${perDay}. ` +
    (cols.filter(col => col.over).length ? `Over on ${cols.filter(col => col.over).map(col => weekdayName(state.days[col.index].date)).join(', ')}.` : 'No day is over.');
  return { cols, px, maxCap, label, hasData: cols.some(col => col.cap > 0) };
}

/** Recent checks: decisions (yes/no) plus anything still being decided. Newest first. */
export function buildRecents(state, limit = 3) {
  const meta = item => `${hoursPhrase(item.hours ?? item.likely)} · ${item.audience === 'self' ? 'my own' : 'asked by someone else'}`;
  const deciding = state.proposals.map(item => ({ title: item.title, meta: meta(item), status: 'deciding', label: 'Still deciding' }));
  const decided = [...(state.decisions ?? [])].reverse().map(item => ({
    title: item.title,
    meta: meta(item),
    status: item.status,
    label: item.status === 'yes' ? 'Said yes' : 'Said no'
  }));
  return [...deciding, ...decided].slice(0, limit);
}
