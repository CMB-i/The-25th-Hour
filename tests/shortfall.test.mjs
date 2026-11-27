import assert from 'node:assert/strict';
import test from 'node:test';
import { setNowProvider } from '../src/ui/clock.mjs';
import { analyzeRequest, buildReply, conflictClause, isMeeting } from '../src/ui/check-model.mjs';
import { planNumbers } from '../src/ui/numbers.mjs';
import { buildAgenda, onTimeSlots } from '../src/ui/week-model.mjs';
import { costLines } from '../src/ui/render-cost.mjs';
import { buildVerdictCopy } from '../src/ui/dom.mjs';
import { deriveView, makeInitialState, reduceState } from '../src/ui/state.mjs';
import { deadlineCost } from '../src/engine/evaluate.mjs';

const NOW = '2026-11-23T08:00:00+05:30';
setNowProvider(NOW);
const evening = [['18:00', '21:00']];
const weekdays = [[], evening, evening, evening, evening, evening, [['09:00', '21:00']], [['09:00', '21:00']]];

/** Mon 23 Nov: Friday 18:00-21:00 is 3h of work time, so 4h due Friday is 1h short; Sat and Sun are wide open. */
function plan() {
  let state = makeInitialState({ demo: false, nowIso: NOW });
  state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: weekdays });
  for (let i = 0; i < 4; i++) state = reduceState(state, { type: 'ADD_BUSY_BLOCK', dayIndex: i, start: '18:00', end: '21:00' });
  return state;
}
function request(state, fields) {
  const next = reduceState(state, { type: 'ADD_PROPOSAL', fields: { tag: 'flexible', latestDate: '2026-11-29', ...fields } });
  const derived = deriveView(next);
  const checked = derived.commitmentCheck;
  const analysis = analyzeRequest({ state: next, derived, proposal: next.proposals[0], before: checked.before, after: checked.separate[0] });
  return { state: next, derived, analysis };
}

test('one plan, one shortfall: the verdict, the cost screen, the week and Reset read the same numbers', () => {
  const asked = request(plan(), { title: 'Report', likely: 4, deadline: '2026-11-27' });
  assert.equal(asked.analysis.fits, false);
  const short = asked.analysis.numbers.short;
  assert.equal(short, 1);
  // Verdict headline and Reset lead both come from conflictClause on the same typical schedule.
  assert.equal(asked.analysis.afterClause.hours, short);
  // Save it with "Say yes anyway".
  const saved = reduceState(asked.state, { type: 'ACCEPT_PROPOSAL', proposalIds: [asked.state.proposals[0].id], mode: 'override', thenScreen: 'week' });
  assert.equal(saved.screen, 'week', 'lands on My week, never the blank form');
  assert.match(saved.notice, /^On your week\. 1h is still short by Friday\.$/);
  const derived = deriveView(saved);
  // My week: the sidebar card, the grid marker and the day header.
  assert.equal(derived.numbers.short, short);
  assert.equal(deadlineCost(derived.evaluation.typical, derived.planDays).shortfallHours, short, 'sidebar copy reads deadlineCost');
  assert.match(buildVerdictCopy(derived.evaluation, derived.planDays).body, /Short by 1h\./);
  const agenda = buildAgenda({ state: saved, derived });
  assert.deepEqual(agenda.filter(day => day.shortHours).map(day => [day.weekday, day.shortHours]), [['Friday', 1]]);
  // Reset: the clause it prints.
  assert.equal(conflictClause(derived.evaluation.typical, derived.planDays).hours, short);
  // Same helper everywhere.
  assert.equal(planNumbers(derived.evaluation.typical, derived.planDays).short, short);
});

test('nothing is drawn after its deadline, and the shortfall is a single marker on the deadline day', () => {
  const asked = request(plan(), { title: 'Report', likely: 4, deadline: '2026-11-27' });
  const saved = reduceState(asked.state, { type: 'ACCEPT_PROPOSAL', proposalIds: [asked.state.proposals[0].id], mode: 'override' });
  const derived = deriveView(saved);
  const engineLate = derived.evaluation.typical.byDay.flatMap(day => day.assigned.filter(slot => slot.late));
  const agenda = buildAgenda({ state: saved, derived });
  for (const day of agenda) {
    if (day.index > 4) {
      assert.deepEqual(day.entries.filter(entry => entry.kind === 'work'), [], `${day.weekday} has no planned work after the Friday deadline`);
    }
    assert.equal(onTimeSlots(derived.evaluation.typical.byDay.find(d => d.index === day.index)?.assigned, day.index, derived.activeTasks)
      .some(slot => slot.late), false);
  }
  const marked = agenda.filter(day => day.shortHours > 0);
  assert.equal(marked.length, 1, 'one marker');
  assert.equal(marked[0].weekday, 'Friday');
  // Whatever the engine placed late is simply not drawn, and the time it used stays free (for another yes).
  if (engineLate.length) assert.ok(agenda[5].free.freeMinutes > 0 || agenda[6].free.freeMinutes > 0);
  // The work that does fit is planned before the deadline: 3h on Friday.
  const planned = agenda[4].entries.filter(entry => entry.kind === 'work').reduce((sum, entry) => sum + (entry.to - entry.from), 0);
  assert.equal(planned, 180);
});

test('past time is never planned into', () => {
  setNowProvider('2026-11-26T12:00:00+05:30'); // Thursday noon
  try {
    let state = makeInitialState({ demo: false, nowIso: '2026-11-26T12:00:00+05:30' });
    state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], [['09:00', '21:00']], [['09:00', '21:00']], [['09:00', '21:00']], [['09:00', '21:00']], [['09:00', '21:00']], [], []] });
    const asked = request(state, { title: 'Report', likely: 30, deadline: '2026-11-27' });
    const saved = reduceState(asked.state, { type: 'ACCEPT_PROPOSAL', proposalIds: [asked.state.proposals[0].id], mode: 'override' });
    const agenda = buildAgenda({ state: saved, derived: deriveView(saved) });
    for (const day of agenda.slice(0, 3)) assert.deepEqual(day.entries.filter(entry => entry.kind === 'work'), [], `${day.weekday} is past`);
    assert.equal(agenda[3].entries.filter(entry => entry.kind === 'work' && entry.from < 12 * 60).length, 0, 'nothing planned before now on Thursday');
  } finally {
    setNowProvider(NOW);
  }
});

test('the cost screen lines are computed, and the third only appears when another deadline is in the way', () => {
  const asked = request(plan(), { title: 'Report', likely: 4, deadline: '2026-11-27' });
  const lines = costLines({ analysis: asked.analysis, state: asked.state, derived: asked.derived, proposal: asked.state.proposals[0] });
  assert.deepEqual(lines, [
    'It uses all 3h of your free time until Friday.',
    'Sleep stays protected (23:00-07:00), so the shortfall lands on the deadline.'
  ]);
  // Another deadline before Friday.
  let state = plan();
  state = reduceState(state, { type: 'ADD_PROPOSAL', fields: { title: 'Quiz prep', likely: 1, deadline: '2026-11-27', tag: 'flexible' } });
  state = reduceState(state, { type: 'ACCEPT_PROPOSAL', proposalIds: [state.proposals[0].id], mode: 'accept' });
  const again = request(state, { title: 'Report', likely: 4, deadline: '2026-11-27' });
  const more = costLines({ analysis: again.analysis, state: again.state, derived: again.derived, proposal: again.state.proposals[0] });
  assert.equal(more.at(-1), 'Anything else due before Friday gets squeezed too.');
});

test('a meeting reply says "I can make the meeting", not "I\'ll have it done"', () => {
  assert.equal(isMeeting({ title: 'Meeting with club mentor' }), true);
  assert.equal(isMeeting({ title: 'Poster for the fest' }), false);
  const fits = request(plan(), { title: 'Meeting with club mentor', likely: 1, deadline: '2026-11-27' });
  const yes = buildReply({ analysis: fits.analysis, proposal: fits.state.proposals[0], days: fits.derived.planDays });
  assert.match(yes.text, /I can make the meeting on Friday 27 Nov\./);
  assert.doesNotMatch(yes.text, /have it done/);
  const no = request(plan(), { title: 'Meeting with club mentor', likely: 6, deadline: '2026-11-27' });
  const decline = buildReply({ analysis: no.analysis, proposal: no.state.proposals[0], days: no.derived.planDays });
  assert.match(decline.text, /I can't make the meeting/);
  assert.doesNotMatch(decline.text, /have it done|take it on by/);
  const other = request(plan(), { title: 'Poster', likely: 1, deadline: '2026-11-27' });
  assert.match(buildReply({ analysis: other.analysis, proposal: other.state.proposals[0], days: other.derived.planDays }).text, /have it done by/);
});
