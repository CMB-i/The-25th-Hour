import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEstimateProfiles, campusDate, getEstimateSuggestion, sevenDayReview, updateEstimateProfile } from '../src/engine/feedback.mjs';
import { plannedSleepMinutes } from '../src/engine/capacity.mjs';
import { demoData } from '../src/engine/demo-data.mjs';

test('T19 estimate learning, sample gate, smoothing, rounding and clamps', () => {
  const input = {type:'problem_set',estimatedLikely:4,actualHours:6};
  const original = {...input};
  let profile;
  for (const [i,ratio] of [1.2,1.32,1.392].entries()) {
    const previous = profile && {...profile};
    const updated = updateEstimateProfile(profile,input);
    assert.deepEqual(profile,previous);
    profile = updated;
    assert.equal(profile.samples,i+1);
    assert.ok(Math.abs(profile.ratio-ratio)<1e-12);
    assert.equal(getEstimateSuggestion(profile,4),i < 2 ? null : 5.5);
  }
  assert.deepEqual(input,original);
  assert.equal(updateEstimateProfile(profile,{...input,actualHours:100}).ratio,3);
  assert.equal(updateEstimateProfile({...profile,ratio:0.5},{...input,actualHours:0}).ratio,0.5);
  assert.throws(() => updateEstimateProfile(null,{...input,estimatedLikely:0}),/positive/);
  assert.equal(buildEstimateProfiles([input]).length,7);
});

test('seven-day review joins deadline outcomes, applied changes and voluntary sleep reports', () => {
  const {tasks,days,sleep} = demoData();
  const feedback = [
    {taskId:'poster',type:'club',estimatedLikely:3,actualHours:4,recordedAt:'2026-11-19T19:00:00Z'},
    {taskId:'ml',type:'other',estimatedLikely:3,actualHours:3,recordedAt:'2026-11-19T20:00'},
    {taskId:'dbms',type:'lab',estimatedLikely:4,actualHours:5,recordedAt:'2026-11-13T20:00'}
  ];
  const sleepReports = [{date:'2026-11-19',hoursSlept:6.5,plannedSleepMinutes:plannedSleepMinutes(sleep)}];
  const result = sevenDayReview({feedback, tasks, days, sleepReports, throughDate:'2026-11-20',
    appliedChanges:[{recordedAt:'2026-11-17T19:00',labels:['Move poster'],approved:false}]});
  assert.equal(result.fromDate,'2026-11-14');
  assert.deepEqual(result.estimates.map(e => [e.date,e.metTarget,e.metHardDeadline]),
    [['2026-11-20',false,true],['2026-11-19',true,true]]);
  assert.equal(result.plannedDays,5);
  assert.equal(result.adjustments.length,1);
  assert.equal(result.reports[0].differenceHours,-1.5);
  assert.equal(result.averageSleepHours,6.5);
  assert.match(result.summary,/can't guarantee sleep/);
  assert.equal(campusDate('2026-02-30T12:00'),null);
});
