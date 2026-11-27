import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHero, buildRecents, buildWeekStrip, dayPart, greetingEyebrow, observeWeek } from '../src/ui/home-model.mjs';
import { createStore } from '../src/ui/state.mjs';
import { onTimeSlots } from '../src/ui/week-model.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
setNowProvider(new Date(2026, 10, 16, 10, 0));

// A personal plan built from the fixture, written as ordinary data (as the browser tests do).
function planStore({ research = true } = {}) {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'LOAD_DEMO', fixed: false });
  if (!research) store.dispatch({ type: 'UPDATE_DEMO_RESEARCH', includeResearch: false, researchHours: 5 });
  return store;
}
const monday = new Date(2026, 10, 16, 10, 0);

test('greeting and part of day come from the clock', () => {
  assert.equal(dayPart(8), 'morning');
  assert.equal(dayPart(14), 'afternoon');
  assert.equal(dayPart(19), 'evening');
  assert.equal(dayPart(23), 'night');
  assert.equal(greetingEyebrow(new Date(2026, 10, 18, 19, 0)), 'WEDNESDAY EVENING');
  assert.equal(greetingEyebrow(new Date(2026, 10, 18, 9, 0), 'Sam'), 'GOOD MORNING, SAM');
});

test('hero reads slack from the engine margin, and names the conflict when there is one', () => {
  const ok = planStore({ research: false });
  const hero = buildHero({ state: ok.getState(), derived: ok.derive(), now: monday });
  assert.equal(hero.kind, 'slack');
  assert.equal(hero.title, 'You have 3 hours of real slack by Tuesday.');
  assert.match(hero.sub, /Worth knowing before the next yes\.$/);
  const bad = planStore({ research: true });
  const conflict = observeWeek(bad.getState(), bad.derive());
  assert.equal(conflict.atRisk, true);
  assert.match(conflict.text, /are due Thursday 19 Nov and you're 2 hours short\.$/);
});

test('week strip is read-only from the schedule: room per day, planned per day, coral only where over', () => {
  const store = planStore({ research: true });
  const state = store.getState();
  const derived = store.derive();
  const strip = buildWeekStrip({ state, derived, now: monday });
  assert.equal(strip.cols.length, 7);
  for (const col of strip.cols) {
    const entry = derived.evaluation.typical.byDay.find(item => item.index === col.index);
    assert.equal(col.cap, entry.capacity / 60);
    // Work placed after its deadline is not drawn as planned.
    assert.equal(col.used, Math.min(onTimeSlots(entry.assigned, col.index, derived.activeTasks).length * 0.5, col.cap));
  }
  assert.ok(strip.cols.some(col => col.over), 'the over day is flagged');
  const clear = planStore({ research: false });
  assert.equal(buildWeekStrip({ state: clear.getState(), derived: clear.derive(), now: monday }).cols.some(col => col.over), false);
});

test('Recent checks come from decisions and pending drafts', () => {
  const store = planStore({ research: false });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Poster', likely: 1, deadline: '2026-11-20' } });
  store.dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: ['proposal'] });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Notes', likely: 2, deadline: '2026-11-20', audience: 'self' } });
  store.dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds: ['proposal'], mode: 'accept' });
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Lab', likely: 1, deadline: '2026-11-20' } });
  const recents = buildRecents(store.getState(), 5);
  assert.deepEqual(recents.map(item => [item.title, item.label]), [['Lab', 'Still deciding'], ['Notes', 'Said yes'], ['Poster', 'Said no']]);
  assert.equal(recents[1].meta, '2 hours · my own');
  assert.equal(buildRecents(createStore({ storage: null }).getState()).length, 0);
});
