import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../src/engine/demo-data.mjs';
import { evaluate, weeklyCheck } from '../src/engine/evaluate.mjs';
import { findRepairs } from '../src/engine/repairs.mjs';

const margin = (result, day) => result.deadlineMargins.find(item => item.dayIndex === day).margin / 60;
const run = (fixed = false) => {
  const {tasks, days, sleep} = demoData(fixed);
  const options = {sleep};
  return {tasks, days, options, evaluation: evaluate(tasks, days, options)};
};
test('T1 daily and cumulative capacity', () => {
  const {evaluation: {typical}} = run();
  assert.deepEqual(typical.byDay.map(day => day.capacity / 60), [4,3,3,3,7]);
  let total = 0;
  assert.deepEqual(typical.byDay.map(day => total += day.capacity / 60), [4,7,10,13,20]);
});
test('T2 weekly baseline A and D', () => {
  const {tasks, days, options} = run();
  for (const [list, hours] of [[tasks,18], [tasks.filter(t => t.id !== 'research'),13]]) {
    assert.deepEqual(weeklyCheck(list, days, options), {
      feasible: true, requiredMinutes: hours * 60, capacityMinutes: 1200
    });
  }
});
test('T3 deadline margins A', () => {
  const {evaluation: e} = run();
  assert.deepEqual([e.optimistic,e.typical,e.conservative].map(s => [1,3,4].map(d => margin(s,d))),
    [[3,-1,3],[3,-2,2],[3,-3,1]]);
});
test('T4 scenario A misses by two hours', () => {
  const {evaluation: e} = run();
  assert.equal(e.verdict, 'infeasible');
  assert.equal(e.typical.lateMinutes, 120);
});
test('T5 scenario A repair order and margins', () => {
  const {tasks, days, options} = run();
  const repairs = findRepairs(tasks, days, options);
  assert.deepEqual(repairs.map(r => r.score), [113,165]);
  assert.deepEqual(repairs.slice(0,2).map(r => [r.id,r.test.verdict,r.needsApproval,
    margin(r.test.typical,3),margin(r.test.conservative,3)]),
    [['move:poster:4','at-risk',false,1,0],['drop:research','feasible',false,3,3]]);
});
test('T6 re-run after moving poster', () => {
  const {tasks, days, options} = run();
  const [first] = findRepairs(tasks, days, options);
  assert.equal(first.test.verdict, 'at-risk');
  assert.deepEqual(findRepairs(first.updated, days, options).map(r => [r.id,r.test.verdict]),
    [['drop:research','feasible']]);
});
test('T7 scenario B repair order', () => {
  const {tasks, days, options, evaluation} = run(true);
  assert.equal(evaluation.verdict,'infeasible');
  const repairs = findRepairs(tasks, days, options);
  assert.deepEqual(repairs.map(r => r.score), [165,173]);
  assert.deepEqual(repairs.slice(0,2).map(r => [r.id,r.test.verdict,r.needsApproval]),
    [['drop:research','feasible',false],['extend:poster:4','at-risk',true]]);
  assert.equal(margin(repairs[1].test.typical,3),1);
  assert.equal(margin(repairs[1].test.conservative,3),0);
});
