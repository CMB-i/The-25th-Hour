import { dayNumber } from './dates.mjs';
import { deadlineCost, evaluate } from './evaluate.mjs';
import { findRepairs } from './repairs.mjs';
import { isHalfHour, TASK_TYPES, validateTasks } from './scheduler.mjs';

export const roundHalfHour = hours => Math.round(hours * 2) / 2;
export const defaultRange = likely => ({
  min: Math.max(0.5, roundHalfHour(0.8 * likely)),
  max: roundHalfHour(1.4 * likely)
});
const missing = value => value === '' || value === null || value === undefined;
const tags = ['must-keep','flexible','droppable'];

export function taskDates(days, deadline, tag, latestDate, earliestDate) {
  if (!tags.includes(tag)) throw Error('Invalid priority tag.');
  const indexOf = date => Number.isFinite(dayNumber(date)) ? days.findIndex(day => day?.date === date) : -1;
  const targetDay = indexOf(deadline);
  if (targetDay < 0) throw Error('Deadline must be a valid date in the loaded weeks.');
  if (tag !== 'flexible' && !missing(latestDate)) throw Error('Latest acceptable date applies to flexible tasks only.');
  const hardDay = tag !== 'flexible' ? targetDay : missing(latestDate) ?
    Math.min(targetDay + 1, days.length - 1) : indexOf(latestDate);
  if (hardDay < targetDay) throw Error('Latest acceptable date must be on or after the deadline in the loaded weeks.');
  const earliestDay = missing(earliestDate) ? 0 : indexOf(earliestDate);
  if (earliestDay < 0 || earliestDay > hardDay) throw Error('Earliest start must be in the loaded weeks and on or before the hard deadline.');
  return {targetDay, hardDay, earliestDay, priority: tag === 'must-keep' ? 1 : 2,
    flexible: tag === 'flexible' && hardDay > targetDay, allowDrop: tag === 'droppable'};
}

export function uniqueId(base, ids) {
  let id = base;
  let n = 2;
  while (ids.has(id)) id = `${base}:${n++}`;
  ids.add(id);
  return id;
}

export function createProposal(fields, days, {existingTasks = [], notBeforeDate} = {}) {
  const title = typeof fields?.title === 'string' ? fields.title.trim() : '';
  if (!title || title.length > 80) throw Error('Name must contain 1 to 80 characters.');
  const {likely, deadline, tag = 'must-keep', latestDate, earliestDate, type = 'other'} = fields;
  if (!isHalfHour(likely) || likely < 0.5 || likely > 40) throw Error('Typical hours must be 0.5 to 40 in half-hour increments.');
  if (!TASK_TYPES.includes(type)) throw Error('Invalid task type.');
  const dates = taskDates(days, deadline, tag, latestDate, earliestDate);
  if (notBeforeDate && dayNumber(deadline) < dayNumber(notBeforeDate)) throw Error('Deadline has already passed.');
  const range = defaultRange(likely);
  const id = uniqueId('proposal', new Set(existingTasks.map(task => task.id)));
  const task = {id, title, type, likely, min: missing(fields.min) ? range.min : fields.min,
    max: missing(fields.max) ? range.max : fields.max, ...dates, splittable: true, isProposal: true};
  validateTasks([task], days);
  return task;
}

export function evaluateCommitments(tasks, proposals, days, options = {}) {
  validateTasks([...tasks, ...proposals], days);
  function outcome(drafts) {
    const combined = [...tasks, ...drafts];
    const evaluation = evaluate(combined, days, options);
    return {proposalIds: drafts.map(task => task.id), evaluation, cost: deadlineCost(evaluation.typical, days),
      repairs: drafts.length ? findRepairs(combined, days, options) : []};
  }
  const before = outcome([]);
  const separate = proposals.map(proposal => outcome([proposal]));
  const together = proposals.length > 1 ? outcome(proposals) : separate[0] ?? null;
  return {before, separate, together};
}
