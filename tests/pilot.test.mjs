// Pilot analysis script (scripts/analyze-pilot.mjs) against a real app CSV export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { campusDay, formatReport, median, parseCsv, summariseParticipant, weekOf } from '../scripts/analyze-pilot.mjs';
import { buildFeedbackCsv } from '../src/ui/render-settings.mjs';
import { findRepairs } from '../src/engine/repairs.mjs';
import { getActiveTasks, makeInitialState, reduceState } from '../src/ui/state.mjs';

const START = '2026-11-23';

test('helpers: CSV quoting, medians, campus dates and pilot weeks', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""",2\r\n'), [{ a: 'x, "y"', b: '2' }]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(campusDay('2026-11-29T20:00:00Z'), '2026-11-30', 'UTC evening is the next campus day');
  assert.equal(campusDay('2026-11-29T23:30'), '2026-11-29');
  assert.deepEqual(['2026-11-22', START, '2026-11-29', '2026-11-30', '2026-12-06', '2026-12-07'].map(d => weekOf(d, START)),
    [null, 1, 1, 2, 2, null]);
});

test('export -> per-participant medians and process metrics, with honest reporting rules', async () => {
  // Build a real export through the app reducer: one applied self-serve repair, one task, one app sleep report.
  const now = '2026-12-01T10:00:00+05:30';
  const reduce = (state, action) => reduceState(state, action, () => now);
  let state = makeInitialState({ fixed: false });
  state = reduce(state, { type: 'APPLY_REPAIR', repairId: findRepairs(getActiveTasks(state), state.days)[0].id });
  state = reduce(state, { type: 'RECORD_TASK_FEEDBACK', taskId: 'french', actualHours: 4.5, taskType: 'other', recordedAt: '2026-12-01T18:00' });
  state = reduce(state, { type: 'RECORD_SLEEP_REPORT', date: '2026-12-04', hoursSlept: 8, stress: 2 });
  const csv = buildFeedbackCsv(state);
  assert.match(csv.split('\n')[0], /,change_kind$/);
  assert.match(csv, /^applied_change,move:poster:4,Move AUV Club Poster target to Friday,.*,self_serve$/m);

  const diary = parseCsv(await readFile(new URL('./fixtures/pilot/diary.csv', import.meta.url), 'utf8'));
  const p1 = summariseParticipant('P01', parseCsv(csv), diary.filter(r => r.participant === 'P01'), START);
  assert.deepEqual(p1.sleep, { week1: 6, n1: 5, week2: 7.25, n2: 4 }, 'diary first; app report fills 2026-12-04; blank diary night skipped');
  assert.deepEqual(p1.stress, { week1: 3, n1: 5, week2: 2.5, n2: 4 });
  assert.deepEqual(p1.estimateError, { other: { median: 1.5, n: 1 } });
  assert.equal(p1.process.repairsApplied, 1);
  assert.equal(p1.process.selfServe, 1);
  assert.equal(p1.process.fixesSeen, 3);
  assert.equal(p1.process.requestsSent, 1);
  assert.equal(p1.process.requestsApproved, 1);
  assert.equal(p1.process.acceptAnyway, 1);
  assert.equal(p1.process.conflictsResolved, 1);
  assert.equal(p1.process.conflictsFlagged, 2);

  const p2 = summariseParticipant('P02', [], diary.filter(r => r.participant === 'P02'), START);
  assert.equal(p2.process.requestsSent, null, 'missing diary fields are n/a, not zero');
  const report = formatReport([p1, p2], START);
  assert.match(report, /Participant P01\n  Sleep, median per night \(primary outcome\): week 1 6h \(5 nights\) -> week 2 7\.25h \(4 nights\); change \+1\.25h/);
  assert.match(report, /Repair adoption \(applied \+ requested \/ seen\): 2 of 3 \(67%\)/);
  assert.match(report, /Do not claim statistical significance/);
  assert.match(report, /no control group/);
  assert.doesNotMatch(report, /significant(ly)? (improv|increas|differ)|p\s*[<=]/i);
});
