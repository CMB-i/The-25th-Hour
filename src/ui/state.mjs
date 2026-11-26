import { makeSlots, plannedSleepMinutes } from '../engine/capacity.mjs';
import { createProposal, defaultRange, evaluateCommitments } from '../engine/commitments.mjs';
import { demoData } from '../engine/demo-data.mjs';
import { deadlineCost, evaluate, weeklyComparison } from '../engine/evaluate.mjs';
import {
  buildEstimateProfiles,
  campusDate,
  getEstimateSuggestion,
  sevenDayReview,
  updateEstimateProfile
} from '../engine/feedback.mjs';
import { parseIcs, parsePastedTasks } from '../engine/importers.mjs';
import { applyRepair, findRepairs } from '../engine/repairs.mjs';
import { isHalfHour } from '../engine/scheduler.mjs';
import { LOADED_WEEKS, rebasePlan, rollingDays, weekView } from '../engine/weeks.mjs';
import { SCHEMA_VERSION, VALID_SCREENS, clearState, loadState, saveState } from './storage.mjs';

export const MAX_ICS_BYTES = 1_000_000;
export const WEEKDAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const DISPLAY_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const STATEFUL_ACTIONS = new Set([
  'NAVIGATE',
  'SET_WEEK',
  'LOAD_DEMO',
  'UPDATE_DEMO_RESEARCH',
  'ADD_PROPOSAL',
  'UPDATE_PROPOSAL',
  'SET_NAME',
  'LEAVE_DEMO',
  'ADD_BUSY_BLOCK',
  'REMOVE_BUSY_BLOCK',
  'DISCARD_PROPOSAL',
  'ACCEPT_PROPOSAL',
  'SELECT_REPAIR',
  'SET_DRAFT_WORKLOAD',
  'SET_APPROVAL_STATUS',
  'APPLY_REPAIR',
  'UNDO_LAST_REPAIR',
  'SAVE_SETTINGS',
  'IMPORT_PASTED_TASKS',
  'IMPORT_ICS',
  'RECORD_FEEDBACK',
  'RECORD_TASK_FEEDBACK',
  'RECORD_SLEEP_REPORT',
  'SKIP_SLEEP_PROMPT',
  'APPLY_ESTIMATE_SUGGESTION'
]);

const VERDICT_NAMES = {
  feasible: 'fits',
  'at-risk': 'tight',
  infeasible: "doesn't fit"
};

/**
 * Builds the default five-week rolling state (demo Scenario A/B or empty workspace).
 */
export function makeInitialState({ fixed = false, demo = true, nowIso } = {}) {
  const sample = demoData(fixed);
  const anchor = demo
    ? sample.days[0].date
    : (campusDate(nowIso ?? new Date().toISOString()) ?? sample.days[0].date);
  // A personal week starts with no work availability: the demo fixture is never presented as the student's own.
  const weeklyWorkWindows = demo
    ? [[], ...sample.days.map(day => day.workWindows), []]
    : [[], [], [], [], [], [], []];
  const days = rollingDays(anchor, weeklyWorkWindows);
  return {
    schemaVersion: SCHEMA_VERSION,
    screen: 'week',
    setupComplete: false,
    demo,
    fixed,
    includeResearch: true,
    researchHours: 5,
    weekIndex: 0,
    days,
    tasks: demo ? sample.tasks.map(task => ({ ...task })) : [],
    sleep: { ...sample.sleep },
    settings: { anchor, weeklyWorkWindows },
    proposals: [],
    selectedRepairId: null,
    pendingApprovals: [],
    appliedChanges: [],
    feedback: { tasks: [], sleepReports: [] },
    estimateProfiles: [],
    calendarImportedAt: null,
    tasksImportedAt: null,
    lastEditedAt: null,
    unresolvedConflict: false,
    draftIncludeWorkload: false,
    displayName: '',
    personalBackup: null,
    skippedSleepPromptDate: null,
    lastImportReport: null,
    notice: ''
  };
}

/**
 * True when the student has put their own week into the app (not a blank start, not example data).
 */
export function isSetUp(state) {
  if (state.demo) return false;
  const hasWork = (state.settings?.weeklyWorkWindows ?? []).some(day => (day ?? []).length > 0);
  return Boolean(state.setupComplete || state.tasks.length || state.calendarImportedAt || hasWork);
}

function personalSnapshot(state) {
  const { personalBackup, notice, ...rest } = state;
  return rest;
}

/**
 * Formats a 7-day weeklyWorkWindows array (0=Sun..6=Sat) into human-editable lines (Mon..Sun).
 */
export function formatWeeklyWindowsText(weeklyWorkWindows = []) {
  const lines = [];
  for (const dayIndex of DISPLAY_WEEKDAY_ORDER) {
    const windows = weeklyWorkWindows[dayIndex] ?? [];
    for (const pair of windows) {
      if (Array.isArray(pair) && pair.length === 2) {
        lines.push(`${WEEKDAY_LABELS[dayIndex]} ${pair[0]}-${pair[1]}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Parses lines like "Mon 16:00-20:00" (or comma-separated windows on a weekday line)
 * into a 7-element weeklyWorkWindows array indexed 0=Sun..6=Sat.
 */
export function parseWeeklyWindowsText(text) {
  if (typeof text !== 'string') {
    throw Error('Weekly work windows must be text lines such as Mon 16:00-20:00.');
  }
  const weeklyWorkWindows = WEEKDAY_LABELS.map(() => []);
  const dayLookup = new Map([
    ['sun', 0], ['sunday', 0],
    ['mon', 1], ['monday', 1],
    ['tue', 2], ['tues', 2], ['tuesday', 2],
    ['wed', 3], ['wednesday', 3],
    ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4],
    ['fri', 5], ['friday', 5],
    ['sat', 6], ['saturday', 6]
  ]);

  const lines = text.split(/\r\n|\n|\r/);
  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const headMatch = /^([A-Za-z]+)\s*:?\s*(.+)$/.exec(trimmed);
    if (!headMatch) {
      throw Error(`Work windows line ${index + 1}: use Mon 16:00-20:00.`);
    }
    const dayKey = headMatch[1].toLowerCase();
    const weekdayIndex = dayLookup.get(dayKey);
    if (weekdayIndex === undefined) {
      throw Error(`Work windows line ${index + 1}: unknown weekday "${headMatch[1]}". Use Mon, Tue, Wed, Thu, Fri, Sat, or Sun.`);
    }
    const rest = headMatch[2].trim();
    if (/^(none|off|free|-)$/i.test(rest)) continue;
    const segments = rest.split(',').map(part => part.trim()).filter(Boolean);
    if (!segments.length) {
      throw Error(`Work windows line ${index + 1}: use Mon 16:00-20:00.`);
    }
    for (const seg of segments) {
      const rangeMatch = /^(\d\d:\d\d)\s*[-–]\s*(\d\d:\d\d)$/.exec(seg);
      if (!rangeMatch) {
        throw Error(`Work windows line ${index + 1}: use Mon 16:00-20:00.`);
      }
      weeklyWorkWindows[weekdayIndex].push([rangeMatch[1], rangeMatch[2]]);
    }
  }
  return weeklyWorkWindows;
}

/**
 * Returns tasks not yet marked completed in Reality Feedback.
 */
export function getActiveTasks(state) {
  const completedIds = new Set(state.feedback.tasks.map(entry => entry.taskId));
  return state.tasks.filter(task => !completedIds.has(task.id));
}

/**
 * Deterministic plan fingerprint used to bind approval decisions to the exact verified plan.
 */
export function computePlanFingerprint(state) {
  return JSON.stringify([getActiveTasks(state), state.days, state.sleep]);
}

/**
 * Returns all task-like IDs across active tasks, pending proposals, and completed feedback
 * so new proposals never collide with any existing ID.
 */
export function getAllKnownTasks(state) {
  return [
    ...state.tasks,
    ...state.proposals,
    ...state.feedback.tasks.map(entry => ({ id: entry.taskId }))
  ];
}

/**
 * Finds the top self-serve repair for accepting draft proposals without dropping the drafts themselves.
 */
export function findSelfServeAcceptRepair(repairs, draftIds) {
  const draftSet = new Set(draftIds);
  return repairs.find(
    repair => !repair.needsApproval &&
      !repair.actions.some(action => action.type === 'drop' && draftSet.has(action.taskId))
  ) ?? null;
}

/**
 * Computes all engine-derived schedule, verdict, margin, repair, and commitment check data.
 */
export function deriveView(state) {
  const activeTasks = getActiveTasks(state);
  const options = { sleep: state.sleep };
  const evaluation = evaluate(activeTasks, state.days, options);
  const repairs = findRepairs(activeTasks, state.days, options);
  const maxWeekIndex = Math.max(0, Math.ceil(state.days.length / 7) - 1);
  const safeWeekIndex = Math.min(Math.max(0, state.weekIndex), maxWeekIndex);
  const week = weekView(state.days, safeWeekIndex);
  const weekly = weeklyComparison(evaluation.typical, week.dayIndices);
  const bindingCost = deadlineCost(evaluation.typical, state.days);
  const conservativeCost = deadlineCost(evaluation.conservative, state.days);
  const fingerprint = computePlanFingerprint(state);
  const estimateProfiles = buildEstimateProfiles(state.feedback.tasks);
  const commitmentCheck = state.proposals.length > 0
    ? evaluateCommitments(activeTasks, state.proposals, state.days, options)
    : null;
  const feedbackDates = [
    ...state.feedback.tasks.map(entry => campusDate(entry.recordedAt)).filter(Boolean),
    ...state.feedback.sleepReports.map(entry => campusDate(entry.date)).filter(Boolean)
  ].sort();
  const defaultThroughDate = state.demo
    ? (feedbackDates[feedbackDates.length - 1] && feedbackDates[feedbackDates.length - 1] > '2026-11-20'
        ? feedbackDates[feedbackDates.length - 1]
        : (state.days[4]?.date ?? state.days[0]?.date ?? '2026-11-20'))
    : (feedbackDates[feedbackDates.length - 1]
        ?? campusDate(new Date().toISOString())
        ?? state.days[Math.min(4, state.days.length - 1)]?.date
        ?? '2026-11-20');
  const review = sevenDayReview({
    feedback: state.feedback.tasks,
    sleepReports: state.feedback.sleepReports,
    appliedChanges: state.appliedChanges,
    tasks: state.tasks,
    days: state.days,
    throughDate: defaultThroughDate
  });
  return {
    activeTasks,
    options,
    evaluation,
    repairs,
    weekIndex: safeWeekIndex,
    maxWeekIndex,
    week,
    weekly,
    bindingCost,
    conservativeCost,
    fingerprint,
    estimateProfiles,
    commitmentCheck,
    reviewThroughDate: defaultThroughDate,
    review
  };
}

/**
 * Finds the persisted approval decision matching a repair and current plan fingerprint.
 */
export function getApprovalRecord(state, repairId, fingerprint = computePlanFingerprint(state)) {
  return state.pendingApprovals.find(
    record => record.repairId === repairId && record.fingerprint === fingerprint
  ) ?? null;
}

function mergeUpdatedTasks(allTasks, updatedActive) {
  const byId = new Map(updatedActive.map(task => [task.id, task]));
  return allTasks.map(task => byId.get(task.id) ?? { ...task });
}

function restorePreviousTasks(currentTasks, change) {
  if (Array.isArray(change.previousTasks)) {
    return change.previousTasks.map(task => ({ ...task }));
  }
  const previousMap = new Map((change.previous ?? []).map(task => [task.id, task]));
  return currentTasks.map(task => previousMap.get(task.id) ?? { ...task });
}

/**
 * Pure state reducer driving every user and system transition from a single state object.
 */
export function reduceState(state, action, nowFn = () => new Date().toISOString()) {
  if (!action || typeof action.type !== 'string') {
    throw Error('Invalid state action.');
  }

  switch (action.type) {
    case 'NAVIGATE': {
      if (!VALID_SCREENS.includes(action.screen)) {
        throw Error(`Unknown screen: ${action.screen}`);
      }
      return { ...state, screen: action.screen, notice: '' };
    }

    case 'OPEN_SCREEN': {
      // Used once at startup. Not persisted, so opening the app never rewrites saved data.
      if (!VALID_SCREENS.includes(action.screen)) {
        throw Error(`Unknown screen: ${action.screen}`);
      }
      return { ...state, screen: action.screen };
    }

    case 'SET_NAME':
      return { ...state, displayName: String(action.name ?? '').trim().slice(0, 40), notice: '' };

    case 'SET_WEEK': {
      const maxWeek = Math.max(0, Math.min(LOADED_WEEKS - 1, Math.ceil(state.days.length / 7) - 1));
      const requested = Number.isInteger(action.weekIndex) ? action.weekIndex : state.weekIndex;
      const weekIndex = Math.max(0, Math.min(maxWeek, requested));
      return { ...state, weekIndex };
    }

    case 'LOAD_DEMO': {
      const fixed = Boolean(action.fixed);
      const fresh = makeInitialState({ fixed, demo: true, nowIso: nowFn() });
      // Entering an example never overwrites the student's own week: it is stashed and restored on leave.
      const personalBackup = state.demo
        ? (state.personalBackup ?? null)
        : (isSetUp(state) ? personalSnapshot(state) : null);
      return {
        ...fresh,
        screen: state.screen,
        setupComplete: state.setupComplete,
        displayName: state.displayName ?? '',
        personalBackup,
        lastEditedAt: nowFn(),
        notice: fixed
          ? 'Showing example week B (all deadlines fixed).'
          : 'Showing example week A (some deadlines can slide).'
      };
    }

    case 'LEAVE_DEMO': {
      if (!state.demo) return state;
      if (state.personalBackup) {
        return {
          ...state.personalBackup,
          screen: state.screen,
          personalBackup: null,
          notice: 'Back to your own week.'
        };
      }
      const blank = makeInitialState({ demo: false, nowIso: nowFn() });
      return {
        ...blank,
        screen: state.screen,
        displayName: state.displayName ?? '',
        notice: 'Example closed. Your own week is empty so far.'
      };
    }

    case 'UPDATE_DEMO_RESEARCH': {
      const includeResearch = action.includeResearch !== undefined
        ? Boolean(action.includeResearch)
        : state.includeResearch;
      const hours = action.researchHours !== undefined
        ? Number(action.researchHours)
        : state.researchHours;
      if (!isHalfHour(hours) || hours < 4 || hours > 6) {
        throw Error('Demo research must be 4–6h in half-hour increments.');
      }
      const demo = demoData(state.fixed);
      const research = demo.tasks.find(task => task.id === 'research');
      const [rebased] = rebasePlan(demo.days, [research], state.days).tasks;
      const updatedResearch = { ...rebased, min: hours - 1, likely: hours, max: hours + 1 };
      const baseTasks = state.tasks.filter(task => task.id !== rebased.id);
      const tasks = includeResearch ? [...baseTasks, updatedResearch] : baseTasks;
      const appliedChanges = state.appliedChanges
        .filter(change => !(change.previous ?? []).some(item => item.id === rebased.id))
        .map(change => {
          if (!Array.isArray(change.previousTasks)) return change;
          const withoutResearch = change.previousTasks.filter(item => item.id !== rebased.id);
          return {
            ...change,
            previousTasks: includeResearch ? [...withoutResearch, updatedResearch] : withoutResearch
          };
        });
      return {
        ...state,
        tasks,
        includeResearch,
        researchHours: hours,
        appliedChanges,
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: nowFn(),
        notice: includeResearch
          ? `Demo research estimate updated to ${hours}h (${hours - 1}–${hours + 1}h range).`
          : 'Demo research proposal toggled off.'
      };
    }

    case 'SELECT_REPAIR':
      return { ...state, selectedRepairId: action.repairId ?? null };

    case 'ADD_PROPOSAL': {
      const raw = action.fields ?? {};
      const parseOptionalHour = value =>
        value === '' || value === null || value === undefined ? '' : Number(value);
      const fields = {
        title: raw.title,
        likely: parseOptionalHour(raw.likely),
        min: parseOptionalHour(raw.min),
        max: parseOptionalHour(raw.max),
        deadline: raw.deadline ?? '',
        tag: raw.tag !== undefined && raw.tag !== '' ? raw.tag : 'must-keep',
        latestDate: raw.latestDate ?? '',
        earliestDate: raw.earliestDate ?? '',
        type: raw.type !== undefined && raw.type !== '' ? raw.type : 'other'
      };
      const notBeforeDate = action.notBeforeDate !== undefined
        ? action.notBeforeDate
        : (state.demo ? state.days[0].date : campusDate(nowFn()));
      const proposal = createProposal(fields, state.days, {
        existingTasks: getAllKnownTasks(state),
        notBeforeDate
      });
      return {
        ...state,
        proposals: [...state.proposals, proposal],
        estimateProfiles: buildEstimateProfiles(state.feedback.tasks),
        lastEditedAt: nowFn(),
        notice: ''
      };
    }

    case 'UPDATE_PROPOSAL': {
      const target = state.proposals.find(item => item.id === action.proposalId);
      if (!target) {
        throw Error('That request is no longer pending.');
      }
      const raw = action.fields ?? {};
      const parseOptionalHour = value =>
        value === '' || value === null || value === undefined ? '' : Number(value);
      const fields = {
        title: raw.title,
        likely: parseOptionalHour(raw.likely),
        min: parseOptionalHour(raw.min),
        max: parseOptionalHour(raw.max),
        deadline: raw.deadline ?? '',
        tag: raw.tag !== undefined && raw.tag !== '' ? raw.tag : 'must-keep',
        latestDate: raw.latestDate ?? '',
        earliestDate: raw.earliestDate ?? '',
        type: raw.type !== undefined && raw.type !== '' ? raw.type : 'other'
      };
      const notBeforeDate = action.notBeforeDate !== undefined
        ? action.notBeforeDate
        : (state.demo ? state.days[0].date : campusDate(nowFn()));
      const others = getAllKnownTasks(state).filter(item => item.id !== target.id);
      const created = createProposal(fields, state.days, { existingTasks: others, notBeforeDate });
      const updated = { ...created, id: target.id };
      return {
        ...state,
        proposals: state.proposals.map(item => item.id === target.id ? updated : item),
        lastEditedAt: nowFn(),
        notice: ''
      };
    }

    case 'ADD_BUSY_BLOCK':
    case 'REMOVE_BUSY_BLOCK': {
      const dayIndex = action.dayIndex;
      const day = state.days[dayIndex];
      if (!Number.isInteger(dayIndex) || !day) {
        throw Error('Pick a day from the loaded weeks.');
      }
      const start = String(action.start ?? '');
      const end = String(action.end ?? '');
      let busyWindows;
      if (action.type === 'ADD_BUSY_BLOCK') {
        if (!start || !end) throw Error('Enter a start and end time for the busy block.');
        if (start >= end) throw Error('A busy block must end after it starts.');
        busyWindows = day.busyWindows.some(([from, to]) => from === start && to === end)
          ? day.busyWindows.map(window => [...window])
          : [...day.busyWindows.map(window => [...window]), [start, end]]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      } else {
        busyWindows = day.busyWindows
          .filter(([from, to]) => !(from === start && to === end))
          .map(window => [...window]);
      }
      const days = state.days.map((item, index) => index === dayIndex ? { ...item, busyWindows } : item);
      // Validates the new window against the engine's own rules (HH:MM, same day).
      makeSlots(days, state.sleep);
      return {
        ...state,
        days,
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: nowFn(),
        notice: ''
      };
    }

    case 'DISCARD_PROPOSAL': {
      const ids = Array.isArray(action.proposalIds)
        ? action.proposalIds
        : action.proposalId
          ? [action.proposalId]
          : [];
      const targetSet = new Set(ids);
      const discarded = state.proposals.filter(item => targetSet.has(item.id));
      if (!discarded.length) {
        throw Error('Select a pending commitment proposal to discard.');
      }
      const proposals = state.proposals.filter(item => !targetSet.has(item.id));
      return {
        ...state,
        proposals,
        lastEditedAt: nowFn(),
        notice: `Discarded ${discarded.map(item => `"${item.title}"`).join(', ')}. Your schedule was not changed.`
      };
    }

    case 'ACCEPT_PROPOSAL': {
      const ids = Array.isArray(action.proposalIds)
        ? action.proposalIds
        : action.proposalId
          ? [action.proposalId]
          : [];
      const targetSet = new Set(ids);
      const drafts = state.proposals.filter(item => targetSet.has(item.id));
      if (!drafts.length) {
        throw Error('Select a pending commitment proposal to accept.');
      }
      const mode = action.mode || 'accept';
      if (!['accept', 'accept-repair', 'override'].includes(mode)) {
        throw Error(`Invalid proposal acceptance mode: ${mode}`);
      }

      const activeTasks = getActiveTasks(state);
      const options = { sleep: state.sleep };
      const combined = [...activeTasks, ...drafts];
      const combinedEval = evaluate(combined, state.days, options);
      const committedDrafts = drafts.map(task => ({ ...task, isProposal: false }));
      const remainingProposals = state.proposals.filter(item => !targetSet.has(item.id));
      const timestamp = nowFn();
      const names = committedDrafts.map(item => `"${item.title}"`).join(', ');

      if (mode === 'accept') {
        if (!combinedEval.typical.feasible) {
          throw Error('This commitment makes the plan infeasible. Choose "Accept with suggested change" or "Accept anyway".');
        }
        const tasks = [...state.tasks.map(task => ({ ...task })), ...committedDrafts];
        const nextState = {
          ...state,
          tasks,
          proposals: remainingProposals,
          pendingApprovals: [],
          selectedRepairId: null,
          lastEditedAt: timestamp
        };
        const nextEval = evaluate(getActiveTasks(nextState), nextState.days, options);
        const label = VERDICT_NAMES[nextEval.verdict] ?? nextEval.verdict;
        return {
          ...nextState,
          unresolvedConflict: nextEval.typical.feasible ? false : state.unresolvedConflict,
          notice: `Accepted ${names}. Plan verdict is ${label}.`
        };
      }

      if (mode === 'accept-repair') {
        const repairs = findRepairs(combined, state.days, options);
        const chosen = action.repairId
          ? repairs.find(candidate => candidate.id === action.repairId)
          : findSelfServeAcceptRepair(repairs, [...targetSet]);
        if (!chosen) {
          throw Error('No self-serve verified change is available to make this commitment fit.');
        }
        if (chosen.needsApproval) {
          throw Error('Approval-required changes cannot be auto-applied when accepting a commitment.');
        }
        if (chosen.actions.some(item => item.type === 'drop' && targetSet.has(item.taskId))) {
          throw Error('Cannot accept a commitment using a repair that drops the commitment itself.');
        }

        const preRepairAllTasks = [...state.tasks.map(task => ({ ...task })), ...committedDrafts];
        const preRepairActive = [...activeTasks.map(task => ({ ...task })), ...committedDrafts];
        const repairedActive = applyRepair(preRepairActive, state.days, chosen.id, options);
        const tasks = mergeUpdatedTasks(preRepairAllTasks, repairedActive);
        const change = {
          id: `change-${state.appliedChanges.length + 1}-${timestamp}`,
          repairId: chosen.id,
          labels: chosen.actions.map(item => item.label),
          approved: false,
          recordedAt: timestamp,
          previousUnresolvedConflict: state.unresolvedConflict,
          previousTasks: preRepairAllTasks,
          previous: preRepairAllTasks
            .filter(task => chosen.actions.some(item => item.taskId === task.id))
            .map(task => ({ ...task }))
        };
        const nextState = {
          ...state,
          tasks,
          proposals: remainingProposals,
          appliedChanges: [...state.appliedChanges, change],
          pendingApprovals: [],
          selectedRepairId: null,
          lastEditedAt: timestamp
        };
        const nextEval = evaluate(getActiveTasks(nextState), nextState.days, options);
        const label = VERDICT_NAMES[nextEval.verdict] ?? nextEval.verdict;
        return {
          ...nextState,
          unresolvedConflict: nextEval.typical.feasible ? false : state.unresolvedConflict,
          notice: `Accepted ${names} with self-serve repair (${chosen.actions.map(item => item.label).join(' + ')}). Plan verdict is ${label}.`
        };
      }

      // mode === 'override' ("Accept anyway")
      const tasks = [...state.tasks.map(task => ({ ...task })), ...committedDrafts];
      const nextState = {
        ...state,
        tasks,
        proposals: remainingProposals,
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: timestamp
      };
      const nextEval = evaluate(getActiveTasks(nextState), nextState.days, options);
      const hasConflict = !nextEval.typical.feasible;
      return {
        ...nextState,
        unresolvedConflict: hasConflict || state.unresolvedConflict,
        notice: hasConflict
          ? `Accepted ${names} by override. The unresolved deadline conflict stays visible on your plan until resolved.`
          : `Accepted ${names} into your plan.`
      };
    }

    case 'SET_DRAFT_WORKLOAD':
      return { ...state, draftIncludeWorkload: Boolean(action.include) };

    case 'SET_APPROVAL_STATUS': {
      const { repairId, status } = action;
      if (!['pending', 'approved', 'declined'].includes(status)) {
        throw Error('Invalid approval status.');
      }
      const activeTasks = getActiveTasks(state);
      const repair = findRepairs(activeTasks, state.days, { sleep: state.sleep })
        .find(candidate => candidate.id === repairId);
      if (!repair || !repair.needsApproval) {
        throw Error('Approval status applies only to repairs that require approval.');
      }
      const fingerprint = computePlanFingerprint(state);
      const actionIds = repair.actions.filter(item => item.needsApproval).map(item => item.id);
      const entry = { repairId: repair.id, actionIds, fingerprint, status, updatedAt: nowFn() };
      const pendingApprovals = [
        ...state.pendingApprovals.filter(item => item.repairId !== repair.id),
        entry
      ];
      const notice = status === 'approved'
        ? 'Approval recorded. Click "Apply approved change" to update your real plan.'
        : status === 'declined'
          ? 'Request marked declined. Your real plan stays unchanged.'
          : 'Approval decision reset to pending.';
      return {
        ...state,
        pendingApprovals,
        lastEditedAt: nowFn(),
        notice
      };
    }

    case 'APPLY_REPAIR': {
      const activeTasks = getActiveTasks(state);
      const options = { sleep: state.sleep };
      const repair = findRepairs(activeTasks, state.days, options)
        .find(candidate => candidate.id === action.repairId);
      if (!repair) {
        throw Error('This repair is no longer available. Preview the current plan again.');
      }
      const fingerprint = computePlanFingerprint(state);
      let approvedActionIds = [];
      if (repair.needsApproval) {
        const record = getApprovalRecord(state, repair.id, fingerprint);
        if (!record || record.status !== 'approved') {
          throw Error('Record explicit approval before applying this action.');
        }
        approvedActionIds = repair.actions.filter(item => item.needsApproval).map(item => item.id);
      }
      const updatedActive = applyRepair(activeTasks, state.days, repair.id, {
        ...options,
        approvedActionIds
      });
      const tasks = mergeUpdatedTasks(state.tasks, updatedActive);
      const timestamp = nowFn();
      const change = {
        id: `change-${state.appliedChanges.length + 1}-${timestamp}`,
        repairId: repair.id,
        labels: repair.actions.map(item => item.label),
        approved: repair.needsApproval,
        recordedAt: timestamp,
        previousUnresolvedConflict: state.unresolvedConflict,
        previousTasks: state.tasks.map(task => ({ ...task })),
        previous: state.tasks
          .filter(task => repair.actions.some(item => item.taskId === task.id))
          .map(task => ({ ...task }))
      };
      const nextState = {
        ...state,
        tasks,
        appliedChanges: [...state.appliedChanges, change],
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: timestamp
      };
      const nextEval = evaluate(getActiveTasks(nextState), nextState.days, options);
      const unresolvedConflict = nextEval.typical.feasible ? false : state.unresolvedConflict;
      const label = VERDICT_NAMES[nextEval.verdict] ?? nextEval.verdict;
      return {
        ...nextState,
        unresolvedConflict,
        notice: `${repair.needsApproval ? 'Approved' : 'Verified'} change applied. Plan verdict is now ${label}.`
      };
    }

    case 'UNDO_LAST_REPAIR': {
      if (!state.appliedChanges.length) {
        throw Error('No applied changes to undo.');
      }
      const change = state.appliedChanges[state.appliedChanges.length - 1];
      const tasks = restorePreviousTasks(state.tasks, change);
      const nextState = {
        ...state,
        tasks,
        appliedChanges: state.appliedChanges.slice(0, -1),
        pendingApprovals: [],
        selectedRepairId: null,
        unresolvedConflict: change.previousUnresolvedConflict ?? state.unresolvedConflict,
        lastEditedAt: nowFn()
      };
      const nextEval = evaluate(getActiveTasks(nextState), nextState.days, { sleep: nextState.sleep });
      const label = VERDICT_NAMES[nextEval.verdict] ?? nextEval.verdict;
      return {
        ...nextState,
        notice: `Last applied repair undone. Plan verdict is ${label}.`
      };
    }

    case 'SET_NOTICE':
      return { ...state, notice: String(action.notice ?? '') };

    case 'SAVE_SETTINGS': {
      const sleep = action.sleep
        ? { start: String(action.sleep.start ?? ''), end: String(action.sleep.end ?? '') }
        : {
            start: String(action.sleepStart ?? state.sleep.start),
            end: String(action.sleepEnd ?? state.sleep.end)
          };
      const anchor = String(action.anchor ?? state.settings?.anchor ?? state.days[0]?.date ?? '').trim();
      const weeklyWorkWindows = Array.isArray(action.weeklyWorkWindows)
        ? action.weeklyWorkWindows.map(day => (day ?? []).map(window => [...window]))
        : typeof action.windowsText === 'string'
          ? parseWeeklyWindowsText(action.windowsText)
          : state.settings.weeklyWorkWindows;

      const newDays = rollingDays(anchor, weeklyWorkWindows);
      const activeNonRemoved = getActiveTasks(state).filter(task => !task.removed);
      const rebased = rebasePlan(state.days, activeNonRemoved, newDays);
      const rebasedProposals = rebasePlan(state.days, state.proposals, newDays);
      const datesChanged = newDays[0]?.date !== state.days[0]?.date;
      const tasks = datesChanged ? rebased.tasks : state.tasks.map(task => ({ ...task }));

      // Validates sleep window times and half-hour alignment while confirming sleep exclusion.
      makeSlots(rebased.days, sleep);

      const retainedIds = new Set(tasks.map(task => task.id));
      const appliedChanges = state.appliedChanges.map(change => {
        const filteredPrev = (change.previous ?? []).filter(task => retainedIds.has(task.id));
        const rebasedPrev = filteredPrev.length
          ? rebasePlan(state.days, filteredPrev, newDays).tasks
          : [];
        const filteredPrevTasks = Array.isArray(change.previousTasks)
          ? change.previousTasks.filter(task => retainedIds.has(task.id))
          : null;
        const rebasedPrevTasks = filteredPrevTasks
          ? rebasePlan(state.days, filteredPrevTasks, newDays).tasks
          : undefined;
        return {
          ...change,
          previous: rebasedPrev,
          ...(rebasedPrevTasks ? { previousTasks: rebasedPrevTasks } : {})
        };
      });

      const nextState = {
        ...state,
        days: rebased.days,
        tasks,
        proposals: rebasedProposals.tasks,
        sleep,
        settings: { anchor, weeklyWorkWindows },
        appliedChanges,
        setupComplete: action.setupComplete !== undefined ? Boolean(action.setupComplete) : true,
        demo: state.demo,
        weekIndex: datesChanged ? 0 : state.weekIndex,
        pendingApprovals: [],
        selectedRepairId: null,
        calendarImportedAt: datesChanged ? null : state.calendarImportedAt,
        lastEditedAt: nowFn()
      };
      const nextEval = evaluate(getActiveTasks(nextState), nextState.days, { sleep });
      return {
        ...nextState,
        unresolvedConflict: nextEval.typical.feasible ? false : state.unresolvedConflict,
        notice: 'Settings saved. Protected sleep window and weekly work hours updated.'
      };
    }

    case 'IMPORT_PASTED_TASKS': {
      const existingIds = getAllKnownTasks(state).map(task => task.id);
      const imported = parsePastedTasks(String(action.text ?? ''), state.days, { existingIds });
      const addedCount = imported.data.length;
      const skippedCount = imported.warnings.length;
      const timestamp = nowFn();
      const tasks = addedCount ? [...state.tasks, ...imported.data] : state.tasks;
      const summary = `Added ${addedCount}, skipped ${skippedCount}.${
        skippedCount ? ` ${imported.warnings.join(' ')}` : ''
      }`;
      const nextState = {
        ...state,
        tasks,
        tasksImportedAt: addedCount ? timestamp : state.tasksImportedAt,
        lastEditedAt: addedCount ? timestamp : state.lastEditedAt,
        pendingApprovals: addedCount ? [] : state.pendingApprovals,
        selectedRepairId: addedCount ? null : state.selectedRepairId,
        lastImportReport: {
          kind: 'paste',
          added: addedCount,
          skipped: skippedCount,
          warnings: imported.warnings,
          summary,
          recordedAt: timestamp
        },
        notice: summary
      };
      return nextState;
    }

    case 'IMPORT_ICS': {
      const text = String(action.text ?? '');
      const byteLength = Number.isFinite(action.fileSize)
        ? action.fileSize
        : new TextEncoder().encode(text).length;
      if (byteLength > MAX_ICS_BYTES) {
        throw Error('Calendar file exceeds the 1 MB size limit.');
      }
      const imported = parseIcs(text, state.days);
      const addedCount = imported.data.length;
      const skippedCount = imported.warnings.length;
      const timestamp = nowFn();
      const replaceExisting = action.replaceExisting !== false;

      let days = state.days;
      if (addedCount > 0) {
        days = state.days.map(day => ({
          ...day,
          busyWindows: replaceExisting ? [] : day.busyWindows.map(window => [...window])
        }));
        for (const entry of imported.data) {
          const bucket = days[entry.index]?.busyWindows;
          if (!bucket) continue;
          if (!bucket.some(([start, end]) => start === entry.start && end === entry.end)) {
            bucket.push([entry.start, entry.end]);
          }
        }
      }

      const fatalLimit = imported.warnings.some(msg => /2,000 event limit|Provide calendar text/i.test(msg));
      const calendarImportedAt = !fatalLimit && (addedCount > 0 || text.includes('BEGIN:VCALENDAR') || text.includes('BEGIN:VEVENT'))
        ? timestamp
        : state.calendarImportedAt;
      const summary = `Imported ${addedCount} busy window(s).${
        skippedCount ? ` ${imported.warnings.join(' ')}` : ''
      }`;

      return {
        ...state,
        days,
        calendarImportedAt,
        lastEditedAt: timestamp,
        pendingApprovals: [],
        selectedRepairId: null,
        lastImportReport: {
          kind: 'ics',
          added: addedCount,
          skipped: skippedCount,
          warnings: imported.warnings,
          summary,
          recordedAt: timestamp
        },
        notice: summary
      };
    }

    case 'RECORD_FEEDBACK':
    case 'RECORD_TASK_FEEDBACK':
    case 'RECORD_SLEEP_REPORT': {
      const isSleep = action.type === 'RECORD_SLEEP_REPORT' ||
        action.kind === 'sleep' ||
        (action.taskId === undefined && (action.hoursSlept !== undefined || action.hours !== undefined));

      if (isSleep) {
        const date = String(action.date || (state.demo ? '2026-11-19' : (campusDate(nowFn()) ?? ''))).trim();
        const rawHours = action.hoursSlept !== undefined ? action.hoursSlept : action.hours;
        const hoursSlept = rawHours === '' || rawHours === null || rawHours === undefined ? NaN : Number(rawHours);
        if (!campusDate(date) || !isHalfHour(hoursSlept) || hoursSlept > 24) {
          throw Error('Enter a valid night and sleep duration (0 to 24h in 0.5h increments).');
        }
        const previous = state.feedback.sleepReports.find(report => report.date === date);
        const report = {
          date,
          hoursSlept,
          plannedSleepMinutes: previous?.plannedSleepMinutes ?? plannedSleepMinutes(state.sleep)
        };
        if (action.stress !== '' && action.stress !== null && action.stress !== undefined) {
          const stress = Number(action.stress);
          if (!Number.isInteger(stress) || stress < 1 || stress > 5) {
            throw Error('Stress rating must be an integer from 1 to 5, or left blank.');
          }
          report.stress = stress;
        }
        const sleepReports = [
          ...state.feedback.sleepReports.filter(item => item.date !== date),
          report
        ];
        return {
          ...state,
          feedback: { ...state.feedback, sleepReports },
          lastEditedAt: nowFn(),
          notice: `Sleep report saved for night ending ${date} (${hoursSlept}h logged).`
        };
      }

      const task = state.tasks.find(item => item.id === action.taskId);
      if (!task) {
        throw Error('Choose a task to record completion feedback.');
      }
      const previous = state.feedback.tasks.find(item => item.taskId === task.id);
      const estimatedLikely = previous?.estimatedLikely ?? task.likely;
      const rawActual = action.asPlanned ? estimatedLikely : action.actualHours;
      const actualHours = rawActual === '' || rawActual === null || rawActual === undefined ? NaN : Number(rawActual);
      const taskType = action.taskType ?? task.type ?? previous?.type ?? 'other';
      const defaultRecordedAt = state.demo
        ? `${state.days[task.targetDay]?.date ?? '2026-11-19'}T18:00`
        : nowFn().slice(0, 16);
      const recordedAt = String(action.recordedAt || defaultRecordedAt).trim();
      if (!campusDate(recordedAt)) {
        throw Error('Enter a valid completion time.');
      }
      const entry = {
        ...previous,
        taskId: task.id,
        title: task.title,
        type: taskType,
        estimatedLikely,
        actualHours,
        recordedAt,
        targetDate: previous?.targetDate ?? state.days[task.targetDay]?.date ?? null,
        hardDate: previous?.hardDate ?? state.days[task.hardDay]?.date ?? null
      };
      // Validates taskType, positive half-hour estimatedLikely, and non-negative half-hour actualHours.
      updateEstimateProfile(null, entry);

      const feedbackTasks = previous
        ? state.feedback.tasks.map(item => item.taskId === task.id ? entry : item)
        : [...state.feedback.tasks, entry];
      const estimateProfiles = buildEstimateProfiles(feedbackTasks);
      const updatedProfile = estimateProfiles.find(profile => profile.type === taskType);
      const tasks = state.tasks.map(item => item.id === task.id ? { ...item, type: taskType } : item);

      const nextState = {
        ...state,
        tasks,
        feedback: { ...state.feedback, tasks: feedbackTasks },
        estimateProfiles,
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: nowFn()
      };
      const nextEval = evaluate(getActiveTasks(nextState), nextState.days, { sleep: nextState.sleep });
      const sampleText = updatedProfile
        ? updatedProfile.samples < 3
          ? `Estimate learning (${taskType}): ${updatedProfile.samples} of 3 samples recorded.`
          : `Learned ${taskType} ratio is now ${Number(updatedProfile.ratio.toFixed(3))}× (${updatedProfile.samples} samples).`
        : '';

      return {
        ...nextState,
        unresolvedConflict: nextEval.typical.feasible ? false : state.unresolvedConflict,
        notice: `Task feedback saved for "${task.title}" (${actualHours}h actual vs ${estimatedLikely}h estimated). ${sampleText}`.trim()
      };
    }

    case 'SKIP_SLEEP_PROMPT': {
      const skippedDate = action.date || (state.demo ? '2026-11-19' : campusDate(nowFn()));
      return {
        ...state,
        skippedSleepPromptDate: skippedDate,
        notice: 'Morning sleep check-in skipped for today.'
      };
    }

    case 'APPLY_ESTIMATE_SUGGESTION': {
      const profiles = buildEstimateProfiles(state.feedback.tasks);
      const inTasks = state.tasks.find(item => item.id === action.taskId);
      const inProposals = state.proposals.find(item => item.id === action.taskId);
      const target = inTasks ?? inProposals;
      if (!target) {
        throw Error('Task not found for estimate adjustment.');
      }
      const type = target.type ?? 'other';
      const profile = profiles.find(item => item.type === type);
      const suggested = getEstimateSuggestion(profile, target.likely);
      if (suggested === null) {
        throw Error('At least 3 completed samples of this task type are required before a learned suggestion is available.');
      }
      const range = defaultRange(suggested);
      const updatedTask = {
        ...target,
        type,
        likely: suggested,
        min: Math.min(target.min, range.min),
        max: Math.max(suggested, range.max)
      };
      const tasks = inTasks
        ? state.tasks.map(item => item.id === target.id ? updatedTask : item)
        : state.tasks;
      const proposals = inProposals
        ? state.proposals.map(item => item.id === target.id ? updatedTask : item)
        : state.proposals;
      return {
        ...state,
        tasks,
        proposals,
        pendingApprovals: [],
        selectedRepairId: null,
        lastEditedAt: nowFn(),
        notice: `Updated "${target.title}" typical estimate to ${suggested}h from learned ${type} profile.`
      };
    }

    case 'CLEAR_ALL': {
      const clean = makeInitialState({ fixed: false, demo: false, nowIso: nowFn() });
      return {
        ...clean,
        screen: state.screen,
        notice: 'Local data cleared.'
      };
    }

    default:
      throw Error(`Unsupported action: ${action.type}`);
  }
}

/**
 * Single-store container coordinating reducer transitions, engine validation,
 * persistence, and reactive rendering subscriptions.
 */
export function createStore({ storage = null, nowFn = () => new Date().toISOString() } = {}) {
  const loaded = loadState(storage);
  let state;
  if (loaded.state) {
    try {
      const derived = deriveView(loaded.state);
      state = { ...loaded.state, weekIndex: derived.weekIndex };
    } catch {
      state = {
        ...makeInitialState({ fixed: false, demo: false, nowIso: nowFn() }),
        notice: 'Saved data could not be read. A fresh plan is open.'
      };
    }
  } else {
    state = makeInitialState({ fixed: false, demo: false, nowIso: nowFn() });
    if (loaded.warning) state = { ...state, notice: loaded.warning };
  }

  const listeners = new Set();

  function dispatch(action) {
    const next = reduceState(state, action, nowFn);
    const derived = deriveView(next);
    state = next;
    let persistedNotice = state.notice;
    if (action.type === 'CLEAR_ALL') {
      try { clearState(storage); }
      catch { persistedNotice = 'Browser storage is unavailable. Data cleared for this session.'; }
    } else if (STATEFUL_ACTIONS.has(action.type)) {
      try { saveState(storage, state); }
      catch { persistedNotice = 'Browser storage is unavailable. Changes are open for this session.'; }
    }
    if (persistedNotice !== state.notice) {
      state = { ...state, notice: persistedNotice };
    }
    for (const listener of listeners) {
      listener(state, derived);
    }
    return { state, derived };
  }

  return {
    getState: () => state,
    derive: () => deriveView(state),
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
