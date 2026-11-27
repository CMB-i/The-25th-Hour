import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveView, makeInitialState, reduceState } from '../src/ui/state.mjs';
import { extractBusyLabels, labelInfo } from '../src/ui/ics-labels.mjs';
import { buildAgenda, dayFreeTime } from '../src/ui/week-model.mjs';
import { buildHero, buildWeekStrip, freeThisWeek } from '../src/ui/home-model.mjs';
import { setNowProvider } from '../src/ui/clock.mjs';
setNowProvider('2026-11-23T08:00:00+05:30');

// Synthetic timetable (not anyone's real one): weekly classes with names and rooms, one without a SUMMARY,
// times that are not on the half hour, folded lines and escaped commas.
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Kolkata:20261123T114000', 'DTEND;TZID=Asia/Kolkata:20261123T123000', 'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:AB101 Intro to\\, well', '  folded names', 'LOCATION:ELT 3', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Kolkata:20261123T124000', 'DTEND;TZID=Asia/Kolkata:20261123T133000', 'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:AB102 Second class', 'LOCATION:ECR 1', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Kolkata:20261124T090000', 'DTEND;TZID=Asia/Kolkata:20261124T100000', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');
const NOW = '2026-11-23T08:00:00+05:30';
const win = [['09:00', '21:00']];

function planWithCalendar() {
  let state = makeInitialState({ demo: false, nowIso: NOW });
  state = reduceState(state, { type: 'SAVE_SETTINGS', weeklyWorkWindows: [[], win, win, win, win, win, [], []] });
  return reduceState(state, { type: 'IMPORT_ICS', text: ICS, fileSize: ICS.length });
}

test('imported blocks keep class name and room; stored block shape is unchanged', () => {
  const state = planWithCalendar();
  assert.deepEqual(state.days[0].busyWindows, [['11:30', '12:30'], ['12:30', '13:30']]);
  const labels = state.busyLabels;
  const first = labelInfo(labels['2026-11-23|11:30|12:30']);
  assert.equal(first.title, 'AB101 Intro to, well folded names');
  assert.equal(first.room, 'ELT 3');
  assert.equal(first.from, '11:40');
  assert.equal(labelInfo(labels['2026-11-23|12:30|13:30']).room, 'ECR 1');
  assert.equal(labelInfo(labels['2026-11-30|11:30|12:30']).title, 'AB101 Intro to, well folded names', 'recurrences too');
});

test('no summary falls back to "Busy" and an old string label still reads', () => {
  assert.equal(labelInfo(undefined).title, 'Busy');
  assert.equal(labelInfo('Lab').title, 'Lab');
  assert.equal(labelInfo({ title: '', room: '' }).title, 'Busy');
  const labels = extractBusyLabels(ICS, planWithCalendar().days);
  assert.equal(labels['2026-11-24|09:00|10:00'], undefined, 'an unnamed event gets no label, so the UI shows "Busy"');
});

test('import summary has no stray text and the count is exact', () => {
  const state = planWithCalendar();
  assert.equal(state.lastImportReport.summary, 'Imported 7 busy window(s).');
  assert.doesNotMatch(state.notice, /null/);
});

test('free hours per day = work window - busy - sleep - planned, and match the engine capacity', () => {
  const state = planWithCalendar();
  const derived = deriveView(state);
  const agenda = buildAgenda({ state, derived });
  for (const day of agenda) {
    const f = day.free;
    assert.equal(f.freeMinutes, f.windowMinutes - f.busyMinutes - f.sleepMinutes - f.plannedMinutes, day.weekday);
    const engine = derived.evaluation.typical.byDay.find(entry => entry.index === day.index);
    assert.equal(f.openMinutes, engine?.capacity ?? 0, `${day.weekday} open time is the engine's capacity`);
    assert.equal(f.bands.reduce((sum, band) => sum + band.end - band.start, 0), f.freeMinutes);
  }
  const monday = agenda[0];
  assert.equal(monday.free.windowMinutes, 720);
  assert.equal(monday.free.busyMinutes, 120, 'two rounded one-hour classes');
  assert.equal(monday.freeHours, 10);
  const tuesday = agenda[1];
  assert.equal(tuesday.freeHours, 11, 'days differ when their classes differ');
});

test('sleep inside the work window is counted as sleep, not as busy', () => {
  const day = { date: '2026-11-23', workWindows: [['20:00', '24:00']], busyWindows: [['20:00', '21:00']] };
  const free = dayFreeTime({ day, sleep: { start: '23:00', end: '07:00' }, assigned: [] });
  assert.equal(free.busyMinutes, 60);
  assert.equal(free.sleepMinutes, 60);
  assert.equal(free.freeMinutes, 120);
});

test('Home headline follows real free time, never "wide open" over a full week', () => {
  const state = planWithCalendar();
  const now = new Date('2026-11-23T08:00:00+05:30');
  const hero = buildHero({ state, derived: deriveView(state), now });
  assert.match(hero.title, /wide open/, 'light timetable, long work hours: most time is free');
  // Fill the week with busy blocks.
  let busy = state;
  for (let i = 1; i <= 5; i++) busy = reduceState(busy, { type: 'ADD_BUSY_BLOCK', dayIndex: i, start: '09:00', end: '20:00', label: 'Shift' });
  const full = buildHero({ state: busy, derived: deriveView(busy), now });
  assert.doesNotMatch(full.title, /wide open/);
  assert.match(full.title, /\d+(\.\d)?h free|full/);
  const noHours = makeInitialState({ demo: false, nowIso: NOW });
  const blank = buildHero({ state: noHours, derived: deriveView(noHours), now });
  assert.equal(blank.kind, 'nohours');
  assert.equal(blank.link, 'Set my work hours');
  assert.doesNotMatch(blank.title, /wide open/);
});

test('week strip shows each day\'s real free hours', () => {
  const state = planWithCalendar();
  const strip = buildWeekStrip({ state, derived: deriveView(state), now: new Date('2026-11-23T08:00:00+05:30') });
  assert.deepEqual(strip.cols.slice(0, 3).map(col => col.freeHours), [10, 11, 12]);
  assert.match(strip.label, /Monday 10h free, Tuesday 11h free/);
  const { freeMinutes } = freeThisWeek({ state, derived: deriveView(state), now: new Date('2026-11-23T08:00:00+05:30') });
  assert.equal(freeMinutes / 60, 10 + 11 + 12 * 3);
});

test('a weekly busy block repeats through the loaded weeks, with its name on every copy', () => {
  let state = makeInitialState({ demo: false, nowIso: NOW });
  state = reduceState(state, { type: 'ADD_BUSY_BLOCK', dayIndex: 2, start: '18:00', end: '19:00', label: 'Choir', repeatWeekly: true });
  const hits = state.days.map((day, i) => [i, day.busyWindows]).filter(([, w]) => w.length);
  assert.deepEqual(hits.map(([i]) => i), [2, 9, 16, 23, 30], 'every Wednesday from the chosen day on');
  assert.ok(hits.every(([, w]) => w.length === 1 && w[0][0] === '18:00' && w[0][1] === '19:00'));
  assert.equal(labelInfo(state.busyLabels['2026-11-25|18:00|19:00']).title, 'Choir');
  assert.equal(labelInfo(state.busyLabels['2026-12-23|18:00|19:00']).title, 'Choir');
  const single = reduceState(makeInitialState({ demo: false, nowIso: NOW }), { type: 'ADD_BUSY_BLOCK', dayIndex: 2, start: '18:00', end: '19:00', label: 'Once' });
  assert.equal(single.days.filter(day => day.busyWindows.length).length, 1, 'without the checkbox it is one block');
});

test('a past day is not refused', () => {
  const state = reduceState(makeInitialState({ demo: false, nowIso: '2026-11-27T10:00:00+05:30' }), { type: 'ADD_BUSY_BLOCK', dayIndex: 0, start: '10:00', end: '11:00' });
  assert.deepEqual(state.days[0].busyWindows, [['10:00', '11:00']]);
});
