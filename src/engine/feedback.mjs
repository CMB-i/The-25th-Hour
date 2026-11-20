import { dateAt, dayNumber } from './dates.mjs';
import { isHalfHour, TASK_TYPES } from './scheduler.mjs';
import { roundHalfHour } from './commitments.mjs';

export function updateEstimateProfile(profile, {type, estimatedLikely, actualHours} = {}) {
  if (!TASK_TYPES.includes(type)) throw Error('Use a supported task type.');
  if (!isHalfHour(estimatedLikely) || estimatedLikely === 0 || !isHalfHour(actualHours)) {
    throw Error('Estimate must be positive and actual hours non-negative, in half-hour increments.');
  }
  const {samples = 0, ratio = 1} = profile ?? {};
  if ((profile && profile.type !== type) || !Number.isInteger(samples) || samples < 0 ||
      !Number.isFinite(ratio) || ratio < 0.5 || ratio > 3) throw Error('Invalid estimate profile.');
  const learned = 0.6 * ratio + 0.4 * (actualHours / estimatedLikely);
  return {type, samples:samples + 1, ratio:Math.max(0.5, Math.min(3, learned))};
}

export function getEstimateSuggestion(profile, typicalHours) {
  if (!profile || profile.samples < 3) return null;
  if (!isHalfHour(typicalHours)) throw Error('Use half-hour estimate increments.');
  return roundHalfHour(profile.ratio * typicalHours);
}

export function campusDate(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d\d:\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/.exec(timestamp);
  if (!match || !Number.isFinite(dayNumber(match[1]))) return null;
  const [, date, clock, seconds = '00', fraction = '', zone] = match;
  if (!clock) return date;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock) || +seconds > 59) return null;
  if (!zone) return date;
  const ms = Date.parse(`${date}T${clock}:${seconds}${fraction}${zone}`);
  return Number.isFinite(ms) ? dateAt(Math.floor((ms + 19_800_000) / 86_400_000)) : null;
}

export function buildEstimateProfiles(feedback) {
  const profiles = new Map();
  for (const entry of feedback) {
    const profile = updateEstimateProfile(profiles.get(entry.type), entry);
    profiles.set(entry.type, profile);
  }
  return TASK_TYPES.map(type => profiles.get(type) ?? {type, samples:0, ratio:1});
}

export function sevenDayReview({feedback = [], sleepReports = [], appliedChanges = [], tasks = [], days = [], throughDate}) {
  const lastDay = dayNumber(throughDate);
  if (!Number.isFinite(lastDay)) throw Error('Provide a valid seven-day review end date.');
  const fromDate = dateAt(lastDay - 6);
  const recent = date => date >= fromDate && date <= throughDate;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const profiles = buildEstimateProfiles(feedback);
  const estimates = feedback.flatMap(entry => {
    const date = campusDate(entry.recordedAt);
    if (!recent(date)) return [];
    const task = byId.get(entry.taskId);
    const targetDate = entry.targetDate ?? days[task?.targetDay]?.date ?? null;
    const hardDate = entry.hardDate ?? days[task?.hardDay]?.date ?? null;
    return [{...entry, title:entry.title ?? task?.title ?? entry.taskId, date, targetDate, hardDate,
      metTarget:targetDate ? date <= targetDate : null, metHardDeadline:hardDate ? date <= hardDate : null,
      ratio:profiles.find(profile => profile.type === entry.type).ratio}];
  });
  const reports = sleepReports.filter(report => recent(report.date)).map(report => ({
    ...report, plannedHours:report.plannedSleepMinutes / 60, differenceHours:report.hoursSlept - report.plannedSleepMinutes / 60
  }));
  const plannedDays = days.filter(day => recent(day.date)).length;
  const averageSleepHours = reports.length ? reports.reduce((sum, report) => sum + report.hoursSlept, 0) / reports.length : null;
  return {fromDate, throughDate, profiles, estimates, reports,
    adjustments:appliedChanges.filter(change => recent(campusDate(change.recordedAt))).map(change => ({
      recordedAt:change.recordedAt, approved:change.approved ?? false, labels:[...(change.labels ?? [])]
    })),
    plannedDays, averageSleepHours,
    summary:`Your plan kept protected sleep time free on ${plannedDays} of ${plannedDays} loaded days in this review.` +
      (reports.length ? ` You reported ${Number(averageSleepHours.toFixed(2))}h on average on ${reports.length} logged ${reports.length === 1 ? 'night' : 'nights'}.` : '') +
      " A feasible plan makes room to sleep; it can't guarantee sleep."};
}
