import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSlots, formatTime } from '../src/engine/capacity.mjs';
import { demoData } from '../src/engine/demo-data.mjs';
import { evaluate, verdictText } from '../src/engine/evaluate.mjs';
import { applyAction, applyRepair, draftApprovalRequest, emptyRepairMessage, findRepairs } from '../src/engine/repairs.mjs';
import { schedule } from '../src/engine/scheduler.mjs';

const rank = {infeasible: 0, 'at-risk': 1, feasible: 2};
const hours = [4, 4.5, 5, 5.5, 6];
const sweep = hours.map(likely => {
  const {tasks, days} = demoData();
  return {days, tasks: tasks.map(t => t.id === 'research' ? {...t, min:likely - 1, likely, max: likely + 1} : t)};
});
const random = seed => max => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
};
const task = (id, likely, targetDay, overrides = {}) => ({
  id, title:id, min:likely, likely, max:likely, targetDay, hardDay:targetDay, earliestDay:0, priority:1, ...overrides
});
function instances() {
  const next = random(56789);
  return Array.from({length:200}, () => {
    const days = demoData().days.slice(0, 1 + next(3)).map(day => {
      const count = next(7);
      return {...day, workWindows: count ? [['10:00',formatTime(600 + 30 * count)]] : []};
    });
    const tasks = Array.from({length:1 + next(4)}, (_, i) => {
      const targetDay = next(days.length);
      const hardDay = targetDay + next(days.length - targetDay);
      return task(String(i), next(5) / 2, targetDay, {hardDay, earliestDay:next(hardDay + 1),
        flexible: hardDay > targetDay, canRequestExtension: !!next(3), allowDrop: !!next(3), reduceBy: next(3) / 2});
    });
    return {tasks, days};
  });
}
test('T8 strict superset pruning and T12 re-evaluation across 200 generated task sets', () => {
  for (const {tasks, days} of [demoData(), demoData(true), ...instances()]) {
    const base = evaluate(tasks, days);
    const repairs = findRepairs(tasks, days);
    for (const repair of repairs) {
      assert.ok(repair.test.typical.feasible);
      assert.ok(rank[repair.test.verdict] > rank[base.verdict]);
      assert.deepEqual(repair.test, evaluate(repair.updated, days));
      assert.deepEqual(repair.updated, repair.actions.reduce((list, action) => applyAction(list, action, {approved:true}), tasks));
      for (const other of repairs) {
        assert.ok(!(repair.actions.length > other.actions.length &&
          other.actions.every(a => repair.actions.some(b => a.id === b.id)) &&
          rank[other.test.verdict] >= rank[repair.test.verdict]));
      }
    }
  }
});
test('T9 explicit approval gates a fixed deadline', () => {
  const {tasks, days} = demoData(true);
  const repair = findRepairs(tasks, days).find(r => r.needsApproval);
  assert.equal(tasks.find(t => t.id === 'poster').hardDay, 3);
  assert.equal(evaluate(tasks, days).verdict, 'infeasible');
  assert.throws(() => applyRepair(tasks, days, repair.id), /approval/);
  assert.throws(() => applyAction(tasks, {...repair.actions[0], needsApproval:false}), /approval/);
  const updated = applyRepair(tasks, days, repair.id, {approvedActionIds:repair.actions.map(a => a.id)});
  assert.equal(updated.find(t => t.id === 'poster').hardDay, 4);
  assert.equal(evaluate(updated, days).verdict, 'at-risk');
});
test('T10 golden sleep windows and 200 generated sleep/work configurations', () => {
  const day = {date:'2026-11-16', busyWindows:[]};
  for (const [window,sleep,count] of [
    [['21:00','23:30'],undefined,4],[['05:00','08:00'],undefined,2],
    [['22:00','23:30'],{start:'00:00',end:'08:00'},3]
  ]) assert.equal(makeSlots([{...day,workWindows:[window]}], sleep).length,count);
  const next = random(42);
  for (let i = 0; i < 200; i++) {
    const from = next(48), to = next(48);
    const workStart = next(48), workEnd = workStart + 1 + next(48 - workStart);
    const sleep = {start:formatTime(from * 30), end:formatTime(to * 30)};
    const days = [{...day,workWindows:[[formatTime(workStart * 30),formatTime(workEnd * 30)]]}];
    const alloc = schedule([task('long',24,0)], days, {sleep}).alloc;
    const blocked = slot => from < to ? slot >= from && slot < to : from > to && (slot >= from || slot < to);
    assert.deepEqual(alloc.map(a => a.start / 30),
      Array.from({length:workEnd - workStart}, (_, j) => workStart + j).filter(j => !blocked(j)));
  }
});
test('T11 EDF matches an exhaustive assignment oracle', () => {
  for (const {tasks, days} of instances()) {
    const slots = makeSlots(days);
    const remaining = tasks.map(t => t.likely * 2);
    function search(index) {
      if (remaining.every(n => n === 0)) return true;
      if (remaining.reduce((sum,n) => sum+n,0) > slots.length - index) return false;
      const day = slots[index].dayIndex;
      if (tasks.some((t,i) => remaining[i] && t.targetDay < day)) return false;
      for (let i = 0; i < tasks.length; i++) {
        if (!remaining[i] || tasks[i].earliestDay > day) continue;
        remaining[i]--;
        const found = search(index + 1);
        remaining[i]++;
        if (found) return true;
      }
      return search(index + 1);
    }
    assert.equal(schedule(tasks, days).feasible, search(0));
  }
});
test('T13 inputs are unchanged and outputs deterministic, including lexical ordering', () => {
  const {tasks, days} = demoData(true);
  const original = structuredClone({tasks, days});
  const a = evaluate(tasks, days);
  const repairs = findRepairs(tasks, days);
  for (const repair of repairs) draftApprovalRequest(repair, days);
  assert.deepEqual({tasks, days},original);
  assert.deepEqual(a,evaluate(tasks,days));
  assert.deepEqual(repairs,findRepairs(tasks,days));
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate([],days))), evaluate([],days));
  assert.equal(schedule([task('a',1,0),task('Z',1,0)],days).alloc[0].taskId,'Z');
});
test('T14 research sweep uses typical misses', () => {
  for (const [i, {tasks, days}] of sweep.entries()) {
    const result = evaluate(tasks, days);
    assert.equal(result.verdict,'infeasible');
    assert.equal(result.typical.deadlineMargins.find(m => m.dayIndex === 3).margin, (3 - hours[i]) * 60);
  }
});
test('T15 verdict wording uses real binding demand, capacity and shortfall', () => {
  for (const [i, {tasks, days}] of sweep.entries()) {
    const result = evaluate(tasks, days);
    const headline = verdictText(result, days);
    assert.doesNotMatch(headline,/fits|almost no room/i);
    assert.ok(headline.includes(`Thursday (2026-11-19) has ${10 + hours[i]}h of work due and 13h available. Short by ${hours[i] - 3}h.`));
  }
  const {tasks,days} = demoData();
  for (const {test: evaluation} of findRepairs(tasks, days)) {
    assert.ok(evaluation.typical.feasible);
    assert.match(verdictText(evaluation, days),/fits/);
  }
  const noResearch = tasks.filter(t => t.id !== 'research');
  const d = evaluate(noResearch, days);
  assert.equal(d.verdict,'feasible');
  assert.deepEqual(d.typical.deadlineMargins.map(m => m.margin / 60),[3,3,7]);
  assert.deepEqual(findRepairs(noResearch,days),[]);
  const fixed = demoData(true);
  const f = fixed.tasks.map(t => ({...t, allowDrop:false, canRequestExtension:false}));
  assert.equal(evaluate(f,fixed.days).verdict,'infeasible');
  assert.deepEqual(findRepairs(f,fixed.days),[]);
  assert.match(emptyRepairMessage('infeasible'),/No verified fix/);
});
test('T20 scope reduction simulation, approval, floor and explicit request', () => {
  const days = demoData().days.slice(0,1);
  const tasks = [task('report',5,0,{min:1,max:5,reduceBy:2,reductionNeedsApproval:true})];
  const [repair] = findRepairs(tasks,days);
  assert.equal(repair.needsApproval,true);
  assert.deepEqual(['min','likely','max'].map(k => repair.updated[0][k]),[0,3,3]);
  assert.equal(repair.score,200);
  assert.throws(() => applyRepair(tasks,days,repair.id),/approval/);
  assert.match(draftApprovalRequest(repair,days), /current scope stays.*until we agree/);
  assert.equal(findRepairs([ {...tasks[0], reductionNeedsApproval:false} ],days)[0].needsApproval,false);
});
