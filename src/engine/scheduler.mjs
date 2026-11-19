import { makeSlots, SLOT_MINUTES } from './capacity.mjs';
import { lexical } from './dates.mjs';

export const TASK_TYPES = Object.freeze(['problem_set','lab','report','reading','project','club','other']);
const durationKeys = {optimistic: 'min', typical: 'likely', conservative: 'max'};
export const isHalfHour = hours => Number.isFinite(hours) && hours >= 0 && Number.isSafeInteger(hours * 2);

export function validateTasks(tasks, days) {
  if (!Array.isArray(tasks) || !Array.isArray(days)) throw Error('Tasks and loaded days must be arrays.');
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || !task.id.trim() ||
        typeof task.title !== 'string' || !task.title.trim()) throw Error('Task needs a non-empty ID and title.');
    const {id, title, targetDay, hardDay, earliestDay, min, likely, max} = task;
    if (ids.has(id)) throw Error(`Duplicate task ID: ${id}`);
    ids.add(id);
    if (![targetDay, hardDay].every(Number.isInteger) || targetDay < 0 || targetDay > hardDay || hardDay >= days.length) {
      throw Error(`Invalid target/hard deadline for ${title}.`);
    }
    if (!Number.isInteger(earliestDay) || earliestDay < 0 || earliestDay > hardDay) throw Error(`Invalid earliest start for ${title}.`);
    if (![min, likely, max].every(isHalfHour)) throw Error(`Use non-negative half-hour duration increments for ${title}.`);
    if (min > likely || likely > max) throw Error(`Invalid duration range for ${title}: minimum ≤ typical ≤ maximum.`);
    if (task.splittable === false) throw Error(`Uninterrupted task ${title} is unsupported; add it as a fixed busy appointment.`);
    if (![1, 2].includes(task.priority)) throw Error(`Invalid priority for ${title}.`);
    if (task.type !== undefined && !TASK_TYPES.includes(task.type)) throw Error(`Invalid task type for ${title}.`);
    if (task.reduceBy !== undefined && !isHalfHour(task.reduceBy)) throw Error(`Invalid scope reduction for ${title}.`);
  }
}

export function prepareSchedule(days, sleep) {
  const slots = makeSlots(days, sleep);
  const byDay = days.map(() => []);
  for (const slot of slots) byDay[slot.dayIndex].push(slot);
  return byDay;
}

export function deadlineKey(deadline = 'target') {
  if (deadline !== 'target' && deadline !== 'hard') throw Error('Invalid deadline mode.');
  return deadline + 'Day';
}

export function orderTasks(tasks, key) {
  return tasks.filter(t => !t.removed).sort((a,b) =>
    a[key] - b[key] || a.priority - b.priority || lexical(a.id, b.id));
}

// With identical slots within a day, EDF can allocate a run to each eligible
// task in priority order. Repair trials can skip materializing individual slots.
export function runSchedule(tasks, ordered, days, slots, dueKey, duration, detailed = true) {
  const remaining = ordered.map(t => t[duration] * 2);
  const late = detailed ? ordered.map(() => 0) : null;
  const alloc = detailed ? [] : null;
  const byDay = detailed ? [] : null;
  let capacity = 0;
  let demand = 0;
  let nextDue = 0;
  let minMargin = null;
  let feasible = true;
  const deadlineMargins = detailed ? [] : null;

  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const today = slots[dayIndex];
    let used = 0;
    const assigned = detailed ? [] : null;
    for (let i = 0; i < ordered.length && used < today.length; i++) {
      const task = ordered[i];
      if (!remaining[i] || task.earliestDay > dayIndex) continue;
      const count = Math.min(remaining[i], today.length - used);
      remaining[i] -= count;
      if (detailed) {
        const isLate = dayIndex > task[dueKey];
        if (isLate) late[i] += count;
        for (let j = 0; j < count; j++) {
          const entry = {...today[used + j], taskId: task.id, taskTitle: task.title, minutes: SLOT_MINUTES, late: isLate};
          assigned.push(entry);
          alloc.push(entry);
        }
      }
      used += count;
    }
    capacity += today.length * SLOT_MINUTES;
    if (detailed) byDay.push({date: days[dayIndex].date, index: dayIndex, capacity: today.length * SLOT_MINUTES, assigned});
    if (ordered[nextDue]?.[dueKey] !== dayIndex) continue;
    while (ordered[nextDue]?.[dueKey] === dayIndex) {
      demand += ordered[nextDue][duration] * 60;
      if (remaining[nextDue]) {
        if (!detailed) return {feasible:false, minMargin:null};
        feasible = false;
      }
      nextDue++;
    }
    const margin = capacity - demand;
    minMargin = minMargin === null ? margin : Math.min(minMargin, margin);
    if (detailed) deadlineMargins.push({dayIndex, capacity, demand, margin});
  }

  if (!detailed) return {feasible, minMargin};
  const resultsById = new Map(ordered.map((task, index) => {
    const required = task[duration] * 60;
    const missing = remaining[index] * SLOT_MINUTES;
    const lateMinutes = late[index] * SLOT_MINUTES;
    return [task.id, {id: task.id, title: task.title, required, scheduled: required - missing,
      missing, late: lateMinutes, shortByDeadline: missing + lateMinutes, dueDay: task[dueKey]}];
  }));
  const taskResults = tasks.filter(t => !t.removed).map(t => resultsById.get(t.id));
  const misses = taskResults.filter(t => t.shortByDeadline > 0);
  return {feasible, lateMinutes: misses.reduce((sum, t) => sum + t.shortByDeadline, 0),
    requiredMinutes: demand, capacityMinutes: capacity, alloc, byDay, taskResults, misses, deadlineMargins};
}

export function schedule(tasks, days, {sleep, estimate = 'typical', deadline} = {}) {
  validateTasks(tasks, days);
  const dueKey = deadlineKey(deadline);
  if (!Object.hasOwn(durationKeys, estimate)) throw Error(`Invalid estimate: ${estimate}.`);
  return runSchedule(tasks, orderTasks(tasks, dueKey), days, prepareSchedule(days, sleep), dueKey, durationKeys[estimate]);
}
