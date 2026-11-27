import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, makeInitialState, reduceState } from '../src/ui/state.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
setNowProvider('2026-11-23T08:00:00+05:30');

const NOW = '2026-11-23T08:00:00+05:30';
const win = [['09:00', '21:00']];

function plan() {
  let state = makeInitialState({ demo: false, nowIso: NOW });
  return reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], win, win, win, win, win, [], []] }, () => NOW);
}
const add = (state, title) => {
  let next = reduceState(state, { type: 'ADD_PROPOSAL', fields: { title, likely: 2, deadline: '2026-11-27', tag: 'flexible' } }, () => NOW);
  return reduceState(next, { type: 'ACCEPT_PROPOSAL', proposalIds: [next.proposals[0].id], mode: 'accept' }, () => NOW);
};

test('Undo on the "added" banner takes the task back out, and the record of the yes with it', () => {
  const added = add(plan(), 'Deck');
  assert.equal(added.tasks.length, 1);
  assert.ok(added.undoAdd && added.undoAdd.notice === added.notice, 'banner can offer Undo');
  assert.equal(added.decisions.length, 1);
  const undone = reduceState(added, { type: 'UNDO_ADDED' }, () => NOW);
  assert.equal(undone.tasks.length, 0);
  assert.equal(undone.decisions.length, 0);
  assert.equal(undone.undoAdd, undefined);
  assert.match(undone.notice, /Removed "Deck"/);
});

test('Undo is offered only for the notice it belongs to', () => {
  const added = add(plan(), 'Deck');
  const dismissed = reduceState(added, { type: 'SET_NOTICE', notice: '' }, () => NOW);
  assert.equal(dismissed.undoAdd, undefined);
  assert.throws(() => reduceState(dismissed, { type: 'UNDO_ADDED' }, () => NOW), /Nothing to undo/);
});

test('Remove deletes one task by id at any time and leaves the others', () => {
  let state = add(add(plan(), 'Deck'), 'Report');
  assert.equal(state.tasks.length, 2);
  const id = state.tasks.find(task => task.title === 'Report').id;
  state = reduceState(state, { type: 'REMOVE_TASK', taskId: id }, () => NOW);
  assert.deepEqual(state.tasks.map(task => task.title), ['Deck']);
  assert.throws(() => reduceState(state, { type: 'REMOVE_TASK', taskId: id }, () => NOW), /not in your week/);
});

test('removal sticks through save and reload, and a later repair-undo cannot bring the task back', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const store = createStore({ storage, nowFn: () => NOW });
  store.dispatch({ type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], win, win, win, win, win, [], []] });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'One', likely: 2, deadline: '2026-11-27', tag: 'flexible' } });
  store.dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds: [store.getState().proposals[0].id], mode: 'accept' });
  store.dispatch({ type: 'UNDO_ADDED' });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Two', likely: 2, deadline: '2026-11-27', tag: 'flexible' } });
  store.dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds: [store.getState().proposals[0].id], mode: 'accept' });
  store.dispatch({ type: 'REMOVE_TASK', taskId: store.getState().tasks[0].id });
  const reloaded = createStore({ storage, nowFn: () => NOW });
  assert.deepEqual(reloaded.getState().tasks, []);
});
