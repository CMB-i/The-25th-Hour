export const STORAGE_KEY = 'the25thhour.v1';
export const SCHEMA_VERSION = 1;

export function migrate(value) {
  if (value?.schemaVersion !== SCHEMA_VERSION ||
      !['tasks','days','appliedChanges','proposals','pendingApprovals'].every(key => Array.isArray(value[key])) ||
      !Array.isArray(value.feedback?.tasks) || !Array.isArray(value.feedback?.sleepReports) ||
      !value.settings || !value.sleep) {
    throw Error('Unrecognised saved data format.');
  }
  return value;
}

export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return {state:raw === null ? null : migrate(JSON.parse(raw)), warning:''};
  } catch {
    return {state:null, warning:'Saved data could not be loaded. A fresh plan is open.'};
  }
}

export function saveState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearState(storage) {
  storage.removeItem(STORAGE_KEY);
}
