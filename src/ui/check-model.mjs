// Pure presentation model for the "Check a request" flow.
// Every number, date and "fits" claim below is read from engine output
// (evaluate / evaluateCommitments / findRepairs / draftApprovalRequest).
// Nothing in this file touches the DOM, storage or the clipboard.
import { weekdayName } from '../engine/dates.mjs';
import { deadlineCost, evaluate } from '../engine/evaluate.mjs';
import { draftApprovalRequest, emptyRepairMessage } from '../engine/repairs.mjs';
import { fmtShortDate } from './dom.mjs';

export function hoursPhrase(hours) {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

export function dayLabel(date) {
  if (!date) return '';
  return `${weekdayName(date)} ${fmtShortDate(date)}`;
}

/**
 * Describes the first deadline conflict in a schedule as a noun clause.
 * Prefers the engine's cumulative hours shortfall; when there is none (for
 * example a release date makes a deadline unreachable) it names the task the
 * engine could not finish in time instead of inventing an hours number.
 */
export function conflictClause(schedule, days) {
  const cost = deadlineCost(schedule, days);
  if (cost && cost.shortfallHours > 0) {
    return {
      kind: 'hours',
      hours: cost.shortfallHours,
      date: cost.date,
      text: `${hoursPhrase(cost.shortfallHours)} short by ${dayLabel(cost.date)}`
    };
  }
  const miss = schedule.misses?.[0];
  if (miss) {
    const date = days[miss.dueDay]?.date;
    return {
      kind: 'deadline',
      hours: miss.shortByDeadline / 60,
      date,
      text: `behind on ${miss.title}, due ${dayLabel(date)} (${hoursPhrase(miss.shortByDeadline / 60)} of it can't be scheduled in time)`
    };
  }
  return null;
}

export const isRepairForRequest = (repair, proposalId) =>
  !repair.actions.some(action => action.type === 'drop' && action.taskId === proposalId);

function describeRepair(repair, days, proposal) {
  const typical = deadlineCost(repair.test.typical, days);
  const proposalAction = repair.actions.find(action =>
    action.taskId === proposal.id && (action.type === 'move' || action.type === 'extend'));
  return {
    id: repair.id,
    repair,
    needsApproval: repair.needsApproval,
    label: repair.actions.map(action => action.label).join(' + '),
    description: repair.actions.map(action => action.description).join(' '),
    resultVerdict: repair.test.verdict,
    resultFits: repair.test.typical.feasible,
    spareHours: typical ? Math.max(0, typical.marginHours) : null,
    spareDate: typical?.date ?? null,
    movesRequestToDay: proposalAction ? proposalAction.toDay : null
  };
}

/**
 * Estimate range for the request alone. The engine's built-in three-estimate
 * run scales every task at once, so to talk about *this request's* hours we
 * re-run the engine with the request at each of its estimates and everything
 * else at typical. Returned only when the answer changes between estimates.
 */
export function buildEstimateRange({ tasks, proposal, days, options }) {
  const hours = [...new Set([proposal.min, proposal.likely, proposal.max])].sort((a, b) => a - b);
  if (hours.length < 2) return null;
  const rows = hours.map(value => {
    const variant = {
      ...proposal,
      likely: value,
      min: Math.min(proposal.min, value),
      max: Math.max(proposal.max, value)
    };
    const typical = evaluate([...tasks, variant], days, options).typical;
    const clause = typical.feasible ? null : conflictClause(typical, days);
    return { hours: value, fits: typical.feasible, clause };
  });
  if (rows.every(row => row.fits === rows[0].fits)) return null;

  // Fitting estimates can share a sentence; every non-fitting estimate has its
  // own shortfall, so each one is reported on its own.
  const fitting = rows.filter(row => row.fits).map(row => `${row.hours}h`);
  const parts = [];
  if (fitting.length) parts.push(`At ${fitting.join(' or ')} it fits.`);
  for (const row of rows.filter(item => !item.fits)) {
    parts.push(row.clause
      ? `At ${row.hours}h ${row.clause.kind === 'hours' ? `you're ${row.clause.text}` : `you'd be ${row.clause.text}`}.`
      : `At ${row.hours}h it doesn't fit.`);
  }
  const sentence = parts.join(' ');
  return { rows, sentence };
}

/**
 * Builds everything the Check screen shows for one pending request.
 * `before` / `after` are the outcomes returned by evaluateCommitments.
 */
export function analyzeRequest({ state, derived, proposal, before, after, smaller = null }) {
  const days = state.days;
  const beforeEval = before.evaluation;
  const afterEval = after.evaluation;
  const fits = afterEval.typical.feasible;
  const tight = fits && afterEval.verdict === 'at-risk';
  const baselineBroken = !beforeEval.typical.feasible;
  const beforeClause = baselineBroken ? conflictClause(beforeEval.typical, days) : null;
  const afterClause = fits ? null : conflictClause(afterEval.typical, days);
  const afterCost = deadlineCost(afterEval.typical, days);

  // ---- verdict sentence ------------------------------------------------
  let kind;
  let headline;
  let detail = '';
  if (!fits) {
    kind = 'short';
    const unchanged = baselineBroken &&
      beforeEval.typical.lateMinutes === afterEval.typical.lateMinutes &&
      beforeClause && afterClause &&
      beforeClause.text === afterClause.text;
    if (baselineBroken && beforeClause && unchanged) {
      headline = `Your week was already ${beforeClause.text}. This request doesn't change that.`;
    } else if (baselineBroken && beforeClause && afterClause) {
      headline = `Your week was already ${beforeClause.text}. With this, you'd be ${afterClause.text}.`;
    } else if (afterClause) {
      headline = `You're ${afterClause.text}.`;
    } else {
      headline = "This doesn't fit before its deadline.";
    }
    if (baselineBroken && !unchanged) {
      detail = "The earlier shortfall isn't caused by this request.";
    }
  } else if (tight) {
    kind = 'tight';
    headline = afterCost
      ? `It fits, with ${hoursPhrase(Math.max(0, afterCost.marginHours))} to spare by ${dayLabel(afterCost.date)}.`
      : 'It fits, but only just.';
    const consClause = !afterEval.conservative.feasible ? conflictClause(afterEval.conservative, days) : null;
    detail = consClause
      ? `If everything runs long, you'd be ${consClause.text}.`
      : 'There is less than an hour of cushion if things run long.';
  } else {
    kind = 'fits';
    headline = afterCost
      ? `Yes, this fits. Your tightest day, ${dayLabel(afterCost.date)}, still has ${hoursPhrase(Math.max(0, afterCost.marginHours))} to spare.`
      : 'Yes, this fits.';
    detail = '';
  }

  // ---- option ----------------------------------------------------------
  const keepsRequest = after.repairs.filter(repair => isRepairForRequest(repair, proposal.id));
  const topRepair = keepsRequest[0] ?? null;
  const selfServeRepair = keepsRequest.find(repair => !repair.needsApproval) ?? null;
  const onlyDeclines = after.repairs.length > 0 && keepsRequest.length === 0;
  const option = (!fits || tight) && topRepair ? describeRepair(topRepair, days, proposal) : null;
  const alternative = option && option.needsApproval && selfServeRepair
    ? describeRepair(selfServeRepair, days, proposal)
    : null;
  const noOptionText = !fits
    ? (onlyDeclines
        ? 'The only verified change is to say no to this request. Nothing you could move or shrink on your own makes it fit.'
        : emptyRepairMessage('infeasible'))
    : '';

  // ---- reply -----------------------------------------------------------
  const requestDate = days[proposal.targetDay]?.date ?? '';
  let replyKind;
  if (fits) replyKind = 'yes';
  else if (option && option.needsApproval) replyKind = 'approval';
  else if (option && option.movesRequestToDay !== null) replyKind = 'conditional-date';
  else if (option) replyKind = 'conditional';
  else replyKind = 'decline';
  if (smaller && smaller.active && fits) replyKind = 'smaller-yes';

  const signature = JSON.stringify([
    afterEval.verdict,
    afterEval.typical.feasible,
    afterEval.typical.lateMinutes,
    afterCost ? [afterCost.date, afterCost.shortfallHours, afterCost.marginHours] : null,
    option ? option.id : null,
    replyKind
  ]);

  const range = buildEstimateRange({
    tasks: derived.activeTasks,
    proposal,
    days,
    options: derived.options
  });

  return {
    kind,
    fits,
    tight,
    headline,
    detail,
    baselineBroken,
    beforeClause,
    afterClause,
    afterCost,
    option,
    alternative,
    noOptionText,
    onlyDeclines,
    replyKind,
    requestDate,
    signature,
    range,
    topRepair,
    selfServeRepair
  };
}

/**
 * Drafts the reply text from the analysis. `variant` only matters when nothing
 * fits ('decline' or 'flex'). Text is plain, and leaves sleep, stress and
 * unrelated deadlines out.
 */
export function buildReply({ analysis, proposal, days, variant = 'decline', smaller = null, includeWorkload = false }) {
  const title = proposal.title;
  const when = analysis.requestDate ? dayLabel(analysis.requestDate) : 'the deadline';
  const kind = analysis.replyKind;

  if (kind === 'approval') {
    const text = draftApprovalRequest(analysis.option.repair, days, { includeWorkload });
    return {
      kind,
      label: 'A request for someone to approve a change',
      text,
      note: `Your answer on ${title} stays on hold until they reply. Nothing has been added to your week.`
    };
  }

  if (kind === 'smaller-yes') {
    const scope = smaller?.scope?.trim() || 'a smaller version of it';
    return {
      kind,
      label: 'A smaller yes',
      text: `Hi,\n\nI can't take on all of ${title}, but I can do ${scope} by ${when}. Would that work?\n\nThanks for thinking of me.`,
      note: 'The engine checked this smaller version against your week.'
    };
  }

  if (kind === 'yes') {
    return {
      kind,
      label: 'A yes',
      text: `Hi,\n\nYes, I can take on ${title}. I'll have it done by ${when}.\n\nThanks for thinking of me.`,
      note: ''
    };
  }

  if (kind === 'conditional-date') {
    const newDate = days[analysis.option.movesRequestToDay]?.date;
    return {
      kind,
      label: 'A yes, on a later date',
      text: `Hi,\n\nI can't get ${title} done by ${when}, but I can have it to you by ${dayLabel(newDate)}. Would that work?\n\nThanks for thinking of me.`,
      note: 'The engine checked that later date against your week.'
    };
  }

  if (kind === 'conditional') {
    return {
      kind,
      label: 'A conditional yes',
      text: `Hi,\n\nYes, I can take on ${title} and have it done by ${when}. I need to rearrange a few other things on my side first, so I'll confirm once that's sorted.\n\nThanks for thinking of me.`,
      note: 'The change you would make is the option above. Apply it only if you want this one.'
    };
  }

  if (variant === 'flex') {
    return {
      kind: 'flex',
      label: 'A request for flexibility',
      text: `Hi,\n\nThanks for asking about ${title}. I'd like to help, but I can't commit to ${when} as things stand. If the deadline or the size of the job has some give, tell me what's flexible and I'll let you know what I can do.\n\nThanks.`,
      note: "This doesn't promise a date."
    };
  }
  return {
    kind: 'decline',
    label: 'A kind no',
    text: `Hi,\n\nThanks for thinking of me for ${title}. I can't take it on by ${when}, and I'd rather tell you now than say yes and let you down.\n\nThanks again for asking.`,
    note: ''
  };
}

/**
 * Describes what the engine counted for the days up to a given day index.
 * Reports only facts present in the loaded data; "missing" claims are limited
 * to things the app can evidence (no calendar imported, no work windows).
 */
export function describeBookedWeek({ state, derived, throughDayIndex, schedule }) {
  const days = state.days;
  const last = Math.min(days.length - 1, Math.max(0, throughDayIndex));
  const rows = [];
  for (let index = 0; index <= last; index++) {
    const day = days[index];
    const available = schedule?.byDay?.find(entry => entry.index === index)?.capacity ?? 0;
    rows.push({
      index,
      date: day.date,
      label: dayLabel(day.date),
      busy: (day.busyWindows ?? []).map(([start, end]) => ({ start, end })),
      work: (day.workWindows ?? []).map(([start, end]) => ({ start, end })),
      availableHours: available / 60
    });
  }
  const deadlines = derived.activeTasks
    .filter(task => task.targetDay <= last)
    .map(task => ({
      id: task.id,
      title: task.title,
      hours: task.likely,
      date: days[task.targetDay]?.date,
      isRequest: false
    }));
  const evidence = [];
  if (!state.calendarImportedAt) {
    evidence.push("No calendar has been imported, so the fixed blocks below are only ones that were typed in or came with the example week.");
  }
  const totalAvailable = rows.reduce((sum, row) => sum + row.availableHours, 0);
  if (totalAvailable === 0) {
    evidence.push('There are no free work hours before this deadline once busy blocks and protected sleep are removed.');
  }
  return { rows, deadlines, evidence, throughDayIndex: last };
}
