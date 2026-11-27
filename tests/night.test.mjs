import assert from 'node:assert/strict';
import test from 'node:test';
import { isNight, morningIndex, verifyWait, windDownStart } from '../src/ui/night.mjs';
import { createStore } from '../src/ui/state.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
setNowProvider(new Date(2026, 10, 17, 23, 20));

function fixtureStore() {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'LOAD_DEMO', fixed: false });
  store.dispatch({ type: 'UPDATE_DEMO_RESEARCH', includeResearch: false, researchHours: 5 });
  return store;
}
const sleep = { start: '23:00', end: '07:00' };

test('night starts an hour before sleep and ends when the sleep window ends', () => {
  assert.equal(windDownStart(sleep), 22 * 60);
  assert.equal(isNight(new Date(2026, 10, 17, 21, 59), sleep), false);
  assert.equal(isNight(new Date(2026, 10, 17, 22, 0), sleep), true);
  assert.equal(isNight(new Date(2026, 10, 18, 2, 0), sleep), true);
  assert.equal(isNight(new Date(2026, 10, 18, 7, 0), sleep), false);
  assert.equal(isNight(new Date(2026, 10, 17, 12, 0), sleep), false);
});

test('"wait till morning" is verified by an engine run with nothing starting before morning', () => {
  const store = fixtureStore();
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Deck', likely: 3, deadline: '2026-11-20' } });
  const state = store.getState();
  const proposal = state.proposals[0];
  const night = new Date(2026, 10, 17, 23, 20);
  assert.equal(morningIndex(state, night), 2);
  const wait = verifyWait({ state, derived: store.derive(), proposal, now: night });
  assert.ok(wait, 'fits when everything due from Wednesday starts on Wednesday');
  assert.deepEqual(wait.dayNames, ['Wednesday', 'Thursday', 'Friday']);
  assert.equal(wait.need, 3);
  assert.ok(wait.free >= wait.need);
  // After midnight, before waking, the "morning" is the same calendar day.
  assert.equal(morningIndex(state, new Date(2026, 10, 18, 0, 30)), 2);
  // In the daytime the claim is never made.
  assert.equal(verifyWait({ state, derived: store.derive(), proposal, now: new Date(2026, 10, 17, 14, 0) }), null);
});

test('no claim when starting from morning would not fit, or the work is due before it could start', () => {
  const store = fixtureStore();
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Tight', likely: 3, deadline: '2026-11-19' } });
  const state = store.getState();
  const night = new Date(2026, 10, 17, 23, 20);
  assert.equal(verifyWait({ state, derived: store.derive(), proposal: state.proposals[0], now: night }), null, 'Thursday cannot hold it from Wednesday morning');
  store.dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: ['proposal'] });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Due tonight', likely: 1, deadline: '2026-11-17' } });
  assert.equal(verifyWait({ state: store.getState(), derived: store.derive(), proposal: store.getState().proposals[0], now: night }), null);
});
