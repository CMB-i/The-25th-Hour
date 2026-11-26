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
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  ...(process.env.CHROMIUM_NO_SANDBOX ? ['--no-sandbox'] : []),
  'about:blank'
], { stdio: 'ignore' });

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
  const port = await retry(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 200);
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
  // Pages are addressed by hash (#/week); this is also what the top-bar and in-page links use.
  const go = async screen => {
    await js(`location.hash = '#/${screen}'`);
    await retry(async () => assert.equal(await js(`document.getElementById('screen-${screen}').hidden`), false));
  };
  const timedGo = screen => execute(async name => {
    const start = performance.now();
    await new Promise(resolve => {
      addEventListener('hashchange', () => setTimeout(resolve, 0), { once: true });
      location.hash = `#/${name}`;
    });
    return performance.now() - start;
  }, screen);
  // Text squeezed into a sliver (the letter-by-letter wrapping regression): fails on very narrow text boxes.
  const replyTextValue = () => execute(() => document.querySelector('#reply-text')?.value ?? '');
  const noSqueeze = async label => {
    const bad = await js(`(() => {
      const out = [];
      for (const node of document.querySelectorAll('.screen-panel:not([hidden]) :is(h1,h2,h3,p,li,label,summary,button,a,strong)')) {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = node.textContent.trim();
        if (text.length < 14) continue;
        const style = getComputedStyle(node);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
        const lines = Math.max(1, Math.round(rect.height / lineHeight));
        const perLine = text.length / lines;
        if ((lines > 1 && (rect.width < 120 || perLine < 6)) || rect.width < 60) out.push(text.slice(0, 40) + ' w=' + Math.round(rect.width) + ' lines=' + lines);
      }
      return out;
    })()`);
    assert.deepEqual(bad, [], `squeezed text on ${label}`);
  };
  const persisted = () => js(`JSON.parse(localStorage.getItem('${STORAGE_KEY}'))`);
  const setStorage = mutate => execute((key, source) => {
    const saved = JSON.parse(localStorage.getItem(key));
    Function('saved', source)(saved);
    localStorage.setItem(key, JSON.stringify(saved));
  }, STORAGE_KEY, mutate);
  const ready = () => retry(async () => assert.ok((await js('document.querySelectorAll(".screen-panel:not([hidden]) > *").length')) > 0));
  const example = async (which, research = true) => {
    await go('home');
    if (await js(`!document.querySelector('#example-data')`)) await click('#home-example');
    await retry(async () => assert.ok(await js(`!!document.querySelector('#example-data')`)));
    await click('#example-data button', which);
    const has = (await persisted()).tasks.some(task => task.id === 'research');
    if (has !== research) await click('#example-data button', research ? 'sample research project back' : 'research project out');
  };
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
    // A fresh browser never shows the demo as the student's own week.
    await contents('#screen-home', /Set up my week/);
    await contents('#screen-home', /Try an example/);
    await lacks('#screen-home', /Thursday|DBMS/);
    assert.equal((await persisted()), null, 'opening the app writes nothing');
    await noOverflow('Home (first use)');
    await click('#home-example');
    await contents('#home-observation', /example data/);
    await contents('#screen-home', /Check a request.*View my week/s);
    await contents('#example-chip', /Example data/);
    await noOverflow('Home');
    await click('#home-check');
    await contents('#screen-check', /Check a request/);
    await contents('#example-line', /Example data/);
    await noOverflow('Check (empty)');
    await go('week');
    // Scenario A (flexible) — numbers come from the engine's binding deadline margin.
    await contents('#week-verdict', /Doesn't fit/);
    await contents('#week-verdict', /Thursday \(2026-11-19\): 15h of work due, 13h available\. Short by 2h\./);
    await contents('#week-verdict', /Tasks due by Thursday: DBMS Lab \(4h\), ML Assignment \(3h\), AUV Club Poster \(3h\), New Research Project \(5h\)\./);
    await lacks('#week-verdict', /fits|almost no room/i);
    assert.equal(await js(`document.querySelector('#week-verdict').getAttribute('aria-live')`), 'polite');
    // B6 labels and weekly baseline (visible week only).
    await contents('#screen-week', /Weekly hours only \(simulated baseline\)/);
    await contents('#screen-week', /Deadline-aware scheduler \(same allocation, no repair step\)/);
    await contents('#screen-week', /18h of 20h available this week/);
    // B7 freshness: no calendar yet -> stale banner, separate timestamp text.
    await contents('#busy-panel', /No calendar has been imported\. The check is using only the busy blocks you add here/);
    await lacks('#screen-week', /may be out of date/);
    await contents('body', /A feasible plan makes room to sleep; it can't guarantee sleep\./);
    assert.ok(await js(`document.querySelectorAll('.slot[aria-label]').length`) >= 40, 'timeline slots carry text alternatives');
    await noOverflow('My Week (Scenario A)');
    await noSqueeze('My week');

    // Week navigation does not change edit timestamps.
    await click('#screen-week button', 'Next week');
    await contents('#screen-week', /Week 2 of 5/);
    await click('#screen-week button', 'Previous week');
    await contents('#screen-week', /Week 1 of 5/);

    // Reset, Scenario A: one verified change leads, the other is an alternative; apply + undo.
    await go('rescue');
    await noOverflow('Reset (Scenario A)');
    await noSqueeze('Reset');
    await contents('#reset-lead', /The first deadline at risk is Thursday 19 Nov\. You're 2 hours short by Thursday 19 Nov\./);
    await contents('#reset-lead', /Move AUV Club Poster target to Friday.*You can do this yourself/s);
    assert.equal(await js(`document.querySelectorAll('#reset-alternatives .repair-card').length`), 1);
    await contents('#reset-alternatives .repair-card', /Decline New Research Project.*You can do this yourself/s);
    assert.equal(await js(`document.querySelectorAll('#screen-rescue .reply-slip').length`), 0, 'no reply slip for a self-serve change');
    await click('#apply-lead');
    await contents('#reset-status', /Tight/);
    await click('#undo-last');
    await contents('#reset-status', /Doesn't fit/);

    // Scenario B (fixed): approval-gated extension never applies before explicit approval + apply.
    await example('Sample week B', true);
    await go('rescue');
    await contents('#reset-lead', /Decline New Research Project/);
    await contents('#reset-alternatives .repair-card', /Request AUV Club Poster deadline on Friday.*If approved/s);
    await click('#reset-alternatives .repair-card button', 'Use this instead');
    await contents('#reset-lead', /Request AUV Club Poster deadline on Friday.*If approved/s);
    await contents('#reply-slip', /Here's what you could send/);
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await click('#copy-reply');
    await contents('#copy-status', /^Copied$/);
    assert.match(await js('navigator.clipboard.readText()'), /deadline.*2026-11-20/i);
    assert.equal(await isDisabled('#screen-rescue button', 'Apply approved change'), true);
    await click('#screen-rescue button', 'Mark declined');
    assert.equal(await isDisabled('#screen-rescue button', 'Apply approved change'), true);
    await click('#screen-rescue button', 'Mark approved');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').hardDay, 3, 'approval alone must not change the plan');
    await contents('#reset-status', /Doesn't fit/);
    await click('#screen-rescue button', 'Apply approved change');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').hardDay, 4);
    await contents('#reset-status', /Tight/);
    await noOverflow('Reset (Scenario B)');

    // B9: three distinct empty-repair messages.
    await example('Sample week A', false);
    await go('week');
    await contents('#week-verdict', /Fits.*This fits your week\./s);
    await go('rescue');
    await contents('#screen-rescue', /No change needed/);
    await lacks('#screen-rescue', /No verified fix/);

    // No hard-coded Thursday: a Tuesday-binding plan names Tuesday with engine numbers.
    await setStorage(`saved.tasks = [{id:'tue',title:'Tuesday Quiz',min:10,likely:10,max:10,targetDay:1,hardDay:1,earliestDay:0,priority:1,flexible:false,allowDrop:false,splittable:true}];
      saved.proposals = []; saved.appliedChanges = []; saved.pendingApprovals = []; saved.feedback = {tasks:[],sleepReports:[]}; saved.screen = 'week';`);
    await reload();
    await go('week');
    await contents('#week-verdict', /Tuesday \(2026-11-17\): 10h of work due, 7h available\. Short by 3h\./);
    await lacks('#week-verdict', /Thursday/);
    await go('rescue');
    await contents('#screen-rescue', /No verified fix with the changes you've allowed\. This is a capacity problem, not a scheduling problem\./);
    await lacks('#screen-rescue', /No change needed/);

    // At-risk with no improving repair.
    await setStorage(`saved.tasks = [{id:'tight',title:'Tight Lab',min:3.5,likely:3.5,max:3.5,targetDay:0,hardDay:0,earliestDay:0,priority:1,flexible:false,allowDrop:false,splittable:true}]; saved.screen = 'rescue';`);
    await reload();
    await go('rescue');
    await contents('#screen-rescue', /No further verified change\. Keep your buffer\./);
    await go('week');
    await contents('#week-verdict', /Tight.*It fits, but there is almost no room for error\..*Monday \(2026-11-16\) has only 0\.5h to spare/s);

    // Fresh calendar import removes the stale banner and shows both timestamps.
    await go('week');
    await upload('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261117T170000\nDTEND:20261117T173000\nSUMMARY:Seminar\nEND:VEVENT\nEND:VCALENDAR');
    await contents('#import-message', /Imported 1 busy window/);
    await go('week');
    await contents('#busy-panel', /Calendar imported /);
    await lacks('#screen-week', /may be out of date|over a day ago/);
    // A calendar older than 24h shows the stale banner again.
    await setStorage(`saved.calendarImportedAt = '2000-01-01T00:00:00.000Z';`);
    await reload();
    await go('week');
    await contents('#busy-panel', /Calendar imported .*over a day ago, so import it again/s);

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
    await execute(() => document.querySelector('#nav-week').focus());
    await key('Enter', 'Enter', 13, '\r');
    await contents('#nav-week[aria-current="page"]', /My week/);
    await go('check');
    await noOverflow('Check a request');
    for (const screen of ['feedback', 'settings', 'week']) {
      await go(screen);
      await noOverflow(screen);
    }
  });

  // ---------------------------------------------------------------- T22
  await section('T22 persistence of tasks, settings, feedback, applied changes; clear all', async () => {
    await example('Sample week A', true);
    // Applied change.
    await go('rescue');
    await click('#apply-lead');
    // New tasks via Commitment Check (Accept anyway keeps conflict visible).
    await go('check');
    for (const name of ['One', 'Two', 'Three']) {
      await fill('#proposal-form', { title: `Problem set ${name}`, likely: '4', type: 'problem_set', deadline: '2026-11-27' });
      await contents('#full-numbers', /Without this request:.*With this request:/s);
      await contents('#check-verdict', /short|fits/i);
      assert.ok(!(await persisted()).tasks.some(task => task.title === `Problem set ${name}`), 'draft must not join plan before acceptance');
      // Plain add when it fits, "anyway" when it does not (the shortfall then stays visible).
      await execute(() => {
        const buttons = [...document.querySelectorAll('#check-decisions button')];
        const add = buttons.find(node => /^Add it (to my week|anyway)$/.test(node.textContent.trim()));
        if (!add) throw Error('No add button');
        add.click();
      });
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
    // Opening the app never rewrites saved data, even though it opens on Check.
    assert.deepEqual(await persisted(), saved);
    await go('week');
    await contents('#schedule-details', /22:30–07:00/);
    await go('feedback');
    await contents('#review', /Problem set One.*1\.392×.*6\.5h slept/s);
    await go('rescue');
    await contents('#reset-history', /Move AUV Club Poster target to Friday/);

    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
    assert.ok(dialogs.some(message => /Clear/.test(message)), 'clear asks for confirmation');
    await contents('#screen-settings', /Set up my week/);
    await reload();
    assert.equal(await persisted(), null);
    await lacks('body', /Problem set One/);

    // Accept with suggested change + Undo round-trip.
    await example('Sample week A', false);
    await go('check');
    await fill('#proposal-form', { title: 'Research replacement', likely: '5', deadline: '2026-11-19', tag: 'droppable' });
    await click('#screen-check button', 'Add it with this change');
    const repaired = await persisted();
    assert.equal(repaired.tasks.find(task => task.id === 'poster').targetDay, 4);
    assert.equal(repaired.tasks.find(task => task.title === 'Research replacement').isProposal, false);
    await go('rescue');
    await click('#undo-last');
    assert.equal((await persisted()).tasks.find(task => task.id === 'poster').targetDay, 3);
    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
  });

  // ---------------------------------------------------------------- T23
  await section('T23 untrusted input as text, 1 MB limit, invalid input messages, no external requests', async () => {
    // A cleared browser stores nothing until the student does something; saving a name is the lightest first save.
    await go('settings');
    await fill('#name-form', { name: 'Tester' });
    await go('week');
    // After T22's clear, the plan starts from today's week, so take dates from the loaded plan.
    const loadedDays = (await persisted()).days.map(day => day.date);
    const due = loadedDays[3];
    const compact = loadedDays[0].replaceAll('-', '');
    await fill('#paste-form', { tasks: `${INJECTION} | 1h | ${due} | droppable\nBad | 0.3h | ${due}` });
    await contents('#import-message', /Added 1, skipped 1\..*Line 2: Hours must be positive/s);
    assert.ok((await text('#screen-week')).includes(INJECTION), 'title rendered literally');
    await upload(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${compact}T160000\nDTEND:${compact}T170000\nSUMMARY:${INJECTION}\nEND:VEVENT\nEND:VCALENDAR`);
    await contents('#import-message', /Imported 1 busy window/);
    assert.ok(!(await text('body')).includes('SUMMARY:'), 'event titles are not displayed or stored');
    assert.equal(await js('document.querySelectorAll("img").length'), 0, 'no injected elements');
    await upload('x'.repeat(1_000_001));
    await contents('#import-message', /Calendar file exceeds the 1 MB size limit\./);

    await go('settings');
    await fill('#settings-form', { windows: 'Funday 10:00-12:00' });
    await contents('#settings-error', /unknown weekday/i);
    await fill('#settings-form', { windows: 'Mon 16:00-20:00', sleepStart: '22:15' });
    await contents('#settings-error', /half-hour/i);

    await go('check');
    await fill('#proposal-form', { title: '', likely: '2', deadline: due });
    await contents('#error-title', /Name must contain 1 to 80 characters\./);
    await fill('#proposal-form', { title: 'Too big', likely: '45', deadline: due });
    await contents('#error-likely', /Typical hours must be 0\.5 to 40/);
    assert.equal(await js(`document.querySelector('#proposal-likely').getAttribute('aria-invalid')`), 'true');

    await go('feedback');
    await fill('#sleep-form', { date: due, hours: '25' });
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
    await go('week');
    await contents('#week-verdict', /Doesn't fit/);
    const renders = {};
    renders.rescue = await timedGo('rescue');
    renders.check = await timedGo('check');
    renders.week = await timedGo('week');
    renders.nextWeek = await timedClick('#screen-week button', 'Next week');
    for (const [name, ms] of Object.entries(renders)) assert.ok(ms < 500, `${name} render took ${ms} ms`);
    await noOverflow('My Week (35 days / 30 tasks)');
    console.log(`  T24 engine: evaluate ${timing.evaluateMs.toFixed(2)} ms; findRepairs ${timing.repairMs.toFixed(2)} ms`);
    console.log(`  T24 UI dispatch+render: ${Object.entries(renders).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
  });

  // ---------------------------------------------------------------- T25
  await section('T25 commitment check: verdict, one option, reply slip, smaller offer, rerun, keyboard', async () => {
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await reload();
    await go('check');
    const sample = async (which, research = false) => { await example(which, research); await go('check'); };
    const setReply = value => execute(v => {
      const box = document.querySelector('#reply-text');
      box.value = v;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    const replyText = () => execute(() => document.querySelector('#reply-text')?.value ?? '');
    const snapshot = async () => { const saved = await persisted(); return { tasks: saved.tasks, proposals: saved.proposals, approvals: saved.pendingApprovals, applied: saved.appliedChanges }; };
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });

    // The first screen asks for three things; everything else is behind "More options".
    await sample('Sample week A');
    assert.equal(await js(`document.querySelectorAll('#proposal-form > .form-field input, #proposal-form > .form-grid-two > .form-field input').length`), 3);
    assert.equal(await js(`document.querySelector('#more-options').open`), false);
    assert.equal(await js(`document.querySelectorAll('#more-options [name]').length`), 6);
    await noOverflow('Check form');

    // (a) fits: plain yes; copying changes nothing.
    await fill('#proposal-form', { title: 'Study notes', likely: '2', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^Yes, this fits\. Your tightest day, .* still has .* to spare\.$/);
    assert.equal(await js('document.activeElement.id'), 'verdict-headline', 'focus moves to the verdict');
    await retry(async () => assert.match(await text('#sr-announcer'), /Fits\. Yes, this fits/));
    assert.match(await replyText(), /Yes, I can take on Study notes\. I'll have it done by Friday 20 Nov\./);
    assert.doesNotMatch(await replyText(), /sleep|stress/i);
    await lacks('#check-option', /./);
    await noOverflow('Check: fits');
    const beforeCopy = await persisted();
    await click('#copy-reply');
    await contents('#copy-status', /^Copied$/);
    assert.match(await js('navigator.clipboard.readText()'), /Yes, I can take on Study notes/);
    assert.deepEqual(await persisted(), beforeCopy, 'copying a reply changes nothing');

    // (b) does not fit, verified self-serve option and a conditional yes (date comes from the engine).
    await click('#edit-request');
    await fill('#proposal-form', { likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-headline', /^You're 1 hour short by Thursday 19 Nov\.$/);
    await contents('#check-option', /You can do this yourself.*Move Study notes target to Friday.*With that change it fits/s);
    assert.match(await replyText(), /have it to you by Friday 20 Nov\. Would that work\?/);
    await contents('#estimate-range', /At 3h it fits\. At 4h you're 1 hour short by Thursday 19 Nov\./);
    await noOverflow('Check: short with option');
    assert.equal((await persisted()).tasks.some(task => task.title === 'Study notes'), false, 'still not in the week');

    // (g) smaller offer: only claimed once the engine verifies it.
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Report', likely: '6', deadline: '2026-11-17', tag: 'must-keep' });
    await contents('#verdict-headline', /short by Tuesday 17 Nov/);
    await contents('#check-option', /No change makes this fit\./);
    assert.match(await replyText(), /can't take it on by Tuesday 17 Nov/);
    await fill('#smaller-form', { scope: 'the outline', hours: '1' });
    await contents('#smaller-status', /The smaller version \(1 hour\) fits\. The full request \(6 hours\) didn't\./);
    assert.match(await replyText(), /I can do the outline by Tuesday 17 Nov/);
    await fill('#smaller-form', { scope: 'most of it', hours: '5' });
    await contents('#smaller-status', /Even the smaller version \(5 hours\) doesn't fit\./);
    assert.doesNotMatch(await replyText(), /I can do most of it/);
    await fill('#smaller-form', { scope: 'x', hours: '6' });
    await contents('#smaller-error', /fewer than 6 hours/);

    // (d) nothing verified: kind no, or a request for flexibility without a date promise.
    await click('#smaller-form button', 'Back to the full request');
    await contents('#reply-text', /./).catch(() => {});
    assert.match(await replyText(), /can't take it on/);
    await click('.variant-toggle button', 'Ask for flexibility');
    assert.match(await replyText(), /what's flexible/);
    assert.doesNotMatch(await replyText(), /I'll have it done by|to you by/);

    // (f) edit the reply, correct the timetable, rerun: the edit survives and is flagged.
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Notes', likely: '1', deadline: '2026-11-17' });
    await contents('#verdict-headline', /^Yes, this fits/);
    await setReply('My own words: happy to help, will confirm.');
    await click('#booked-week summary');
    await contents('#booked-week', /No calendar has been imported/);
    await fill('#busy-form', { day: '1', start: '17:00', end: '20:00' });
    await contents('#verdict-headline', /short by Tuesday 17 Nov/);
    assert.equal(await replyText(), 'My own words: happy to help, will confirm.', 'edited reply is kept');
    await contents('#reply-flag', /Check this before sending\./);
    await click('#reply-flag button', "I've checked it");
    assert.equal(await js(`document.querySelector('#reply-flag')`), null);
    // Undo the correction: verdict flips back, edit still kept, flag returns.
    await click('#booked-week .chip-remove');
    await contents('#verdict-headline', /^Yes, this fits/);
    await contents('#reply-flag', /Check this before sending\./);
    assert.equal(await replyText(), 'My own words: happy to help, will confirm.');
    await noOverflow('Check: booked week');

    // (e) a week that already has a conflict is named, so the request isn't blamed.
    await click('#decisions, #check-decisions button', 'Not now');
    await sample('Sample week A', true);
    await fill('#proposal-form', { title: 'Small ask', likely: '1', deadline: '2026-11-20' });
    await contents('#verdict-headline', /Your week was already .* short by Thursday 19 Nov\./);

    // (c) approval needed: draft comes from the engine, request stays pending, copying applies nothing.
    await click('#check-decisions button', 'Not now');
    await sample('Sample week B');
    await fill('#proposal-form', { title: 'Lab write-up', likely: '4', deadline: '2026-11-19' });
    await contents('#check-option', /If approved/);
    assert.match(await replyText(), /Request to adjust AUV Club Poster deadline/);
    await contents('#reply-slip', /stays on hold/);
    const approvalBefore = await snapshot();
    await click('#copy-reply');
    await contents('#copy-status', /^Copied$/);
    assert.match(await js('navigator.clipboard.readText()'), /Request to adjust AUV Club Poster deadline/);
    assert.deepEqual(await snapshot(), approvalBefore);
    const afterCopy = await persisted();
    assert.equal(afterCopy.proposals.length, 1, 'request stays pending');
    assert.equal(afterCopy.pendingApprovals.length, 0, 'no approval recorded');
    assert.equal(afterCopy.tasks.find(task => task.id === 'poster').hardDay, 3, 'nothing applied');
    await noOverflow('Check: approval');

    // (h) keyboard: every control reachable; existing storage without newer fields still loads.
    await execute(() => {
      for (const control of document.querySelectorAll('#screen-check a,#screen-check button,#screen-check input,#screen-check select,#screen-check textarea,#screen-check summary')) {
        if (control.disabled || !control.getClientRects().length) continue;
        if (control.tabIndex < 0) throw Error(`Unreachable: ${control.outerHTML.slice(0, 100)}`);
      }
    });
    await example('Sample week A', true);
    const tasksBefore = (await persisted()).tasks;
    await setStorage(`delete saved.displayName;`);
    await reload();
    await go('rescue');
    await contents('#reset-lead', /The first deadline at risk is Thursday 19 Nov\. You're 2 hours short by Thursday 19 Nov\..*Move AUV Club Poster target to Friday/s);
    assert.deepEqual((await persisted()).tasks, tasksBefore, 'saved plan survives');
    await go('settings');
    await fill('#name-form', { name: 'Sam' });
    await go('home');
    await contents('#screen-home .eyebrow', /, Sam\./);
    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
  });

  // ---------------------------------------------------------------- T26
  await section('T26 first-use setup, work-hours editor, example round-trip, no squeezed text, routing', async () => {
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await js(`location.hash = ''`);
    await reload();
    await go('home');
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });

    // First use: invited to set up or try an example; the top bar is just the wordmark and My week.
    await contents('#screen-home', /Set up my week/);
    assert.deepEqual(await js(`[...document.querySelectorAll('.topbar a')].map(a => a.textContent.trim())`).then(list => list.filter(Boolean)), ['The 25th Hour', 'My week']);
    await click('#home-setup');
    await contents('#screen-settings h1', /Set up my week/);
    await click('#fill-weekdays');
    assert.equal(await js(`document.querySelector('#hours-1-0-start').value`), '16:00');
    assert.equal(await js(`document.querySelector('label[for="hours-1-0-start"]').textContent`), 'Monday from');
    await execute(() => {
      const end = document.querySelector('#hours-1-0-end');
      end.value = '18:00';
      end.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await fill('#settings-form', {});
    let saved = await persisted();
    assert.equal(saved.setupComplete, true);
    assert.equal(saved.demo, false);
    assert.deepEqual(saved.settings.weeklyWorkWindows[1], [['16:00', '18:00']]);
    assert.deepEqual(saved.settings.weeklyWorkWindows[2], [['16:00', '20:00']]);

    // Week: add a fixed block beside "When are you busy?" and see it counted.
    await go('week');
    await contents('#busy-panel', /When are you busy\?/);
    await contents('#todo-panel', /What still needs doing\?/);
    await fill('#week-busy-form', { day: '1', start: '09:00', end: '10:00' });
    saved = await persisted();
    assert.deepEqual(saved.days[1].busyWindows, [['09:00', '10:00']]);
    await contents('#busy-panel', /Tuesday .*09:00–10:00/);

    // Check from the personal week: no example label, verdict and reply appear.
    await go('home');
    await contents('#home-observation', /Nothing is due/);
    await lacks('#screen-home', /Example data/);
    await click('#home-check');
    const dueDate = saved.days[10].date;
    await fill('#proposal-form', { title: 'Study group', likely: '2', deadline: dueDate });
    await contents('#check-verdict', /./);
    assert.match(await replyTextValue(), /Study group/);
    await lacks('#screen-check', /Example data/);
    await click('#check-decisions button', 'Not now');

    // Entering and leaving an example keeps the personal week.
    await go('home');
    await click('#home-example');
    await retry(async () => assert.equal((await persisted()).demo, true));
    assert.ok((await persisted()).personalBackup, 'personal week stashed');
    await contents('#example-chip', /Example data/);
    await click('#home-leave-example');
    await retry(async () => assert.equal((await persisted()).demo, false));
    saved = await persisted();
    assert.equal(saved.personalBackup, null);
    assert.deepEqual(saved.days[1].busyWindows, [['09:00', '10:00']], 'busy block restored');
    assert.deepEqual(saved.settings.weeklyWorkWindows[1], [['16:00', '18:00']], 'work hours restored');

    // No squeezed text and no overflow on any page at phone and desktop widths, personal and example data.
    await example('Sample week A', true);
    await click('#home-leave-example').catch(() => {});
    await example('Sample week A', true);
    for (const width of [360, 390, 1200]) {
      await setWidth(width);
      for (const screen of ['home', 'check', 'week', 'rescue', 'feedback', 'settings']) {
        await go(screen);
        await noOverflow(`${screen} at ${width}`);
        await noSqueeze(`${screen} at ${width}`);
      }
    }
    // The My week verdict gets real room: far wider than a sliver on both phone and desktop.
    for (const [width, min] of [[390, 300], [1200, 500]]) {
      await setWidth(width);
      await go('week');
      assert.ok(await js(`document.querySelector('#week-verdict').getBoundingClientRect().width`) >= min, `week verdict width at ${width}`);
    }
    // Phone width shows one selected day; desktop shows the whole agenda.
    await setWidth(390);
    await go('week');
    assert.equal(await js(`[...document.querySelectorAll('.agenda-day')].filter(n => n.getClientRects().length).length`), 1);
    await click('.strip-day', 'Thu');
    await contents('.agenda-day.is-selected h3', /Thursday/);
    await setWidth(1200);
    assert.equal(await js(`[...document.querySelectorAll('.agenda-day')].filter(n => n.getClientRects().length).length`), 7);
    await setWidth(360);

    // Review leads with the completion log; sleep logging is collapsed. Settings keeps deletion apart.
    await go('feedback');
    assert.equal(await js(`document.querySelector('#sleep-details').open`), false);
    assert.ok(await js(`document.querySelector('#completion-form').getClientRects().length > 0`));
    await go('settings');
    assert.ok(await js(`!!document.querySelector('.danger-zone #clear')`));
    assert.equal(await js(`document.querySelectorAll('#settings-form #clear').length`), 0);

    // Links and the browser back button move between pages.
    await go('check');
    await go('week');
    await js('history.back()');
    await retry(async () => assert.equal(await js(`document.getElementById('screen-check').hidden`), false));
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
