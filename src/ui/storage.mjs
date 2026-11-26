export const STORAGE_KEY = 'the25thhour.v1';
export const SCHEMA_VERSION = 1;
export const VALID_SCREENS = Object.freeze(['home', 'week', 'check', 'rescue', 'feedback', 'settings']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates and normalizes persisted snapshots (including earlier placeholder
 * `the25thhour.v1` records) into the current frontend state shape.
 */
export function migrate(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw Error('Unrecognised saved data format.');
  }
  const requiredArrays = ['tasks', 'days', 'appliedChanges', 'proposals', 'pendingApprovals'];
  if (!requiredArrays.every(key => Array.isArray(value[key])) ||
      !value.days.length ||
      !isPlainObject(value.feedback) ||
      !Array.isArray(value.feedback.tasks) ||
      !Array.isArray(value.feedback.sleepReports) ||
      !isPlainObject(value.settings) ||
      !isPlainObject(value.sleep) ||
      typeof value.sleep.start !== 'string' ||
      typeof value.sleep.end !== 'string') {
    throw Error('Unrecognised saved data format.');
  }

  const weekIndex = Number.isInteger(value.weekIndex) && value.weekIndex >= 0 ? value.weekIndex : 0;
  const researchHours = Number.isFinite(value.researchHours) ? value.researchHours : 5;

  return {
    schemaVersion: SCHEMA_VERSION,
    screen: VALID_SCREENS.includes(value.screen) ? value.screen : 'home',
    setupComplete: Boolean(value.setupComplete),
    demo: value.demo !== undefined ? Boolean(value.demo) : true,
    fixed: Boolean(value.fixed),
    includeResearch: value.includeResearch !== undefined ? Boolean(value.includeResearch) : true,
    researchHours,
    weekIndex,
    days: value.days,
    tasks: value.tasks,
    sleep: { start: value.sleep.start, end: value.sleep.end },
    settings: value.settings,
    proposals: value.proposals,
    selectedRepairId: typeof value.selectedRepairId === 'string' ? value.selectedRepairId : null,
    pendingApprovals: value.pendingApprovals,
    appliedChanges: value.appliedChanges,
    feedback: {
      tasks: value.feedback.tasks,
      sleepReports: value.feedback.sleepReports
    },
    estimateProfiles: Array.isArray(value.estimateProfiles) ? value.estimateProfiles : [],
    calendarImportedAt: typeof value.calendarImportedAt === 'string' ? value.calendarImportedAt : null,
    tasksImportedAt: typeof value.tasksImportedAt === 'string' ? value.tasksImportedAt : null,
    lastEditedAt: typeof value.lastEditedAt === 'string' ? value.lastEditedAt : null,
    unresolvedConflict: Boolean(value.unresolvedConflict),
    draftIncludeWorkload: Boolean(value.draftIncludeWorkload),
    displayName: typeof value.displayName === 'string' ? value.displayName.slice(0, 40) : '',
    personalBackup: isPlainObject(value.personalBackup) && Array.isArray(value.personalBackup.days) ? value.personalBackup : null,
    skippedSleepPromptDate: typeof value.skippedSleepPromptDate === 'string' ? value.skippedSleepPromptDate : null,
    notice: ''
  };
}

/**
 * Reads and migrates persisted state from browser storage without throwing.
 */
export function loadState(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { state: null, warning: '' };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return { state: raw === null ? null : migrate(JSON.parse(raw)), warning: '' };
  } catch {
    return { state: null, warning: 'Saved data could not be loaded. A fresh plan is open.' };
  }
}

/**
 * Persists a snapshot of the single state object (clearing transient notice).
 */
export function saveState(storage, state) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const serializable = { ...state, notice: '' };
  storage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  return true;
}

/**
 * Clears all persisted application data from storage.
 */
export function clearState(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  storage.removeItem(STORAGE_KEY);
  return true;
}
