import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRequest, buildReply, buildEstimateRange } from '../src/ui/check-model.mjs';
import { createStore } from '../src/ui/state.mjs';

// Builds the real store on the example week and checks one request through
// the same engine calls the UI makes. Nothing here is hand-written output.
function check({ fixed = false, research = true, fields, smaller = null }) {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'LOAD_DEMO', fixed });
  if (!research) store.dispatch({ type: 'UPDATE_DEMO_RESEARCH', includeResearch: false, researchHours: 5 });
  store.dispatch({ type: 'ADD_PROPOSAL', fields });
  const state = store.getState();
  const derived = store.derive();
  const proposal = state.proposals[0];
  const before = derived.commitmentCheck.before;
  const after = derived.commitmentCheck.separate[0];
  const analysis = analyzeRequest({ state, derived, proposal, before, after, smaller });
  return { store, state, derived, proposal, before, after, analysis };
}

const base = { title: 'Study group notes', likely: 2, deadline: '2026-11-20' };

test('a request that fits gets a plain yes for the entered deadline', () => {
  const { analysis, proposal, state } = check({ research: false, fields: base });
  assert.equal(analysis.kind, 'fits');
  assert.equal(analysis.replyKind, 'yes');
  assert.equal(analysis.option, null);
  const reply = buildReply({ analysis, proposal, days: state.days });
  assert.match(reply.text, /Yes, I can take on Study group notes/);
  assert.match(reply.text, /Friday 20 Nov/);
  assert.doesNotMatch(reply.text, /sleep|stress/i);
});

test('verdict numbers come from the engine, not from fixed text', () => {
  const { analysis, after } = check({
    research: false,
    fields: { title: 'Big thing', likely: 6, deadline: '2026-11-17' }
  });
  assert.equal(analysis.kind, 'short');
  const cost = after.cost;
  assert.ok(cost.shortfallHours > 0);
  assert.match(analysis.headline, new RegExp(`${cost.shortfallHours} hours? short by ${cost.weekday}`));
  assert.doesNotMatch(analysis.headline, /Thursday/);
});

test('a request that does not fit but has a self-serve option gives a conditional yes', () => {
  const { analysis, proposal, state } = check({
    research: false,
    fields: { title: 'Poster help', likely: 4, deadline: '2026-11-19', tag: 'flexible' }
  });
  assert.equal(analysis.kind, 'short');
  assert.ok(analysis.option, 'engine found a verified option');
  assert.equal(analysis.option.needsApproval, false);
  assert.ok(['conditional', 'conditional-date'].includes(analysis.replyKind));
  assert.ok(analysis.option.resultFits);
  const reply = buildReply({ analysis, proposal, days: state.days });
  assert.doesNotMatch(reply.text, /sleep|stress/i);
});

test('an option that moves the request date only names a date the engine verified', () => {
  const { analysis, proposal, state, after } = check({
    research: false,
    fields: { title: 'Poster help', likely: 4, deadline: '2026-11-19', tag: 'flexible' }
  });
  const moves = after.repairs.filter(r => r.actions.some(a => a.taskId === proposal.id && a.type === 'move'));
  assert.ok(moves.length > 0);
  if (analysis.replyKind === 'conditional-date') {
    const reply = buildReply({ analysis, proposal, days: state.days });
    const date = state.days[analysis.option.movesRequestToDay].date;
    assert.match(reply.text, /Friday 20 Nov/);
    assert.equal(date, '2026-11-20');
    assert.equal(analysis.option.repair.test.typical.feasible, true);
  }
});

test('an option that needs approval drafts the engine approval request and does not promise the request', () => {
  const { analysis, proposal, state } = check({
    fixed: true,
    research: false,
    fields: { title: 'Lab write-up', likely: 4, deadline: '2026-11-19' }
  });
  assert.equal(analysis.kind, 'short');
  assert.equal(analysis.option.needsApproval, true);
  assert.equal(analysis.replyKind, 'approval');
  const reply = buildReply({ analysis, proposal, days: state.days });
  assert.match(reply.text, /Request to adjust AUV Club Poster deadline/);
  assert.match(reply.text, /2026-11-20/);
  assert.doesNotMatch(reply.text, /Yes, I can take on/);
  assert.equal(state.proposals.length, 1, 'the request stays pending');
  assert.equal(state.tasks.some(t => t.title === 'Lab write-up'), false, 'and is not in the plan');
});

test('with no verified fix, the reply is a kind no or a flexibility request without a date promise', () => {
  const { analysis, proposal, state } = check({
    research: false,
    fields: { title: 'Huge project', likely: 20, deadline: '2026-11-17' }
  });
  assert.equal(analysis.kind, 'short');
  assert.equal(analysis.option, null);
  assert.equal(analysis.replyKind, 'decline');
  const no = buildReply({ analysis, proposal, days: state.days, variant: 'decline' });
  assert.match(no.text, /can't take it on/);
  const flex = buildReply({ analysis, proposal, days: state.days, variant: 'flex' });
  assert.match(flex.text, /flexible/);
  assert.doesNotMatch(flex.text, /I'll have it done by|I can have it to you by/);
});

test('an existing conflict is named so the new request is not blamed for it', () => {
  const { analysis, before } = check({
    research: true,
    fields: { title: 'Small ask', likely: 1, deadline: '2026-11-20' }
  });
  assert.equal(before.evaluation.typical.feasible, false);
  assert.equal(analysis.baselineBroken, true);
  assert.match(analysis.headline, /already .* short by Thursday/);
});

test('the estimate range appears only when the answer changes with the estimate, using only this request\'s hours', () => {
  const { derived, proposal, state } = check({
    research: false,
    fields: { title: 'Maybe long', likely: 3, min: 2, max: 5, deadline: '2026-11-19' }
  });
  const range = buildEstimateRange({ tasks: derived.activeTasks, proposal, days: state.days, options: derived.options });
  assert.ok(range, 'range shown when fit differs between estimates');
  assert.match(range.sentence, /At 2h or 3h it fits\./);
  assert.match(range.sentence, /At 5h you're 2 hours short by Thursday 19 Nov\./);

  const calm = check({ research: false, fields: { ...base, likely: 1 } });
  const none = buildEstimateRange({
    tasks: calm.derived.activeTasks, proposal: calm.proposal, days: calm.state.days, options: calm.derived.options
  });
  assert.equal(none, null, 'no range when every estimate gives the same answer');
});

test('smaller offer is only feasible after the engine verifies it', () => {
  const full = check({ research: false, fields: { title: 'Report', likely: 6, deadline: '2026-11-17' } });
  assert.equal(full.analysis.fits, false);

  // 1h fits on Tuesday; 6h did not. The engine decides, not the form.
  const small = check({
    research: false,
    fields: { title: 'Report', likely: 1, deadline: '2026-11-17' },
    smaller: { active: true, scope: 'the outline' }
  });
  assert.equal(small.analysis.fits, true);
  assert.equal(small.analysis.replyKind, 'smaller-yes');
  const reply = buildReply({
    analysis: small.analysis, proposal: small.proposal, days: small.state.days,
    smaller: { active: true, scope: 'the outline' }
  });
  assert.match(reply.text, /I can do the outline by Tuesday 17 Nov/);

  const stillTooBig = check({
    research: false,
    fields: { title: 'Report', likely: 5, deadline: '2026-11-17' },
    smaller: { active: true, scope: 'most of it' }
  });
  assert.equal(stillTooBig.analysis.fits, false);
  assert.notEqual(stillTooBig.analysis.replyKind, 'smaller-yes');
});

test('UPDATE_PROPOSAL reruns the same request in place and ADD_BUSY_BLOCK changes the verdict', () => {
  const { store } = check({ research: false, fields: { title: 'Notes', likely: 3, deadline: '2026-11-17' } });
  const id = store.getState().proposals[0].id;
  const fits = store.derive().commitmentCheck.separate[0].evaluation.typical.feasible;
  assert.equal(fits, true);
  store.dispatch({ type: 'ADD_BUSY_BLOCK', dayIndex: 1, start: '17:00', end: '20:00' });
  assert.equal(store.getState().proposals[0].id, id, 'request kept');
  assert.equal(store.derive().commitmentCheck.separate[0].evaluation.typical.feasible, false);
  store.dispatch({ type: 'REMOVE_BUSY_BLOCK', dayIndex: 1, start: '17:00', end: '20:00' });
  assert.equal(store.derive().commitmentCheck.separate[0].evaluation.typical.feasible, true);
  store.dispatch({
    type: 'UPDATE_PROPOSAL', proposalId: id,
    fields: { title: 'Notes', likely: '1', deadline: '2026-11-17' }
  });
  assert.equal(store.getState().proposals.length, 1);
  assert.equal(store.getState().proposals[0].likely, 1);
});

test('a fresh store is a blank personal week, never the demo fixture', () => {
  const store = createStore({ storage: null });
  const state = store.getState();
  assert.equal(state.demo, false);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.settings.weeklyWorkWindows.every(day => day.length === 0), true);
});

test('entering and leaving an example restores the personal week untouched', () => {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'SAVE_SETTINGS', sleepStart: '23:00', sleepEnd: '07:00', anchor: '2026-11-30',
    weeklyWorkWindows: [[], [['16:00', '18:00']], [], [], [], [], []] });
  store.dispatch({ type: 'ADD_BUSY_BLOCK', dayIndex: 1, start: '09:00', end: '10:00' });
  const mine = store.getState();
  store.dispatch({ type: 'LOAD_DEMO', fixed: false });
  assert.equal(store.getState().demo, true);
  assert.ok(store.getState().personalBackup);
  store.dispatch({ type: 'LOAD_DEMO', fixed: true }); // switching examples keeps the same backup
  store.dispatch({ type: 'LEAVE_DEMO' });
  const back = store.getState();
  assert.equal(back.demo, false);
  assert.deepEqual(back.days, mine.days);
  assert.deepEqual(back.settings, mine.settings);
  assert.equal(back.personalBackup, null);
});

test('leaving an example from a blank start returns to a blank week', () => {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'LOAD_DEMO', fixed: false });
  assert.equal(store.getState().personalBackup, null);
  store.dispatch({ type: 'LEAVE_DEMO' });
  assert.equal(store.getState().demo, false);
  assert.equal(store.getState().tasks.length, 0);
});
