import { makeSlots, SLOT_MINUTES } from './capacity.mjs';
import { weekdayName } from './dates.mjs';
import { validateTasks, deadlineKey, orderTasks, prepareSchedule, runSchedule } from './scheduler.mjs';

export function prepareEvaluation(days, {sleep, deadline, minimumCushionMinutes = 60} = {}) {
  if (!Number.isFinite(minimumCushionMinutes) || minimumCushionMinutes < 0) throw Error('Invalid deadline cushion.');
  return {days, dueKey: deadlineKey(deadline), slots: prepareSchedule(days, sleep), minimumCushionMinutes};
}

function classify(typical, conservative, minMargin, cushion) {
  if (!typical.feasible) return ['infeasible', 'Typical estimates miss at least one deadline.'];
  if (!conservative.feasible) return ['at-risk', 'Typical estimates fit, but conservative estimates miss a deadline.'];
  if (minMargin !== null && minMargin < cushion) {
    return ['at-risk', `All estimates fit, but at least one deadline has less than ${cushion / 60}h of conservative slack.`];
  }
  return ['feasible', 'Even conservative estimates fit with the required deadline buffer.'];
}

export function evaluatePrepared(tasks, {days, dueKey, slots, minimumCushionMinutes}, detailed = true) {
  const ordered = orderTasks(tasks, dueKey);
  const run = (duration) => runSchedule(tasks, ordered, days, slots, dueKey, duration, detailed);
  const typical = run('likely');
  if (!detailed && !typical.feasible) return 'infeasible';
  const conservative = run('max');
  const minMargin = detailed ? bindingMargin(conservative)?.margin ?? null : conservative.minMargin;
  const [verdict, reason] = classify(typical, conservative, minMargin, minimumCushionMinutes);
  if (!detailed) return verdict;
  return {verdict, reason, minMargin, optimistic: run('min'), typical, conservative};
}

export function evaluate(tasks, days, options = {}) {
  validateTasks(tasks, days);
  return evaluatePrepared(tasks, prepareEvaluation(days, options));
}

export function weeklyCheck(tasks, days, options = {}) {
  validateTasks(tasks, days);
  const requiredMinutes = tasks.filter(t => !t.removed).reduce((sum, t) => sum + t.likely * 60, 0);
  const capacityMinutes = makeSlots(days, options.sleep).length * SLOT_MINUTES;
  return {feasible: requiredMinutes <= capacityMinutes, requiredMinutes, capacityMinutes};
}

export function bindingMargin(schedule) {
  return schedule.deadlineMargins.reduce((best, item) =>
    !best || item.margin < best.margin ? item : best, null);
}

export function deadlineCost(schedule, days) {
  const binding = bindingMargin(schedule);
  if (!binding) return null;
  const {dayIndex, capacity, demand, margin} = binding;
  const date = days[dayIndex].date;
  return {dayIndex, date, weekday: weekdayName(date), availableHours: capacity / 60,
    requiredHours: demand / 60, shortfallHours: Math.max(0, -margin) / 60, marginHours: margin / 60,
    tasks: schedule.taskResults.filter(t => t.dueDay <= dayIndex).map(t => ({id: t.id, title: t.title, hours: t.required / 60}))};
}

export function verdictText(evaluation, days) {
  if (evaluation.verdict === 'feasible') return 'This fits your week.';
  if (evaluation.verdict === 'at-risk') return 'It fits, but there is almost no room for error.';
  const cost = deadlineCost(evaluation.typical, days);
  const actualMiss = evaluation.typical.lateMinutes / 60;
  const releaseNote = actualMiss > cost.shortfallHours
    ? ` The schedule misses ${actualMiss}h across deadlines after accounting for earliest starts.` : '';
  return `This plan can't meet its deadlines. ${cost.weekday} (${cost.date}) has ${cost.requiredHours}h of work due and ${cost.availableHours}h available. Short by ${cost.shortfallHours}h.${releaseNote}`;
}
