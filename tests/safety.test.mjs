// Safety and privacy rules from SPEC.txt section 13 (see docs/QA_CHECKLIST.md).
// Each test names the rule it covers (S1-S5 safety, P1-P5 privacy, E1-E2 engineering).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { demoData } from '../src/engine/demo-data.mjs';
import { evaluate } from '../src/engine/evaluate.mjs';
import { parseIcs } from '../src/engine/importers.mjs';
import { applyAction, draftApprovalRequest, findRepairs } from '../src/engine/repairs.mjs';
import { getActiveTasks, makeInitialState, reduceState } from '../src/ui/state.mjs';
import { STORAGE_KEY, loadState } from '../src/ui/storage.mjs';

const root = new URL('..', import.meta.url).pathname;
const NOW = () => '2026-11-19T12:00:00+05:30';
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const inSleep = (start, sleep) => {
  const s = minutes(sleep.start), e = minutes(sleep.end);
  return s > e ? (start >= s || start < e) : (start >= s && start < e);
};
const allAllocs = evaluation => ['optimistic', 'typical', 'conservative'].flatMap(level => evaluation[level].alloc);
async function sources(dir, ext = /\.(mjs|js|html|css)$/) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path, ext));
    else if (ext.test(entry.name)) out.push({ path, text: await readFile(join(root, path), 'utf8') });
  }
  return out;
}
const reduce = (state, ...actions) => actions.reduce((s, action) => reduceState(s, action, NOW), state);

test('S1 no verified repair places work in the protected sleep window, for any sleep window', () => {
  const sleeps = [{ start: '23:00', end: '07:00' }, { start: '00:00', end: '08:00' }, { start: '17:30', end: '18:30' }];
  for (const fixed of [false, true]) {
    for (const sleep of sleeps) {
      const { tasks, days } = demoData(fixed);
      const base = evaluate(tasks, days, { sleep });
      for (const alloc of allAllocs(base)) assert.ok(!inSleep(alloc.start, sleep), `base alloc ${alloc.label} in sleep`);
      for (const repair of findRepairs(tasks, days, { sleep })) {
        assert.ok(repair.actions.every(action => ['move', 'drop', 'reduce', 'extend'].includes(action.type)),
          'repairs only change tasks, never the sleep window');
        for (const alloc of allAllocs(repair.test)) {
          assert.ok(!inSleep(alloc.start, sleep), `${repair.id}: ${alloc.label} inside ${sleep.start}-${sleep.end}`);
        }
      }
    }
  }
});

test('S1 the sleep window changes only through Settings (SAVE_SETTINGS)', () => {
  let state = makeInitialState({ fixed: false });
  const sleep = state.sleep;
  const repairId = findRepairs(getActiveTasks(state), state.days, { sleep })[0].id;
  state = reduce(state,
    { type: 'APPLY_REPAIR', repairId },
    { type: 'UNDO_LAST_REPAIR' },
    { type: 'ADD_PROPOSAL', fields: { title: 'Extra', likely: 6, deadline: '2026-11-19' } });
  state = reduce(state, { type: 'ACCEPT_PROPOSAL', proposalId: state.proposals[0].id, mode: 'override' });
  state = reduce(state, { type: 'RECORD_SLEEP_REPORT', date: '2026-11-19', hoursSlept: 4 });
  assert.deepEqual(state.sleep, sleep, 'repairs, overrides and sleep reports leave the protected window alone');
});

test('S2 approval-dependent changes never reach the evaluated plan before explicit approval', () => {
  const { tasks, days } = demoData(true);
  const extend = findRepairs(tasks, days).find(repair => repair.needsApproval);
  assert.ok(extend, 'scenario B offers an approval-gated extension');
  assert.throws(() => applyAction(tasks, extend.actions[0]), /approval/i);
  assert.throws(() => applyAction(tasks, { ...extend.actions[0], needsApproval: false }), /approval/i,
    'a falsified needsApproval flag is still rejected');

  let state = makeInitialState({ fixed: true });
  const poster = s => s.tasks.find(task => task.id === 'poster');
  assert.throws(() => reduce(state, { type: 'APPLY_REPAIR', repairId: extend.id }), /approval/i);
  state = reduce(state, { type: 'SELECT_REPAIR', repairId: extend.id });
  assert.equal(poster(state).hardDay, 3, 'preview does not change the plan');
  state = reduce(state, { type: 'SET_APPROVAL_STATUS', repairId: extend.id, status: 'declined' });
  assert.throws(() => reduce(state, { type: 'APPLY_REPAIR', repairId: extend.id }), /approval/i);
  state = reduce(state, { type: 'SET_APPROVAL_STATUS', repairId: extend.id, status: 'approved' });
  assert.equal(poster(state).hardDay, 3, 'recording approval alone does not apply it');
  assert.equal(evaluate(getActiveTasks(state), state.days).verdict, 'infeasible');
  state = reduce(state, { type: 'APPLY_REPAIR', repairId: extend.id });
  assert.equal(poster(state).hardDay, 4, 'explicit apply after approval changes the plan');
});

test('S2/P4 request drafts are plain text and include workload numbers only on opt-in', () => {
  const { tasks, days } = demoData(true);
  const repair = findRepairs(tasks, days).find(item => item.needsApproval);
  const plain = draftApprovalRequest(repair, days);
  assert.match(plain, /stays in effect until you approve/);
  assert.doesNotMatch(plain, /available|short by|work due|DBMS|ML Assignment|French|Research/i,
    'without opt-in, no workload or other-task details are disclosed');
  const withWorkload = draftApprovalRequest(repair, days, { includeWorkload: true });
  assert.match(withWorkload, /Plan after the proposed change/);
  assert.doesNotMatch(plain + withWorkload, /<[a-z]/i, 'no markup');
});

test('S3 no copy claims a plan guarantees sleep or lower stress', async () => {
  for (const { path, text } of [...await sources('src'), { path: 'index.html', text: await readFile(join(root, 'index.html'), 'utf8') }]) {
    for (const match of text.matchAll(/guarantee/gi)) {
      const context = text.slice(Math.max(0, match.index - 40), match.index + 20);
      assert.match(context, /(can't|can\\'t|cannot|never|not a|not) guarantee/i, `${path}: "...${context}..."`);
    }
  }
});

test('S4 no streaks, leaderboards, badges-as-rewards, countdowns or sleep guilt in user-facing copy', async () => {
  const files = [...await sources('src/ui'), { path: 'index.html', text: await readFile(join(root, 'index.html'), 'utf8') }];
  const literals = files.flatMap(({ path, text }) =>
    [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|>([^<>{}\n]+)</g)].map(m => ({ path, copy: m[1] ?? m[2] ?? m[3] ?? m[4] })));
  const banned = /\b(streak|leaderboard|you should sleep|sleep more|you failed|hurry|only \d+ (hours|days) left|points earned|level up)\b/i;
  const allowedNegation = /\bno (scores, )?streaks\b/i;
  for (const { path, copy } of literals) {
    if (banned.test(copy) && !allowedNegation.test(copy)) assert.fail(`${path}: "${copy}"`);
  }
});

test('S4 at most one sleep report per morning; skipping is recorded without consequence', () => {
  let state = makeInitialState({ fixed: false });
  state = reduce(state,
    { type: 'RECORD_SLEEP_REPORT', date: '2026-11-19', hoursSlept: 6 },
    { type: 'RECORD_SLEEP_REPORT', date: '2026-11-19', hoursSlept: 7.5, stress: 2 });
  assert.equal(state.feedback.sleepReports.length, 1, 'a second entry for the same morning replaces the first');
  assert.equal(state.feedback.sleepReports[0].hoursSlept, 7.5);
  const skipped = reduce(makeInitialState({ fixed: false }), { type: 'SKIP_SLEEP_PROMPT', date: '2026-11-19' });
  assert.equal(skipped.skippedSleepPromptDate, '2026-11-19');
  assert.deepEqual(skipped.feedback, makeInitialState({ fixed: false }).feedback, 'skip stores no report and no penalty');
});

test('S5 Accept anyway is always allowed and leaves the conflict visible', () => {
  let state = makeInitialState({ fixed: false });
  state = reduce(state, { type: 'ADD_PROPOSAL', fields: { title: 'Huge', likely: 20, deadline: '2026-11-17' } });
  state = reduce(state, { type: 'ACCEPT_PROPOSAL', proposalId: state.proposals[0].id, mode: 'override' });
  assert.ok(state.tasks.some(task => task.title === 'Huge' && !task.isProposal), 'override joins the plan');
  assert.equal(state.unresolvedConflict, true, 'conflict stays flagged');
  assert.equal(evaluate(getActiveTasks(state), state.days).verdict, 'infeasible', 'verdict still says infeasible');
});

test('P1 no network APIs or external URLs in the shipped page and modules', async () => {
  const shipped = [...await sources('src'), { path: 'index.html', text: await readFile(join(root, 'index.html'), 'utf8') }];
  const network = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource|importScripts|navigator\.serviceWorker|mailto:/;
  const externalUrl = /(?:src|href|url\()\s*=?\s*["'(]?\s*(?:https?:)?\/\//i;
  for (const { path, text } of shipped) {
    assert.doesNotMatch(text, network, `${path} uses a network API`);
    assert.doesNotMatch(text, externalUrl, `${path} references an external resource`);
  }
});

test('P1/E2 saved data uses a versioned key and a bad or old snapshot never crashes', () => {
  assert.equal(STORAGE_KEY, 'the25thhour.v1');
  const store = value => ({ getItem: key => (key === STORAGE_KEY ? value : null) });
  for (const raw of ['{not json', JSON.stringify({ schemaVersion: 0 }), JSON.stringify({ schemaVersion: 2, tasks: [] }), '[]']) {
    const loaded = loadState(store(raw));
    assert.equal(loaded.state, null);
    assert.match(loaded.warning, /fresh plan/i, 'the student is told');
  }
  assert.deepEqual(loadState({ getItem() { throw Error('blocked'); } }).state, null);
});

test('P2 Clear all my data removes tasks, feedback and sleep reports', () => {
  let state = makeInitialState({ fixed: false });
  state = reduce(state, { type: 'RECORD_SLEEP_REPORT', date: '2026-11-19', hoursSlept: 6 }, { type: 'CLEAR_ALL' });
  assert.deepEqual(state.feedback, { tasks: [], sleepReports: [] });
  assert.deepEqual(state.appliedChanges, []);
  assert.deepEqual(state.pendingApprovals, []);
});

test('P3 imported calendar events keep times only, never titles', async () => {
  const text = await readFile(join(root, 'tests/fixtures/calendar.ics'), 'utf8');
  const { data } = parseIcs(text, demoData().days);
  assert.ok(data.length > 0);
  for (const event of data) assert.deepEqual(Object.keys(event).sort(), ['date', 'end', 'index', 'start']);
  let state = makeInitialState({ fixed: false });
  state = reduce(state, { type: 'IMPORT_ICS', text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261117T170000\nDTEND:20261117T173000\nSUMMARY:Private therapy session\nEND:VEVENT\nEND:VCALENDAR', size: 120 });
  assert.doesNotMatch(JSON.stringify(state), /therapy/i, 'the event title is not kept in state');
});

test('P5 the first-run notice is visible on every screen from first load', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /This is a planning tool, not medical advice, and not a treatment for sleep or anxiety problems\./);
  assert.match(html, /<footer[\s\S]*not medical advice[\s\S]*<\/footer>/);
});

test('E1 engine stays pure: no clock, randomness, locale, DOM, storage or network', async () => {
  const banned = [/Date\.now/, /new Date\(\s*\)/, /Math\.random/, /localeCompare/, /toLocale\w*String/, /\bIntl\./,
    /\bdocument\./, /\bwindow\.(?!length\b)/, /globalThis/, /localStorage/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bimport\s*\(/];
  for (const { path, text } of await sources('src/engine', /\.mjs$/)) {
    for (const pattern of banned) assert.doesNotMatch(text, pattern, `${path} matches ${pattern}`);
  }
});
