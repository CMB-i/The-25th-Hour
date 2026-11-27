import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../src/engine/evaluate.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
import { analyzeRequest } from '../src/ui/check-model.mjs';
import { effectiveDays, elapsedCutoff } from '../src/ui/elapsed.mjs';
import { buildHero, buildWeekStrip, freeThisWeek } from '../src/ui/home-model.mjs';
import { createStore, deriveView, makeInitialState, reduceState } from '../src/ui/state.mjs';

const FRI_11 = '2026-11-27T11:00:00+05:30';
const evening = [['18:00', '21:00']];

/** Mon-Fri evenings 18:00-21:00 with 18:00-19:30 busy every day: 1.5h free a day (the report's numbers). */
function week(nowIso = FRI_11, { busyOnFriday = true } = {}) {
  setNowProvider(nowIso);
  let state = makeInitialState({ demo: false, nowIso });
  state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], evening, evening, evening, evening, evening, [], []] });
  for (let i = 0; i < (busyOnFriday ? 5 : 4); i++) {
    state = reduceState(state, { type: 'ADD_BUSY_BLOCK', dayIndex: i, start: '18:00', end: '19:30', label: 'Class' });
  }
  return state;
}
function check(state, fields) {
  const next = reduceState(state, { type: 'ADD_PROPOSAL', fields: { tag: 'flexible', ...fields } });
  const derived = deriveView(next);
  const outcome = derived.commitmentCheck;
  return { state: next, derived, before: outcome.before, after: outcome.separate[0], analysis: null };
}

test('elapsed time is made unavailable on a copy: past days whole, today up to the next half hour', () => {
  const days = week().days;
  const copy = effectiveDays(days, new Date(FRI_11));
  assert.equal(copy[0].elapsed, 'past');
  assert.deepEqual(copy[0].busyWindows.at(-1), ['00:00', '24:00']);
  assert.equal(copy[4].elapsed, 'partial');
  assert.deepEqual(copy[4].busyWindows.at(-1), ['00:00', '11:00']);
  assert.equal(copy[5].elapsed, undefined, 'tomorrow is untouched');
  assert.equal(elapsedCutoff(new Date('2026-11-27T11:00:20+05:30')), 11 * 60 + 30, 'rounded up to the next half hour');
  assert.equal(days[0].elapsed, undefined, 'the input is never changed');
  assert.deepEqual(days[0].busyWindows, [['18:00', '19:30']]);
});

test('"2h due Friday" does not fit at Fri 11:00 when only 1.5h remains (the unadjusted engine said it did)', () => {
  const { state, derived, after } = check(week(), { title: 'Meeting with mentor', likely: 2, deadline: '2026-11-27' });
  assert.equal(after.evaluation.typical.feasible, false);
  // The reported bug, reproduced on the raw loaded days: Mon-Thu counted as free, so it "fit".
  const raw = evaluate([...derived.activeTasks, state.proposals[0]], state.days, { sleep: state.sleep });
  assert.equal(raw.typical.feasible, true, 'raw days count 7.5h before Friday');
});

test('it fits when 2h or more remains, and 1.5h fits when exactly 1.5h remains', () => {
  const noClass = week(FRI_11, { busyOnFriday: false }); // Friday evening is 3h free
  assert.equal(check(noClass, { title: 'Meeting', likely: 2, deadline: '2026-11-27' }).after.evaluation.typical.feasible, true);
  assert.equal(check(week(), { title: 'Short one', likely: 1.5, deadline: '2026-11-27' }).after.evaluation.typical.feasible, true);
});

test('the verdict bar counts from now, and says so', () => {
  const { state, derived, before, after } = check(week(), { title: 'Meeting', likely: 2, deadline: '2026-11-27' });
  const analysis = analyzeRequest({ state, derived, proposal: state.proposals[0], before, after });
  assert.equal(analysis.fits, false);
  assert.equal(analysis.bar.fromNow, true);
  assert.equal(analysis.bar.free, 1.5, 'only the 1.5h that is still ahead');
});

test('past days never contribute free hours, and work due Saturday is never planned into the past', () => {
  setNowProvider(FRI_11);
  let state = week();
  const sat = ['09:00', '21:00'];
  state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], evening, evening, evening, evening, evening, [sat], []] });
  const { derived } = check(state, { title: 'Report', likely: 2, deadline: '2026-11-28' });
  const byDay = derived.commitmentCheck.separate[0].evaluation.typical.byDay;
  for (const index of [0, 1, 2, 3]) {
    const entry = byDay.find(item => item.index === index);
    assert.equal(entry?.capacity ?? 0, 0, `day ${index} is past`);
    assert.equal(entry?.assigned.length ?? 0, 0, `nothing planned into day ${index}`);
  }
});

test('nothing synthetic is stored: days and the saved text are byte-identical around a check', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  setNowProvider(FRI_11);
  const store = createStore({ storage, nowFn: () => FRI_11 });
  store.dispatch({ type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], evening, evening, evening, evening, evening, [], []] });
  store.dispatch({ type: 'ADD_BUSY_BLOCK', dayIndex: 4, start: '18:00', end: '19:30', label: 'Class' });
  const daysBefore = JSON.stringify(store.getState().days);
  const savedBefore = memory.get('the25thhour.v1');
  store.derive();
  assert.equal(JSON.stringify(store.getState().days), daysBefore);
  assert.equal(memory.get('the25thhour.v1'), savedBefore, 'deriving a view writes nothing');
  store.dispatch({ type: 'ADD_PROPOSAL', fields: { title: 'Meeting', likely: 2, deadline: '2026-11-27', tag: 'flexible' } });
  store.derive();
  assert.equal(JSON.stringify(store.getState().days), daysBefore, 'days are unchanged by a check');
  const saved = memory.get('the25thhour.v1');
  assert.doesNotMatch(saved, /"elapsed"/);
  assert.doesNotMatch(saved, /\["00:00","24:00"\]/);
  assert.equal(JSON.parse(saved).days.flatMap(day => day.busyWindows).length, 1, 'only the one block the student added');
});

test('with the clock at Mon 30 Nov 08:00 the behaviour equals the unadjusted engine', () => {
  const nowIso = '2026-11-30T08:00:00+05:30';
  setNowProvider(nowIso);
  let state = makeInitialState({ demo: false, nowIso });
  assert.equal(state.days[0].date, '2026-11-30', 'the loaded weeks start this Monday');
  state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], evening, evening, evening, evening, evening, [], []] });
  state = reduceState(state, { type: 'ADD_PROPOSAL', fields: { title: 'Deck', likely: 3, deadline: '2026-12-02', tag: 'flexible' } });
  const derived = deriveView(state);
  const raw = evaluate([...derived.activeTasks, state.proposals[0]], state.days, { sleep: state.sleep });
  assert.deepEqual(derived.commitmentCheck.separate[0].evaluation, raw);
});

test('Home slack line and week strip use the adjusted numbers', () => {
  const state = week();
  const derived = deriveView(state);
  const now = new Date(FRI_11);
  const strip = buildWeekStrip({ state, derived, now });
  assert.deepEqual(strip.cols.slice(0, 4).map(col => [col.past, col.freeHours]), [[true, 0], [true, 0], [true, 0], [true, 0]]);
  assert.equal(strip.cols[4].freeHours, 1.5);
  assert.match(strip.label, /Monday past/);
  assert.equal(freeThisWeek({ state, derived, now }).freeMinutes, 90);
  const hero = buildHero({ state, derived, now });
  assert.match(`${hero.title} ${hero.sub}`, /1\.5h free/);
  assert.doesNotMatch(hero.title, /wide open|7\.5/);
});

test('a task already due before today is reported plainly, not given a verdict', () => {
  const state = week();
  assert.throws(
    () => reduceState(state, { type: 'ADD_PROPOSAL', fields: { title: 'Old', likely: 1, deadline: '2026-11-25', tag: 'flexible' } }),
    /already passed. That was due in the past/
  );
});

test('due today with no work time left today says "Nothing left today."', () => {
  const late = '2026-11-27T21:10:00+05:30';
  const { state, derived, before, after } = check(week(late), { title: 'Late ask', likely: 1, deadline: '2026-11-27' });
  const analysis = analyzeRequest({ state, derived, proposal: state.proposals[0], before, after });
  assert.equal(analysis.fits, false);
  assert.equal(analysis.nothingLeftToday, true);
  assert.equal(analysis.bigWord, 'Nothing left today.');
});
