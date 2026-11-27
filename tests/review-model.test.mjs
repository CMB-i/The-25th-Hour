import assert from 'node:assert/strict';
import test from 'node:test';
import { getEstimateSuggestion } from '../src/engine/feedback.mjs';
import { buildInsight, buildLedger } from '../src/ui/render-feedback.mjs';
import { createStore } from '../src/ui/state.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
setNowProvider('2026-11-16T07:00:00+05:30');

// render-feedback imports DOM helpers lazily (only used when rendering), so the pure builders load in Node.
function storeWithLog(entries) {
  const store = createStore({ storage: null });
  store.dispatch({ type: 'LOAD_DEMO', fixed: false });
  entries.forEach(([taskId, estimated, actual], index) => {
    store.dispatch({ type: 'RECORD_TASK_FEEDBACK', taskId, taskType: 'project', actualHours: actual, recordedAt: `2026-11-16T1${index}:00` });
  });
  return store;
}

test('the insight needs three finished tasks of a type, and every number comes from the log', () => {
  const two = storeWithLog([['dbms', 4, 5], ['ml', 3, 4]]);
  assert.equal(buildInsight(two.getState(), two.derive().estimateProfiles), null, 'no insight under 3 samples');

  const three = storeWithLog([['dbms', 4, 5], ['ml', 3, 4], ['poster', 3, 3.5]]);
  const state = three.getState();
  const insight = buildInsight(state, three.derive().estimateProfiles);
  assert.ok(insight);
  const entries = state.feedback.tasks;
  const avgEst = entries.reduce((sum, e) => sum + e.estimatedLikely, 0) / 3;
  const avgAct = entries.reduce((sum, e) => sum + e.actualHours, 0) / 3;
  assert.match(insight.title, new RegExp(`run about ${Math.round(Math.abs(avgAct - avgEst) * 60)} minutes long`));
  const profile = three.derive().estimateProfiles.find(p => p.type === 'project');
  const suggestion = getEstimateSuggestion(profile, Math.round(avgEst * 2) / 2);
  assert.ok(insight.sub.includes(`Use ${Math.round(suggestion * 10) / 10}h?`));
});

test('the ledger lists guessed versus took, newest first, with scaled bars', () => {
  const store = storeWithLog([['dbms', 4, 5], ['ml', 3, 3], ['poster', 3, 2.5]]);
  const rows = buildLedger(store.getState());
  assert.deepEqual(rows.map(row => row.title), ['AUV Club Poster', 'ML Assignment', 'DBMS Lab']);
  assert.deepEqual(rows.map(row => row.delta), ['0.5h under', 'On the nose', '1h over']);
  assert.equal(rows[2].actPct, 100);
  assert.ok(rows[2].estPct < 100);
});
