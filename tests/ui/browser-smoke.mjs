// Browser acceptance tests T21–T24 for the 5-screen static frontend.
// Drives a real Chrome/Chromium over the DevTools Protocol (no npm dependencies).
// Usage: start `python3 -m http.server 8000 --bind 127.0.0.1` at the repo root, then
//   node tests/ui/browser-smoke.mjs
// Env: CHROMIUM (browser executable), CHROMIUM_NO_SANDBOX=1, TEST_ORIGIN (default http://127.0.0.1:8000).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = (process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = process.env.CHROMIUM
  ?? (process.platform === 'darwin' && existsSync(MAC_CHROME) ? MAC_CHROME : 'google-chrome');
const STORAGE_KEY = 'the25thhour.v1';
const INJECTION = '<img src=x onerror=alert(1)>';

const profile = await mkdtemp(join(tmpdir(), '25th-hour-chrome-'));
const chrome = spawn(executable, [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run',
  '--no-default-browser-check', '--disable-dev-shm-usage', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  ...(process.env.CHROMIUM_NO_SANDBOX ? ['--no-sandbox'] : []),
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
// Keep the tail of Chrome's stderr so a failed launch is diagnosable in CI logs.
let chromeStderr = '';
chrome.stderr.on('data', chunk => { chromeStderr = (chromeStderr + chunk).slice(-4000); });
let chromeExit = null;
chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; });
chrome.once('error', failure => { chromeExit = { error: failure.message }; });
const LAUNCH_TIMEOUT_MS = Number(process.env.CHROMIUM_LAUNCH_TIMEOUT_MS ?? 60000);

const results = [];
let ws;

async function retry(run, attempts = 100, wait = 50) {
  let error;
  for (let i = 0; i < attempts; i++) {
    try { return await run(); } catch (failure) { error = failure; await delay(wait); }
  }
  throw error;
}

async function section(name, run) {
  const start = performance.now();
  await run();
  const ms = performance.now() - start;
  results.push({ name, ms });
  console.log(`PASS ${name} (${ms.toFixed(0)} ms)`);
}

try {
  // Cold Chrome starts on CI runners can take well over 10 s; wait up to LAUNCH_TIMEOUT_MS,
  // but stop at once (with Chrome's own error output) if the browser process exits.
  const launchStart = performance.now();
  let port;
  while (!port) {
    if (chromeExit) throw Error(`Chrome (${executable}) exited before DevTools was ready: ${JSON.stringify(chromeExit)}\n${chromeStderr}`);
    if (performance.now() - launchStart > LAUNCH_TIMEOUT_MS) {
      throw Error(`Chrome (${executable}) did not open DevTools within ${LAUNCH_TIMEOUT_MS} ms.\n${chromeStderr}`);
    }
    port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
      .then(contents => contents.split('\n')[0].trim())
      .catch(() => delay(100).then(() => undefined));
  }
  const targets = await retry(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    assert.ok(list.some(target => target.type === 'page'));
    return list;
  });
  const page = targets.find(target => target.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const pending = new Map();
  const errors = [];
  const failedLoads = [];
  const requests = [];
  const dialogs = [];
  let messageId = 0;
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails);
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args);
    if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(params.entry);
    if (method === 'Network.loadingFailed' && !params.canceled) failedLoads.push(params);
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.push(params.message);
      void command('Page.handleJavaScriptDialog', { accept: true });
    }
  });

  const js = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const execute = (fn, ...args) => js(`(${fn})(...${JSON.stringify(args)})`);
  const text = selector => execute(s => document.querySelector(s)?.textContent ?? '', selector);
  const contents = async (selector, expected) => retry(async () => assert.match(await text(selector), expected));
  const lacks = async (selector, unexpected) => assert.doesNotMatch(await text(selector), unexpected);
  const click = (selector, label) => execute((s, name) => {
    const list = [...document.querySelectorAll(s)];
    const target = name ? list.find(node => node.textContent.trim().includes(name)) : list[0];
    if (!target) throw Error(`Missing: ${name || s}`);
    if (target.disabled) throw Error(`Disabled: ${name || s}`);
    target.click();
  }, selector, label);
  const isDisabled = (selector, label) => execute((s, name) => {
    const target = [...document.querySelectorAll(s)].find(node => node.textContent.trim().includes(name));
    if (!target) throw Error(`Missing: ${name}`);
    return target.disabled;
  }, selector, label);
  const fill = (selector, values, submit = true) => execute((s, entries, doSubmit) => {
    const form = document.querySelector(s);
    if (!form) throw Error(`Missing form ${s}`);
    for (const [name, value] of Object.entries(entries)) {
      const input = form.elements.namedItem(name);
      if (!input) throw Error(`Missing field ${name} in ${s}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (doSubmit) form.requestSubmit();
  }, selector, values, submit);
  const upload = content => execute(value => {
    const files = new DataTransfer();
    files.items.add(new File([value], 'calendar.ics', { type: 'text/calendar' }));
    const input = document.querySelector('#calendar-file');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, content);
  const go = screen => click(`.nav-tab[data-screen="${screen}"]`);
  const persisted = () => js(`JSON.parse(localStorage.getItem('${STORAGE_KEY}'))`);
  const setStorage = mutate => execute((key, source) => {
    const saved = JSON.parse(localStorage.getItem(key));
    Function('saved', source)(saved);
    localStorage.setItem(key, JSON.stringify(saved));
  }, STORAGE_KEY, mutate);
  const ready = () => retry(async () => assert.ok((await js('document.querySelectorAll(".screen-panel:not([hidden]) .panel").length')) > 0));
  const reload = async () => {
    await command('Page.reload', { ignoreCache: true });
    await delay(200);
    await ready();
  };
  const noOverflow = async label => {
    const dims = await js('({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })');
    assert.ok(dims.scrollWidth <= dims.innerWidth, `Horizontal overflow on ${label}: ${dims.scrollWidth} > ${dims.innerWidth}`);
  };
  const key = async (keyName, code, vk, textValue) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, ...(textValue ? { text: textValue } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk });
  };
  const timedClick = (selector, label) => execute((s, name) => {
    const target = [...document.querySelectorAll(s)].find(node => !name || node.textContent.trim().includes(name));
    if (!target || target.disabled) throw Error(`Missing or disabled: ${name || s}`);
    const start = performance.now();
    target.click();
    return performance.now() - start;
  }, selector, label);

  await Promise.all(['Runtime', 'Page', 'Network', 'Log'].map(domain => command(`${domain}.enable`)));
  await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/` });
  await ready();
  await js(`localStorage.removeItem('${STORAGE_KEY}')`);
  await reload();

  // ---------------------------------------------------------------- T21
  await section('T21 interface states, both scenarios, B4/B6/B7/B9, keyboard, 360px', async () => {
    // Scenario A (flexible) — numbers come from the engine's binding deadline margin.
    await contents('#week-verdict', /INFEASIBLE/);
    await contents('#week-verdict', /Thursday \(2026-11-19\): 15h of work due, 13h available\. Short by 2h\./);
    await contents('#week-verdict', /Tasks due by Thursday: DBMS Lab \(4h\), ML Assignment \(3h\), AUV Club Poster \(3h\), New Research Project \(5h\)\./);
    await lacks('#week-verdict', /fits|almost no room/i);
    assert.equal(await js(`document.querySelector('#week-verdict').getAttribute('aria-live')`), 'polite');
    // B6 labels and weekly baseline (visible week only).
    await contents('#screen-week', /Weekly hours only \(simulated baseline\)/);
    await contents('#screen-week', /Deadline-aware scheduler \(same allocation, no repair step\)/);
    await contents('#screen-week', /18h of 20h available this week/);
    // B7 freshness: no calendar yet -> stale banner, separate timestamp text.
    await contents('#screen-week', /Your calendar may be out of date\. Re-import before relying on this\./);
    await contents('#screen-week', /No calendar imported yet/);
    await contents('#screen-week', /A feasible plan makes room to sleep; it can't guarantee sleep\./);
    assert.ok(await js(`document.querySelectorAll('.slot[aria-label]').length`) >= 40, 'timeline slots carry text alternatives');
    await noOverflow('My Week (Scenario A)');

    // Week navigation does not change edit timestamps.
    await click('#screen-week button', 'Next week');
    await contents('#screen-week', /Week 2 of 5/);
    await click('#screen-week button', 'Previous week');
    await contents('#screen-week', /Week 1 of 5/);

    // Rescue Engine, Scenario A: exactly two verified repairs, apply + undo.
    await go('rescue');
    await noOverflow('Make It Work (Scenario A)');
    assert.equal(await js(`document.querySelectorAll('#screen-rescue .repair-card').length`), 2);
    await contents('#screen-rescue .repair-card:nth-of-type(1)', /Move AUV Club Poster target to Friday.*Self-serve/s);
    await contents('#screen-rescue .repair-card:nth-of-type(2)', /Decline New Research Project.*Self-serve/s);
    await click('#screen-rescue .repair-card:nth-of-type(1) button', 'Apply');
    await contents('#screen-rescue .rescue-header', /AT RISK/);
    await click('#screen-rescue .rescue-header button', 'Undo last change');
    await contents('#screen-rescue .rescue-header', /INFEASIBLE/);

    // Scenario B (fixed): approval-gated extension never applies before explicit approval + apply.
    await click('#screen-rescue button', 'Scenario B (Fixed)');
    await contents('#screen-rescue .repair-card:nth-of-type(1)', /Decline New Research Project/);
    await contents('#screen-rescue .repair-card:nth-of-type(2)', /Request AUV Club Poster deadline on Friday.*Needs approval \(pending\)/s);
    await click('#screen-rescue .repair-card:nth-of-type(2) button', 'Preview');
    await contents('#screen-rescue .strategy-preview', /IF APPROVED/);
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await click('#screen-rescue .strategy-preview button', 'Copy approval request');
    await contents('#status-region', /Approval request copied/);
    assert.match(await js('navigator.clipboard.readText()'), /deadline.*2026-11-20/i);
    assert.equal(await isDisabled('#screen-rescue .strategy-preview button', 'Apply approved change'), true);
    await click('#screen-rescue .strategy-preview button', 'Mark declined');
    assert.equal(await isDisabled('#screen-rescue .strategy-preview button', 'Apply approved change'), true);
    await click('#screen-rescue .strategy-preview button', 'Mark approved');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').hardDay, 3, 'approval alone must not change the plan');
    await contents('#screen-rescue .rescue-header', /INFEASIBLE/);
    await click('#screen-rescue .strategy-preview button', 'Apply approved change');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').hardDay, 4);
    await contents('#screen-rescue .rescue-header', /AT RISK/);
    await noOverflow('Make It Work (Scenario B)');

    // B9: three distinct empty-repair messages.
    await go('week');
    await click('#screen-week .scenario-button', 'Flexible target');
    await execute(() => {
      const box = document.querySelector('#screen-week .research-box input[type=checkbox]');
      box.click();
    });
    await contents('#week-verdict', /FEASIBLE.*This fits your week\./s);
    await go('rescue');
    await contents('#screen-rescue', /No change needed/);
    await lacks('#screen-rescue', /No verified fix/);

    // No hard-coded Thursday: a Tuesday-binding plan names Tuesday with engine numbers.
    await setStorage(`saved.tasks = [{id:'tue',title:'Tuesday Quiz',min:10,likely:10,max:10,targetDay:1,hardDay:1,earliestDay:0,priority:1,flexible:false,allowDrop:false,splittable:true}];
      saved.proposals = []; saved.appliedChanges = []; saved.pendingApprovals = []; saved.feedback = {tasks:[],sleepReports:[]}; saved.screen = 'week';`);
    await reload();
    await contents('#week-verdict', /Tuesday \(2026-11-17\): 10h of work due, 7h available\. Short by 3h\./);
    await lacks('#week-verdict', /Thursday/);
    await go('rescue');
    await contents('#screen-rescue', /No verified fix with the changes you've allowed\. This is a capacity problem, not a scheduling problem\./);
    await lacks('#screen-rescue', /No change needed/);

    // At-risk with no improving repair.
    await setStorage(`saved.tasks = [{id:'tight',title:'Tight Lab',min:3.5,likely:3.5,max:3.5,targetDay:0,hardDay:0,earliestDay:0,priority:1,flexible:false,allowDrop:false,splittable:true}]; saved.screen = 'rescue';`);
    await reload();
    await contents('#screen-rescue', /No further verified change\. Keep your buffer\./);
    await go('week');
    await contents('#week-verdict', /AT RISK.*It fits, but there is almost no room for error\..*Monday \(2026-11-16\) has only 0\.5h to spare/s);

    // Fresh calendar import removes the stale banner and shows both timestamps.
    await go('settings');
    await upload('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261117T170000\nDTEND:20261117T173000\nSUMMARY:Seminar\nEND:VEVENT\nEND:VCALENDAR');
    await contents('#import-message', /Imported 1 busy window/);
    await go('week');
    await contents('#screen-week', /Based on your calendar from .*Last edited /s);
    await lacks('#screen-week', /may be out of date/);
    // A calendar older than 24h shows the stale banner again.
    await setStorage(`saved.calendarImportedAt = '2000-01-01T00:00:00.000Z';`);
    await reload();
    await contents('#screen-week', /may be out of date.*Based on your calendar from/s);

    // Keyboard: every visible control is tabbable; Tab reaches the skip link; Enter activates nav.
    await execute(() => {
      for (const control of document.querySelectorAll('a,button,input,select,textarea,summary')) {
        if (control.disabled || !control.getClientRects().length) continue;
        if (control.tabIndex < 0) throw Error(`Unreachable control: ${control.outerHTML.slice(0, 120)}`);
      }
      document.activeElement?.blur();
    });
    await key('Tab', 'Tab', 9);
    assert.equal(await js('document.activeElement.className'), 'skip-link');
    await execute(() => document.querySelector('.nav-tab[data-screen="check"]').focus());
    await key('Enter', 'Enter', 13, '\r');
    await contents('.nav-tab[aria-current="page"]', /Should I Say Yes\?/);
    await noOverflow('Should I Say Yes?');
    for (const screen of ['feedback', 'settings', 'week']) {
      await go(screen);
      await noOverflow(screen);
    }
  });

  // ---------------------------------------------------------------- T22
  await section('T22 persistence of tasks, settings, feedback, applied changes; clear all', async () => {
    await go('week');
    await click('#screen-week .scenario-button', 'Flexible target');
    // Applied change.
    await go('rescue');
    await click('#screen-rescue .repair-card:nth-of-type(1) button', 'Apply');
    // New tasks via Commitment Check (Accept anyway keeps conflict visible).
    await go('check');
    for (const name of ['One', 'Two', 'Three']) {
      await fill('#proposal-form', { title: `Problem set ${name}`, likely: '4', type: 'problem_set', deadline: '2026-11-27' });
      await contents('#proposals-results', /WITHOUT THIS COMMITMENT.*WITH THIS COMMITMENT.*PLAIN-LANGUAGE COST STATEMENT/s);
      assert.ok(!(await persisted()).tasks.some(task => task.title === `Problem set ${name}`), 'draft must not join plan before acceptance');
      await click('#proposals-results button', 'Accept anyway');
    }
    // Feedback: 3 problem sets (4h -> 6h) produce 1.392x ratio and optional 5.5h suggestion.
    await go('feedback');
    for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
      const taskId = (await persisted()).tasks.find(task => task.title === `Problem set ${name}`).id;
      await fill('#completion-form', { taskId, taskType: 'problem_set', actualHours: '6', recordedAt: `2026-11-${18 + i}T12:00` });
    }
    await fill('#sleep-form', { date: '2026-11-19', hours: '6.5', stress: '2' });
    await contents('#review', /Problem set One.*6\.5h slept.*1\.392× \(3 samples/s);

    // Learned suggestion on Screen 2 never silently overwrites typed input.
    await go('check');
    await fill('#proposal-form', { type: 'problem_set', likely: '4' }, false);
    await contents('#estimate-suggestion', /Use 5\.5h\?/);
    assert.equal(await js(`document.querySelector('#proposal-likely').value`), '4');
    await click('#estimate-suggestion button', 'Use 5.5h');
    assert.equal(await js(`document.querySelector('#proposal-likely').value`), '5.5');

    // Settings.
    await go('settings');
    await fill('#settings-form', { sleepStart: '22:30', sleepEnd: '07:00' });
    const saved = await persisted();
    assert.equal(saved.sleep.start, '22:30');
    assert.equal(saved.appliedChanges.length, 1);
    assert.equal(saved.feedback.tasks.length, 3);
    assert.equal(saved.feedback.sleepReports[0].plannedSleepMinutes, 480);

    await reload();
    assert.deepEqual(await persisted(), saved);
    await contents('#hero-sleep-pill', /22:30–07:00/);
    await go('feedback');
    await contents('#review', /Problem set One.*1\.392×.*6\.5h slept/s);
    await go('rescue');
    await contents('#screen-rescue .history-panel', /Move AUV Club Poster target to Friday/);

    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
    assert.ok(dialogs.some(message => /Clear/.test(message)), 'clear asks for confirmation');
    await contents('#screen-settings', /No imports run in this session yet|CURRENT PLAN TASKS/);
    await reload();
    assert.equal(await persisted(), null);
    await lacks('body', /Problem set One/);

    // Accept with suggested change + Undo round-trip.
    await go('week');
    await click('#screen-week .scenario-button', 'Flexible target');
    await execute(() => document.querySelector('#screen-week .research-box input[type=checkbox]').click());
    await go('check');
    await fill('#proposal-form', { title: 'Research replacement', likely: '5', deadline: '2026-11-19', tag: 'droppable' });
    await click('#proposals-results button', 'Accept with suggested change');
    const repaired = await persisted();
    assert.equal(repaired.tasks.find(task => task.id === 'poster').targetDay, 4);
    assert.equal(repaired.tasks.find(task => task.title === 'Research replacement').isProposal, false);
    await go('rescue');
    await click('#screen-rescue .rescue-header button', 'Undo last change');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').targetDay, 3);
    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
  });

  // ---------------------------------------------------------------- T23
  await section('T23 untrusted input as text, 1 MB limit, invalid input messages, no external requests', async () => {
    await go('settings');
    await fill('#paste-form', { tasks: `${INJECTION} | 1h | 2026-11-19 | droppable\nBad | 0.3h | 2026-11-19` });
    await contents('#import-message', /Added 1, skipped 1\..*Line 2: Hours must be positive/s);
    assert.ok((await text('#screen-settings')).includes(INJECTION), 'title rendered literally');
    await upload(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261116T160000\nDTEND:20261116T170000\nSUMMARY:${INJECTION}\nEND:VEVENT\nEND:VCALENDAR`);
    await contents('#import-message', /Imported 1 busy window/);
    assert.ok(!(await text('body')).includes('SUMMARY:'), 'event titles are not displayed or stored');
    assert.equal(await js('document.querySelectorAll("img").length'), 0, 'no injected elements');
    await upload('x'.repeat(1_000_001));
    await contents('#import-message', /Calendar file exceeds the 1 MB size limit\./);

    await fill('#settings-form', { windows: 'Funday 10:00-12:00' });
    await contents('#settings-error', /unknown weekday/i);
    await fill('#settings-form', { windows: 'Mon 16:00-20:00', sleepStart: '22:15' });
    await contents('#settings-error', /half-hour/i);

    await go('check');
    await fill('#proposal-form', { title: '', likely: '2', deadline: '2026-11-19' });
    await contents('#error-title', /Name must contain 1 to 80 characters\./);
    await fill('#proposal-form', { title: 'Too big', likely: '45', deadline: '2026-11-19' });
    await contents('#error-likely', /Typical hours must be 0\.5 to 40/);
    assert.equal(await js(`document.querySelector('#proposal-likely').getAttribute('aria-invalid')`), 'true');

    await go('feedback');
    await fill('#sleep-form', { date: '2026-11-19', hours: '25' });
    await contents('#sleep-error', /valid night and sleep duration/);
    assert.equal(await js('document.querySelectorAll("img").length'), 0);

    const external = requests.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
    assert.deepEqual(external, [], 'no external network requests');
  });

  // ---------------------------------------------------------------- T24
  await section('T24 engine budgets and render responsiveness (35 days / 30 tasks)', async () => {
    const timing = await execute(async () => {
      const { workload } = await import('./tests/fixtures/workload.mjs');
      const { evaluate } = await import('./src/engine/evaluate.mjs');
      const { findRepairs } = await import('./src/engine/repairs.mjs');
      const { days, tasks } = workload();
      const t0 = performance.now();
      const verdict = evaluate(tasks, days).verdict;
      const t1 = performance.now();
      const count = findRepairs(tasks, days).length;
      const t2 = performance.now();
      return { verdict, count, evaluateMs: t1 - t0, repairMs: t2 - t1, days, tasks };
    });
    assert.equal(timing.verdict, 'infeasible');
    assert.ok(timing.count > 0);
    assert.ok(timing.evaluateMs < 100, `evaluate ${timing.evaluateMs} ms`);
    assert.ok(timing.repairMs < 250, `findRepairs ${timing.repairMs} ms`);

    // Load the heavy plan into the real UI and time full dispatch + re-render cycles.
    await setStorage(`saved.days = ${JSON.stringify(timing.days)}; saved.tasks = ${JSON.stringify(timing.tasks)};
      saved.demo = false; saved.proposals = []; saved.appliedChanges = []; saved.pendingApprovals = []; saved.weekIndex = 0; saved.screen = 'week';`);
    await reload();
    await contents('#week-verdict', /INFEASIBLE/);
    const renders = {};
    renders.rescue = await timedClick('.nav-tab[data-screen="rescue"]');
    renders.check = await timedClick('.nav-tab[data-screen="check"]');
    renders.week = await timedClick('.nav-tab[data-screen="week"]');
    renders.nextWeek = await timedClick('#screen-week button', 'Next week');
    for (const [name, ms] of Object.entries(renders)) assert.ok(ms < 500, `${name} render took ${ms} ms`);
    await noOverflow('My Week (35 days / 30 tasks)');
    console.log(`  T24 engine: evaluate ${timing.evaluateMs.toFixed(2)} ms; findRepairs ${timing.repairMs.toFixed(2)} ms`);
    console.log(`  T24 UI dispatch+render: ${Object.entries(renders).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
  });

  assert.deepEqual(errors, [], `console/page errors: ${JSON.stringify(errors).slice(0, 500)}`);
  assert.deepEqual(failedLoads, [], `failed network loads: ${JSON.stringify(failedLoads).slice(0, 500)}`);
  const external = requests.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
  assert.deepEqual(external, []);
  console.log(`All T21–T24 browser checks passed: 0 console/page errors, 0 failed loads, ${requests.length} local requests, 0 external.`);
} finally {
  ws?.close();
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise(resolve => chrome.once('exit', resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
