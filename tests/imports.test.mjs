import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoData } from '../src/engine/demo-data.mjs';
import { parseIcs, parsePastedTasks } from '../src/engine/importers.mjs';
import { createProposal, evaluateCommitments } from '../src/engine/commitments.mjs';
import { dayNumber, dateAt } from '../src/engine/dates.mjs';
import { schedule } from '../src/engine/scheduler.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}.ics`,import.meta.url), 'utf8');
test('T16 pasted tasks map all tags, report physical lines and deconflict IDs', () => {
  const {days} = demoData();
  const input = [
    'Report | 3h | 2026-11-18 | flexible | 2026-11-20', '',
    'Report | 2h | 2026-11-19 | flexible',
    'Club | 1h | 2026-11-19 | droppable',
    'Lab | 2h | 2026-11-20',
    'A | 0.3h | 2026-11-19', 'B | 1h | 2026-11-31',
    'C | 1h | 2026-11-19 | invalid',
    'D | 1h | 2026-11-19 | flexible | 2026-11-18'
  ].join('\n');
  const {data,warnings} = parsePastedTasks(input,days,{existingIds:['import-1-report']});
  assert.deepEqual(data.map(t => [t.id,t.priority,t.flexible,t.allowDrop,t.hardDay,t.min,t.max]), [
    ['import-1-report:2',2,true,false,4,2.5,4],['import-3-report',2,true,false,4,1.5,3],
    ['import-4-club',2,false,true,3,1,1.5],['import-5-lab',1,false,false,4,1.5,3]
  ]);
  assert.deepEqual(warnings.map(message => message.match(/^Line \d+/)?.[0]),['Line 6','Line 7','Line 8','Line 9']);
  assert.deepEqual(parsePastedTasks(null,days).data,[]);
});
test('T17 calendar imports valid windows and warns about each skipped case', () => {
  const {days,tasks} = demoData();
  const {data,warnings} = parseIcs(fixture('calendar'),days);
  assert.deepEqual(data,[
    {index:0,date:'2026-11-16',start:'16:30',end:'17:30'},
    {index:1,date:'2026-11-17',start:'17:00',end:'18:00'},
    {index:2,date:'2026-11-18',start:'09:00',end:'10:00'}
  ]);
  for (const message of [/All-day/,/Unsupported time zone/,/Cross-midnight/,/Invalid event duration/,/Missing event/,/Unsupported recurrence/,/1 events outside/]) {
    assert.ok(warnings.some(text => message.test(text)),String(message));
  }
  assert.equal(warnings.filter(text => text.includes('Invalid event duration')).length,2);
  for (const event of data) days[event.index].busyWindows.push([event.start,event.end]);
  assert.equal(schedule(tasks,days).capacityMinutes,18*60);
  assert.deepEqual(parseIcs(null,days).data,[]);
  assert.match(parseIcs('BEGIN:VEVENT\nEND:VEVENT\n'.repeat(2001),days).warnings[0],/2,000/);
});
test('T17 weekly recurrence expands BYDAY, UNTIL, COUNT, INTERVAL and EXDATE', () => {
  const days = Array.from({length:35},(_,i) => ({date:dateAt(dayNumber('2026-11-16') + i)}));
  const {data,warnings} = parseIcs(fixture('weekly'),days);
  assert.deepEqual(warnings,[]);
  assert.deepEqual(data.map(e => e.date),[
    '2026-11-16','2026-12-02','2026-12-14','2026-11-17','2026-12-01',
    '2026-11-19','2026-11-26','2026-12-03','2026-12-10','2026-12-17'
  ]);
  assert.ok(data.filter(e => e.date === '2026-12-01').every(e => e.start === '17:00'));
  assert.deepEqual(parseIcs(fixture('weekly'),days.slice(14)).data.map(e => e.date),data.filter(e => e.index >= 14).map(e => e.date));
});
test('T18 scheduler and commitment validation give descriptive errors', () => {
  const {tasks,days} = demoData();
  for (const [override,message] of [
    [{id:''},/ID and title/],[{title:' '},/ID and title/],[{targetDay:0.5},/deadline/],
    [{targetDay:-1},/deadline/],[{targetDay:2},/deadline/],[{hardDay:5},/deadline/],
    [{earliestDay:2},/earliest/],[{earliestDay:-1},/earliest/],[{earliestDay:0.5},/earliest/],
    [{min:8},/range/],[{min:-1},/non-negative/],[{likely:4.1},/half-hour/],[{max:3},/range/],
    [{splittable:false},/Uninterrupted/],[{priority:3},/priority/],[{type:'bad'},/type/]
  ]) assert.throws(() => schedule([{...tasks[0],...override}],days),message);
  assert.throws(() => schedule([tasks[0],tasks[0]],days),/Duplicate/);
  assert.throws(() => schedule(tasks,[{...days[0],workWindows:[['17:01','18:00']]},...days.slice(1)]),/half-hour aligned/);
  assert.throws(() => schedule(tasks,[{...days[0],workWindows:[['18:00','17:00']]},...days.slice(1)]),/same-day/);
  assert.throws(() => schedule(tasks,days,{sleep:{start:'xx',end:'08:00'}}),/Invalid time/);
  assert.throws(() => schedule(tasks,days,{estimate:'toString'}),/estimate/);
  const fields = {title:'New project',likely:5,deadline:'2026-11-19'};
  for (const [change,message] of [
    [{title:'x'.repeat(81)},/Name/],[{likely:0},/Typical/],[{likely:40.5},/Typical/],
    [{min:6},/range/],[{max:4},/range/],[{deadline:'2026-02-30'},/Deadline/],
    [{latestDate:'2026-11-20'},/flexible/],[{earliestDate:'2026-11-20'},/Earliest/],
    [{tag:'unknown'},/priority/]
  ]) assert.throws(() => createProposal({...fields,...change},days),message);
  assert.throws(() => createProposal(fields,days,{notBeforeDate:'2026-11-20'}),/passed/);
  const proposal = createProposal({...fields,tag:'flexible'},days);
  assert.deepEqual([proposal.min,proposal.max,proposal.targetDay,proposal.hardDay], [4,7,3,4]);
  const last = createProposal({...fields,deadline:'2026-11-20',tag:'flexible'},days);
  assert.equal(last.targetDay,last.hardDay);
});
test('Commitment comparison retains proposals outside the plan and evaluates them together', () => {
  const {tasks,days} = demoData();
  const plan = tasks.filter(t => t.id !== 'research');
  const first = createProposal({title:'Research',likely:5,deadline:'2026-11-19',tag:'droppable'},days);
  const second = createProposal({title:'Meeting preparation',likely:1,deadline:'2026-11-19'},days,{existingTasks:[first]});
  const before = structuredClone({plan,first,second});
  const {before: initial, separate, together} = evaluateCommitments(plan,[first,second],days);
  assert.equal(initial.evaluation.verdict,'feasible');
  assert.equal(separate[0].evaluation.verdict,'infeasible');
  assert.equal(separate[1].evaluation.verdict,'feasible');
  const {date,requiredHours,availableHours,shortfallHours} = together.cost;
  assert.deepEqual([date,requiredHours,availableHours,shortfallHours],['2026-11-19',16,13,3]);
  assert.ok(together.cost.tasks.some(t => t.id === second.id));
  assert.ok(separate[0].repairs.some(r => r.id === `drop:${first.id}`));
  assert.deepEqual({plan,first,second},before);
});
