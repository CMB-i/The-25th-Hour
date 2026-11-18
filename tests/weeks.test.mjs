import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { deadlineCost, evaluate } from '../src/engine/evaluate.mjs';
import { findRepairs } from '../src/engine/repairs.mjs';
import { rebasePlan, rollingDays, weekView } from '../src/engine/weeks.mjs';

import { windows, workload } from './fixtures/workload.mjs';

test('rolling navigation and a binding deadline beyond the original demo week', () => {
  const {days,tasks} = workload();
  assert.equal(days.length,35);
  assert.deepEqual(weekView(days,4),{startDate:'2027-02-01',endDate:'2027-02-07',dayIndices:[28,29,30,31,32,33,34]});
  const moved = [{...tasks[0],targetDay:30,hardDay:30,earliestDay:30,likely:9,max:9}];
  const evaluated = evaluate(moved,days);
  assert.equal(evaluated.verdict,'infeasible');
  assert.equal(deadlineCost(evaluated.typical,days).weekday,'Wednesday');
  assert.equal(evaluated.typical.lateMinutes,300);
  const rolled = rebasePlan(days,moved,rollingDays('2027-01-11',windows));
  assert.equal(rolled.tasks[0].targetDay,23);
});
test('T24 five-week, 30-task evaluation and repair search', t => {
  const {days,tasks} = workload();
  const sample = fn => {
    const start = performance.now();
    const result = fn(tasks,days);
    return {result,ms:performance.now() - start};
  };
  const evaluation = sample(evaluate);
  const repairs = sample(findRepairs);
  t.diagnostic(`35 days / 30 tasks: evaluate ${evaluation.ms.toFixed(2)} ms; findRepairs ${repairs.ms.toFixed(2)} ms`);
  assert.equal(evaluation.result.verdict,'infeasible');
  assert.ok(repairs.result.length > 0);
  assert.ok(evaluation.ms < 100);
  assert.ok(repairs.ms < 250);
});
