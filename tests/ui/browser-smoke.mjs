// Browser acceptance tests T21–T24 for the 5-screen static frontend.
// Drives a real Chrome/Chromium over the DevTools Protocol (no npm dependencies).
// Usage: start `python3 -m http.server 8000 --bind 127.0.0.1` at the repo root, then
//   node tests/ui/browser-smoke.mjs
// Env: CHROMIUM (browser executable), CHROMIUM_NO_SANDBOX=1, TEST_ORIGIN (default http://127.0.0.1:8000).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        if (node.closest('.sr-only, .wgrid, .wg-legend')) continue; // visually hidden on purpose / the time grid is compact by design (checked in T35)
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = node.textContent.trim();
        if (text.length < 14) continue;
        // Count real text lines from the text's own boxes (tap-target padding must not look like extra lines).
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set([...range.getClientRects()].filter(box => box.width > 0).map(box => Math.round(box.top / 4)));
        const lines = Math.max(1, tops.size);
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
  // Fixtures are used internally only: they are written to storage as an ordinary personal plan.
  const fixture = async (fixed, research = true) => {
    await execute(async (isFixed, withResearch, key) => {
      const { makeInitialState } = await import('./src/ui/state.mjs');
      const base = makeInitialState({ fixed: isFixed, demo: true });
      const tasks = withResearch ? base.tasks : base.tasks.filter(task => task.id !== 'research');
      localStorage.setItem(key, JSON.stringify({ ...base, demo: false, setupComplete: true, includeResearch: withResearch, tasks }));
    }, fixed, research, STORAGE_KEY);
    await reload();
  };
  const example = (which, research = true) => fixture(/B/.test(which), research);
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
  // The browser clock is pinned to the fixture week (Monday 16 Nov 2026, 10:00 IST) so results never depend on today's date.
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const RealDate = Date;
    let offset = new RealDate(2026, 10, 16, 10, 0, 0).getTime() - RealDate.now();
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
      static now() { return RealDate.now() + offset; }
    }
    globalThis.Date = FakeDate;
    globalThis.__setFakeNow = iso => { offset = RealDate.parse(iso) - RealDate.now(); };
  })();` });
  await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/` });
  await ready();
  await js(`localStorage.removeItem('${STORAGE_KEY}')`);
  await reload();

  // ---------------------------------------------------------------- T21
  await section('T21 interface states, both scenarios, B4/B6/B7/B9, keyboard, 360px', async () => {
    // A fresh browser opens straight onto the Check form: no welcome wall, no example, nothing saved yet.
    await contents('#screen-home .card-title', /What's on the table\?/);
    assert.equal(await js(`!!document.querySelector('#proposal-form')`), true);
    await contents('#home-timetable', /Add your timetable for a more accurate check/);
    await lacks('#screen-home', /Thursday|DBMS/);
    assert.equal((await persisted()), null, 'opening the app writes nothing');
    await noOverflow('Home (first use)');
    // A returning student with a real plan: one observation above the same form.
    await fixture(false, true);
    await contents('#home-observation', /^Your ML Assignment, AUV Club Poster and 1 more are due Thursday 19 Nov and you're 2 hours short\.$/);
    assert.equal(await js(`!!document.querySelector('#proposal-form')`), true);
    await noOverflow('Home');
    await go('check');
    await contents('#screen-check', /Before you say yes\./);
    await noOverflow('Check (empty)');
    await go('week');
    // Scenario A (flexible) — numbers come from the engine's binding deadline margin.
    await contents('#week-verdict', /Doesn't fit/);
    await contents('#week-verdict', /Thursday \(2026-11-19\): 15h of work due, 13h available\. Short by 2h\./);
    await contents('#week-verdict', /Tasks due by Thursday: DBMS Lab \(4h\), ML Assignment \(3h\), AUV Club Poster \(3h\), New Research Project \(5h\)\./);
    await lacks('#week-verdict', /fits|almost no room/i);
    assert.equal(await js(`document.querySelector('#week-verdict').getAttribute('aria-live')`), 'polite');
    // The week's own totals come straight from the engine's schedule.
    await contents('#week-verdict', /This week: 18h of work, 20h free after busy blocks and sleep\./);
    // B7 freshness: no calendar yet -> stale banner, separate timestamp text.
    await contents('#busy-panel', /No timetable imported yet\. I only count blocks you add here/);
    await lacks('#screen-week', /may be out of date/);
    await contents('body', /A feasible plan makes room to sleep\. It can't make you sleep\./);
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
    await contents('#busy-panel', /Using the timetable you imported on/);
    await lacks('#screen-week', /may be out of date|over a day ago/);
    // A calendar older than 24h shows the stale banner again.
    await setStorage(`saved.calendarImportedAt = '2000-01-01T00:00:00.000Z';`);
    await reload();
    await go('week');
    await contents('#busy-panel', /Using the timetable you imported on .*over a day ago, so import it again/s);

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
      await go('check');
      await fill('#proposal-form', { title: `Problem set ${name}`, likely: '4', type: 'problem_set', deadline: '2026-11-27' });
      await contents('#full-numbers', /Without this request:.*With this request:/s);
      await contents('#check-verdict', /short|fits/i);
      assert.ok(!(await persisted()).tasks.some(task => task.title === `Problem set ${name}`), 'draft must not join plan before acceptance');
      // Plain add when it fits, "anyway" when it does not (the shortfall then stays visible).
      await execute(() => {
        const buttons = [...document.querySelectorAll('#check-decisions button')];
        const add = buttons.find(node => /^(Add it to my week|Say yes anyway)$/.test(node.textContent.trim()));
        if (!add) throw Error('No add button');
        add.click();
      });
      // "Say yes anyway" lands on the cost screen; nothing is saved until "Put it on my week".
      if (await js(`location.hash`) === '#/cost') await click('#cost-put');
      await retry(async () => assert.ok((await persisted()).tasks.some(task => task.title === `Problem set ${name}`)));
    }
    // Feedback: 3 problem sets (4h -> 6h) produce 1.392x ratio and optional 5.5h suggestion.
    await go('feedback');
    for (const [i, name] of ['One', 'Two', 'Three'].entries()) {
      const taskId = (await persisted()).tasks.find(task => task.title === `Problem set ${name}`).id;
      await fill('#completion-form', { taskId, taskType: 'problem_set', actualHours: '6', recordedAt: `2026-11-${18 + i}T12:00` });
    }
    await fill('#sleep-form', { date: '2026-11-19', hours: '6.5', stress: '2' });
    await contents('#review', /Problem set One.*6\.5h slept.*1\.392× \(3 finished tasks/s);

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
    await click('#screen-check button', 'with this change');
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
    // What, how long, when, who is waiting; the rest is behind More options.
    assert.equal(await js(`document.querySelectorAll('#proposal-form > .field').length`), 4);
    assert.equal(await js(`document.querySelector('#more-options').open`), false);
    assert.equal(await js(`document.querySelectorAll('#more-options [name]').length`), 6);
    await noOverflow('Check form');

    // (a) fits: plain yes; copying changes nothing.
    await fill('#proposal-form', { title: 'Study notes', likely: '2', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^That fits\.$/);
    await contents('#verdict-lead', /^You'd have .* to spare by .*, with sleep untouched\. Say yes with a clear conscience\.$/);
    assert.equal(await js('document.activeElement.id'), 'verdict-headline', 'focus moves to the verdict');
    await retry(async () => assert.match(await text('#sr-announcer'), /That fits\. You'd have/));
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
    await contents('#verdict-headline', /^Not yet\.$/);
    await contents('#verdict-lead', /^You're 1 hour short by Thursday 19 Nov\.$/);
    await contents('#check-option', /You can do this yourself.*Move Study notes target to Friday.*With that change it fits/s);
    // "More time" only appears because the engine verified Friday against everything else.
    await click('#tab-more');
    assert.match(await replyText(), /have it to you by Friday 20 Nov\. Would that work\?/);
    await contents('#range-sentence', /^3h fits\. 4h is 1h short\. 5\.5h is 2\.5h short\.$/);
    await noOverflow('Check: short with option');
    assert.equal((await persisted()).tasks.some(task => task.title === 'Study notes'), false, 'still not in the week');

    // (g) smaller offer: only claimed once the engine verifies it.
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Report', likely: '6', deadline: '2026-11-17', tag: 'must-keep' });
    await contents('#verdict-lead', /short by Tuesday 17 Nov/);
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
    await click('#tab-flex');
    assert.match(await replyText(), /what's flexible/);
    assert.doesNotMatch(await replyText(), /I'll have it done by|to you by/);

    // (f) edit the reply, correct the timetable, rerun: the edit survives and is flagged.
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Notes', likely: '1', deadline: '2026-11-17' });
    await contents('#verdict-headline', /^That fits\.$/);
    await setReply('My own words: happy to help, will confirm.');
    await click('#booked-week summary');
    await contents('#booked-week', /No calendar has been imported/);
    await fill('#busy-form', { day: '1', start: '17:00', end: '20:00' });
    await contents('#verdict-lead', /short by Tuesday 17 Nov/);
    assert.equal(await replyText(), 'My own words: happy to help, will confirm.', 'edited reply is kept');
    await contents('#reply-flag', /Check this before sending\./);
    await click('#reply-flag button', "I've checked it");
    assert.equal(await js(`document.querySelector('#reply-flag')`), null);
    // Undo the correction: verdict flips back, edit still kept, flag returns.
    await click('#booked-week .chip-remove');
    await contents('#verdict-headline', /^That fits\.$/);
    await contents('#reply-flag', /Check this before sending\./);
    assert.equal(await replyText(), 'My own words: happy to help, will confirm.');
    await noOverflow('Check: booked week');

    // (e) a week that already has a conflict is named, so the request isn't blamed.
    await click('#decisions, #check-decisions button', 'Not now');
    await sample('Sample week A', true);
    await fill('#proposal-form', { title: 'Small ask', likely: '1', deadline: '2026-11-20' });
    await contents('#verdict-lead', /Your week was already .* short by Thursday 19 Nov\./);

    // (c) approval needed: draft comes from the engine, request stays pending, copying applies nothing.
    await click('#check-decisions button', 'Not now');
    await sample('Sample week B');
    await fill('#proposal-form', { title: 'Lab write-up', likely: '4', deadline: '2026-11-19' });
    await contents('#check-option', /If approved/);
    // Tabs: only verified replies. An approval-needed change offers a conditional yes and the engine's approval request.
    assert.equal(await js(`[...document.querySelectorAll('.slip-tab')].map(t => t.textContent).join('|')`), 'Yes, if|Ask for approval|Kind no');
    await click('#tab-approval');
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
    await contents('#home-eyebrow', /^GOOD (MORNING|AFTERNOON|EVENING), SAM$/);
    await go('settings');
    await click('#clear');
    await retry(async () => assert.equal(await persisted(), null));
  });

  // ---------------------------------------------------------------- T26
  await section('T26 Home is Check: no availability asks inline, work-hours editor, week setup controls', async () => {
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await js(`location.hash = ''`);
    await reload();
    await go('home');
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);

    // Fresh browser: the form is right there; the top bar is the wordmark and My week.
    assert.deepEqual(await js(`[...document.querySelectorAll('.topbar a')].map(a => a.textContent.trim()).filter(Boolean)`), ['The 25th Hour', 'My week']);
    await contents('#screen-home', /What is it\?.*How long might it take\?.*When is it due\?/s);
    assert.equal(await js(`document.querySelector('#proposal-form button[type=submit]').textContent.trim()`), 'Run the numbers');
    assert.equal(await js(`document.querySelector('#more-options').open`), false, 'advanced fields stay under More options');
    await lacks('#screen-home', /Set up my week|welcome/i);

    // No availability: keep the request and ask for hours inline. No verdict is produced.
    await fill('#proposal-form', { title: 'Study group', likely: '2', deadline: '2026-11-19' });
    await contents('#availability-heading', /When could you work on this before it's due\?/);
    assert.equal(await js(`document.querySelector('#check-verdict')`), null, 'no verdict without availability');
    assert.equal(await js(`document.querySelector('#reply-slip')`), null);
    await contents('.request-summary', /Study group/);
    await noOverflow('Check: asks for hours');
    await noSqueeze('Check: asks for hours');
    // The inline control: one time range across ticked weekdays (preset), then the same check re-runs.
    await click('#avail-apply');
    await contents('#avail-error', /Tick at least one day/);
    await click('#avail-preset-weekdays');
    assert.equal(await js(`[...document.querySelectorAll('#avail-picker input[type=checkbox]')].filter(box => box.checked).length`), 5);
    await execute(() => {
      for (const [id, value] of [['avail-start', '16:00'], ['avail-end', '20:00']]) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await click('#avail-apply');
    await retry(async () => assert.ok(await js(`!!document.querySelector('#check-verdict')`)));
    assert.equal(await js('document.activeElement.id'), 'verdict-headline');
    assert.match(await replyTextValue(), /Study group/);
    await contents('.request-summary', /Study group · 2h · Thursday/);
    let saved = await persisted();
    assert.deepEqual(saved.settings.weeklyWorkWindows[1], [['16:00', '20:00']]);
    assert.deepEqual(saved.settings.weeklyWorkWindows[0], []);
    assert.equal(saved.proposals.length, 1, 'the draft survived');
    assert.equal(saved.proposals[0].title, 'Study group');
    assert.equal(saved.tasks.length, 0, 'nothing added to the week');
    // Copying only copies.
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    const beforeCopy = await persisted();
    await click('#copy-reply');
    await contents('#copy-status', /^Copied$/);
    assert.deepEqual(await persisted(), beforeCopy);
    await click('#check-decisions button', 'Not now');

    // Settings: one range across ticked days (presets), single days as exceptions; no seven empty forms.
    await go('settings');
    await lacks('#screen-settings', /Add a Monday window/);
    await click('#range-preset-everyday');
    await execute(() => {
      for (const [id, value] of [['range-start', '09:00'], ['range-end', '11:00']]) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await click('#range-apply');
    await contents('#hours-summary', /Sunday\s*09:00–11:00/);
    await click('#day-edit-6');
    await execute(() => {
      const end = document.querySelector('#hours-6-0-end');
      end.value = '10:00';
      end.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await fill('#settings-form', {});
    saved = await persisted();
    assert.deepEqual(saved.settings.weeklyWorkWindows[1], [['09:00', '11:00']]);
    assert.deepEqual(saved.settings.weeklyWorkWindows[6], [['09:00', '10:00']], 'Saturday exception');
    await noSqueeze('Settings');

    // My week: importing a timetable and adding a busy block are one tap away, not buried.
    await go('week');
    assert.ok(await js(`document.querySelector('#import-timetable').getClientRects().length > 0`));
    assert.ok(await js(`document.querySelector('#add-busy').getClientRects().length > 0`));
    await click('#add-busy');
    assert.equal(await js('document.activeElement.id'), 'week-busy-title');
    await fill('#week-busy-form', { day: '1', start: '09:00', end: '10:00', title: 'Lab' });
    assert.deepEqual((await persisted()).days[1].busyWindows, [['09:00', '10:00']]);
    await contents('#busy-panel', /1 block you added/);
    await contents('#week-grid', /Lab/);
    assert.ok(await js(`!!document.querySelector('.wg-busy[aria-label*="Lab"][aria-label*="Tuesday"]')`), 'Lab drawn on Tuesday');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T27
  await section('T27 existing plan, stored older demo plan, no example wording, layout, routing', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    // Everything a student can see or hear (text, field values, placeholders, labels): none of it says example or sample.
    const uiWords = () => js(`(() => {
      const bits = [document.body.innerText];
      for (const node of document.querySelectorAll('*')) {
        for (const name of ['placeholder', 'aria-label', 'title', 'alt', 'value']) {
          const value = node.getAttribute?.(name);
          if (value) bits.push(value);
        }
        if (node.tagName === 'TEXTAREA' && node.value) bits.push(node.value);
      }
      return bits.join('\\n');
    })()`);
    const screens = ['home', 'start', 'check', 'week', 'rescue', 'feedback', 'settings'];

    // Existing real plan: one observation, the form, then Check, then the reply.
    await fixture(false, false);
    await setWidth(390);
    await go('home');
    await contents('#home-observation', /^You have 3 hours of real slack by Tuesday\.$/);
    assert.equal(await js(`!!document.querySelector('#proposal-form')`), true);
    await fill('#proposal-form', { title: 'Study notes', likely: '1', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^That fits\.$/);
    assert.match(await replyTextValue(), /Yes, I can take on Study notes/);
    assert.equal(await js(`document.querySelector('#availability-prompt')`), null, 'availability exists, so no prompt');
    await click('#check-decisions button', 'Not now');

    // Reload keeps existing data.
    await fixture(false, true);
    await go('week');
    const beforeReload = await persisted();
    await reload();
    assert.deepEqual(await persisted(), beforeReload);
    await contents('#screen-week h1', /What I'm counting\./);

    // No wording about examples or samples anywhere, on any page.
    for (const screen of screens) {
      await go(screen);
      assert.doesNotMatch(await uiWords(), /example|sample/i, `example/sample wording on ${screen}`);
    }
    await go('check');
    await fill('#proposal-form', { title: 'Poster help', likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-lead', /short by Thursday 19 Nov/);
    assert.doesNotMatch(await uiWords(), /example|sample/i, 'example/sample wording on a result');
    await click('#check-decisions button', 'Not now');

    // A plan an older build saved as the fixture is not shown as the student's week, not rewritten on load,
    // and is archived (not deleted) before anything overwrites it.
    await execute(async key => {
      const { makeInitialState } = await import('./src/ui/state.mjs');
      localStorage.removeItem(key + '.archived-example');
      localStorage.setItem(key, JSON.stringify(makeInitialState({ demo: true })));
    }, STORAGE_KEY);
    const rawBefore = await js(`localStorage.getItem('${STORAGE_KEY}')`);
    await reload();
    await go('home');
    await contents('#home-observation', /^Your week is a blank page\.$/);
    await lacks('#screen-home', /DBMS|Thursday|AUV/);
    await contents('#home-timetable', /Add your timetable/);
    assert.equal(await js(`localStorage.getItem('${STORAGE_KEY}')`), rawBefore, 'loading rewrites nothing');
    await go('settings');
    await fill('#name-form', { name: 'Sam' });
    assert.equal(await js(`localStorage.getItem('${STORAGE_KEY}.archived-example')`), rawBefore, 'old plan archived byte for byte');
    assert.equal((await persisted()).demo, false);

    // Layout: no squeezed text or overflow on any page at phone and desktop widths.
    await fixture(false, true);
    for (const width of [360, 390, 1200]) {
      await setWidth(width);
      for (const screen of screens) {
        await go(screen);
        await noOverflow(`${screen} at ${width}`);
        await noSqueeze(`${screen} at ${width}`);
      }
    }
    for (const [width, min] of [[390, 300], [1200, 300]]) {
      await setWidth(width);
      await go('week');
      assert.ok(await js(`document.querySelector('#week-verdict').getBoundingClientRect().width`) >= min, `week verdict width at ${width}`);
    }
    await setWidth(390);
    await go('week');
    assert.equal(await js(`[...document.querySelectorAll('.wg-col')].filter(n => n.getClientRects().length).length`), 1);
    await click('.daystrip-day', 'Thu');
    await contents('.wg-col.is-selected', /./).catch(() => {});
    assert.match(await js(`document.querySelector('.wg-col.is-selected').getAttribute('aria-label')`), /Thursday/);
    await setWidth(1200);
    assert.equal(await js(`[...document.querySelectorAll('.wg-col')].filter(n => n.getClientRects().length).length`), 7);
    await setWidth(360);

    // Review leads with the completion log; Settings keeps deletion apart; Review and Settings are reachable from My week.
    await go('feedback');
    assert.equal(await js(`document.querySelector('#sleep-details').open`), false);
    assert.ok(await js(`document.querySelector('#completion-form').getClientRects().length > 0`));
    await go('settings');
    assert.ok(await js(`!!document.querySelector('.danger-zone #clear')`));
    await go('week');
    await click('#link-review');
    await contents('#screen-feedback h1', /What my yeses cost\./);
    await go('week');
    await click('#link-settings');
    await contents('#screen-settings h1', /Settings/);

    // Links and the browser back button move between pages.
    await go('check');
    await go('week');
    await js('history.back()');
    await retry(async () => assert.equal(await js(`document.getElementById('screen-check').hidden`), false));
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await js(`localStorage.removeItem('${STORAGE_KEY}.archived-example')`);
  });

  // ---------------------------------------------------------------- T28
  await section('T28 prominence: Home links, See what\'s booked round trip, learned estimate line, Past estimates', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);

    // Home: View my week sits under the form; an at-risk deadline is named once and opens Reset. Reset is not in the top bar.
    await fixture(false, true);
    await go('home');
    await contents('#home-observation', /^Your ML Assignment, AUV Club Poster and 1 more are due Thursday 19 Nov and you're 2 hours short\.$/);
    assert.equal(await js(`document.querySelectorAll('#home-observation').length`), 1, 'named once');
    assert.equal(await js(`(() => { const form = document.querySelector('#proposal-form'); const link = document.querySelector('#home-week'); return !!(form.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) && link.textContent.trim() === 'View my week'; })()`), true);
    assert.deepEqual(await js(`[...document.querySelectorAll('.topbar a')].map(a => a.textContent.trim()).filter(Boolean)`), ['The 25th Hour', 'My week']);
    await click('#home-reset');
    await contents('#screen-rescue h1', /It's a lot right now\./);
    await contents('#screen-rescue .eyebrow', /LET'S RESET/);
    await go('home');
    await click('#home-week');
    await contents('#screen-week h1', /What I'm counting\./);

    // Check -> See what's booked -> fix in My week -> Back to your request: same request, edited reply kept, re-checked.
    await fixture(false, false);
    await go('check');
    await fill('#proposal-form', { title: 'Study notes', likely: '1', deadline: '2026-11-17' });
    await contents('#verdict-headline', /^That fits\.$/);
    await execute(() => {
      const box = document.querySelector('#reply-text');
      box.value = 'My own words: happy to help.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('#see-booked');
    await contents('#screen-week h1', /What I'm counting\./);
    assert.equal(await js('document.activeElement.id'), 'add-busy', 'lands on the busy controls');
    await contents('.return-banner', /You were checking Study notes\./);
    await fill('#week-busy-form', { day: '1', start: '17:00', end: '20:00' });
    await click('#back-to-request');
    await contents('#verdict-lead', /short by Tuesday 17 Nov/);
    await contents('.request-summary', /Study notes · 1h · Tuesday/);
    assert.equal(await replyTextValue(), 'My own words: happy to help.', 'edited reply intact');
    await contents('#reply-flag', /Check this before sending\./);
    assert.equal((await persisted()).proposals.length, 1);

    // Learned estimate: one opt-in line from the estimate-learning API, without opening Past estimates.
    await execute(async key => {
      const { makeInitialState } = await import('./src/ui/state.mjs');
      const base = makeInitialState({ demo: true });
      const entry = (taskId, title) => ({ taskId, title, type: 'lab', estimatedLikely: 4, actualHours: 6, recordedAt: '2026-11-16T12:00', targetDate: '2026-11-17', hardDate: '2026-11-17' });
      localStorage.setItem(key, JSON.stringify({
        ...base, demo: false, setupComplete: true,
        feedback: { tasks: [entry('dbms', 'DBMS Lab'), entry('ml', 'ML Assignment'), entry('poster', 'AUV Club Poster')], sleepReports: [] }
      }));
    }, STORAGE_KEY);
    await reload();
    const expected = await execute(async key => {
      const { buildEstimateProfiles, getEstimateSuggestion } = await import('./src/engine/feedback.mjs');
      const saved = JSON.parse(localStorage.getItem(key));
      return getEstimateSuggestion(buildEstimateProfiles(saved.feedback.tasks).find(profile => profile.type === 'lab'), 4);
    }, STORAGE_KEY);
    assert.ok(expected > 4, 'the engine suggests more than 4h');
    await go('home');
    await fill('#proposal-form', { title: 'Lab write-up', likely: '4' }, false);
    assert.equal(await js(`document.querySelector('#more-options').open`), false, 'More options stays closed');
    await contents('#estimate-suggestion', new RegExp(`Use ${expected}h\\?`));
    assert.equal(await js(`document.querySelector('#proposal-likely').value`), '4', 'never changes the typed hours silently');
    await fill('#proposal-form', { title: 'Lab write-up', likely: '4', deadline: '2026-11-20' });
    await contents('#estimate-line', new RegExp(`Use ${expected}h\\?`));
    await click('#use-learned');
    await retry(async () => assert.equal((await persisted()).proposals[0].likely, expected));
    assert.equal(await js(`document.querySelector('#estimate-line')`), null, 'line goes away once used');
    await contents('.request-summary', new RegExp(`· ${expected}h ·`));
    await click('#check-decisions button', 'Not now');

    // Past estimates is reachable from My week.
    await go('week');
    assert.equal(await js(`document.querySelector('#link-review').textContent.trim()`), 'Past estimates');
    await click('#link-review');
    await contents('#screen-feedback h1', /What my yeses cost\./);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T29
  await section('T29 any commitment: copy, who is waiting (reply or not), My week setup card', async () => {
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await js(`location.hash = ''`);
    await reload();
    await go('home');

    // Copy and framing.
    await contents('#screen-home .card-title', /^What's on the table\?$/);
    assert.equal(await js(`document.querySelector('label[for="proposal-title"]').textContent`), 'What is it?');
    assert.equal(await js(`document.querySelector('#proposal-form button[type=submit]').textContent.trim()`), 'Run the numbers');
    await contents('#audience-choice legend', /Who's waiting on an answer\?/);
    assert.equal(await js(`document.querySelector('#audience-others').checked`), true, 'Someone else is the default');
    assert.equal(await js(`document.querySelector('label[for="audience-self"]').textContent.trim()`), 'Just me');
    assert.equal(await js(`document.querySelector('label[for="audience-others"]').textContent.trim()`), 'Someone else');
    for (const screen of ['home', 'check', 'week', 'rescue', 'feedback', 'settings']) {
      await go(screen);
      assert.doesNotMatch(await js('document.body.innerText'), /Check a request/, `old name on ${screen}`);
    }

    // My week with no work hours: one setup card, no day rows; day rows only after hours exist.
    await go('week');
    await contents('#week-setup', /I can work\s*–?\s*on/);
    assert.equal(await js(`document.querySelectorAll('.wg-col').length`), 0);
    await lacks('#screen-week', /No work hours/);
    assert.equal(await js(`document.querySelectorAll('#week-setup .day-check input').length`), 7);
    await click('#week-hours-save');
    await contents('#week-hours-error', /Tick at least one day/);
    await click('#week-hours-weekdays');
    await click('#week-hours-save');
    await retry(async () => assert.equal(await js(`document.querySelector('#week-setup')`), null));
    assert.deepEqual((await persisted()).settings.weeklyWorkWindows[1], [['16:00', '20:00']]);
    assert.ok(await js(`document.querySelectorAll('.wg-col').length`) >= 7, 'day rows appear once hours exist');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);

    // Just me: verdict and verified option only, no reply slip. Someone else: the reply slip as before.
    await fixture(false, false);
    await go('home');
    await click('#audience-self');
    await fill('#proposal-form', { title: 'Gym class', likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-lead', /short by Thursday 19 Nov/);
    await contents('#check-option', /One verified option/);
    assert.equal(await js(`document.querySelector('#reply-slip')`), null, 'no reply slip for just me');
    assert.equal(await js(`document.querySelector('#smaller-offer')`), null);
    assert.equal((await persisted()).proposals[0].audience, 'self');
    await click('#edit-request');
    assert.equal(await js(`document.querySelector('#audience-self').checked`), true, 'edit keeps the choice');
    await click('#audience-others');
    await execute(() => document.querySelector('#proposal-form').requestSubmit());
    await retry(async () => assert.ok(await js(`!!document.querySelector('#reply-slip')`)));
    assert.equal((await persisted()).proposals[0].audience, 'others');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
  });

  // ---------------------------------------------------------------- T30
  await section('T30 phase 1: Home hero and week strip, Recent checks, first run', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await js(`location.hash = ''`);
    await reload();
    await go('home');

    // Fresh: greeting from the clock, an honest blank-page hero, a setup card that never blocks the form, empty Recent checks.
    const eyebrow = await execute(async () => (await import('./src/ui/home-model.mjs')).greetingEyebrow(new Date(), ''));
    assert.equal(await text('#home-eyebrow'), eyebrow);
    assert.match(eyebrow, /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY) (MORNING|AFTERNOON|EVENING|NIGHT)$/);
    await contents('#home-observation', /^Your week is a blank page\.$/);
    assert.ok(await js(`!!document.querySelector('#firstrun-card')`));
    assert.ok(await js(`!!document.querySelector('#proposal-form')`), 'Home is never blocked behind setup');
    assert.equal(await js(`document.querySelector('.recent-list')`), null);
    await contents('#recent-checks .voice-line', /Nothing checked yet/);

    // First run: sleep, work hours, classes; each step saves through the existing validation.
    await click('#firstrun-start');
    await contents('#start-title', /First, when do you sleep\?/);
    await contents('#sleep-summary', /8 hours protected every night\./);
    await click('#sleep-start-less');
    await contents('#sleep-start-value', /10:30 pm/);
    await contents('#sleep-summary', /8\.5 hours protected/);
    await click('#start-next');
    assert.equal((await persisted()).sleep.start, '22:30');
    await contents('#start-title', /When can you actually work\?/);
    assert.equal(await js(`document.querySelectorAll('#start-days .chip[aria-pressed="true"]').length`), 5);
    await click('#start-day-6');
    await click('#work-from-more');
    await contents('#work-from-value', /4:30 pm/);
    await contents('#work-summary', /6 days, 4:30 pm to 8:00 pm\. About 21 hours a week\./);
    await click('#start-next');
    let saved = await persisted();
    assert.deepEqual(saved.settings.weeklyWorkWindows[1], [['16:30', '20:00']]);
    assert.deepEqual(saved.settings.weeklyWorkWindows[6], [['16:30', '20:00']]);
    assert.deepEqual(saved.settings.weeklyWorkWindows[0], []);
    await contents('#start-title', /Now bring your classes\./);
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261117T100000\nDTEND:20261117T120000\nSUMMARY:Lecture\nEND:VEVENT\nEND:VCALENDAR';
    await execute(value => {
      const files = new DataTransfer();
      files.items.add(new File([value], 'timetable.ics', { type: 'text/calendar' }));
      const input = document.querySelector('#start-calendar-file');
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, ics);
    await contents('.option-tile.is-ready', /Timetable imported/);
    assert.deepEqual((await persisted()).days[1].busyWindows, [['10:00', '12:00']]);
    await noOverflow('first run');
    await noSqueeze('first run');
    await click('#start-home');
    await contents('#screen-home', /Run the numbers/);
    assert.equal(await js(`document.querySelector('#firstrun-card')`), null, 'setup card goes away once hours exist');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);

    // Skipping setup returns to Home at any step.
    await reload();
    await go('start');
    await click('#start-skip');
    await retry(async () => assert.equal(await js(`document.getElementById('screen-home').hidden`), false));

    // Existing plan: the strip is computed from the plan (coral only where over), and Recent checks come from decisions.
    await fixture(false, true);
    await go('home');
    assert.equal(await js(`document.querySelectorAll('#week-strip .wk-col').length`), 7);
    assert.ok(await js(`document.querySelectorAll('#week-strip .wk-used.is-over').length`) >= 1, 'over day shown in coral');
    await contents('#home-adds-up, #home-reset', /See what can move/);
    await fixture(false, false);
    await go('home');
    assert.equal(await js(`document.querySelectorAll('#week-strip .wk-used.is-over').length`), 0);
    await contents('#home-observation', /^You have 3 hours of real slack by Tuesday\.$/);
    await contents('#home-adds-up', /See how it adds up/);
    await fill('#proposal-form', { title: 'Club poster', likely: '1', deadline: '2026-11-20' });
    await click('#check-decisions button', 'Not now');
    await go('home');
    await fill('#proposal-form', { title: 'Lab write-up', likely: '1', deadline: '2026-11-20' });
    await go('home');
    await contents('#recent-checks .recent-row:nth-child(1)', /Lab write-up.*1 hour · asked by someone else.*Still deciding/s);
    await contents('#recent-checks .recent-row:nth-child(2)', /Club poster.*Said no/s);
    await go('check');
    await execute(() => [...document.querySelectorAll('#check-decisions button')].find(node => /^Add it/.test(node.textContent.trim())).click());
    await go('home');
    await contents('#recent-checks .recent-row:nth-child(1)', /Lab write-up.*Said yes/s);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T31
  await section('T31 phase 2: verdict hero, bar, tabs, copy label, Just me, motion', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await fixture(false, false);
    await go('home');

    // Short: Not yet. One plain sentence with the real shortfall, a bar from the engine run, one verified option.
    await fill('#proposal-form', { title: 'Poster help', likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-headline', /^Not yet\.$/);
    assert.equal(await js(`getComputedStyle(document.querySelector('#verdict-headline')).fontSize`), '56px', 'the verdict is the largest text');
    assert.equal(await js(`getComputedStyle(document.querySelector('#verdict-headline')).fontFamily.includes('Palatino')`), true, 'serif');
    await contents('#verdict-lead', /^You're 1 hour short by Thursday 19 Nov\.$/);
    assert.equal(await js(`document.querySelector('#fit-bar').getAttribute('aria-label')`), '4 hours needed, 3 hours free before Thursday, 1 hour short.');
    await contents('#fit-bar', /Time from now until Thursday.*3 hours free.*Fits: 3 hours.*Short: 1 hour.*Your free time ends here/s);
    await contents('#check-option', /ONE VERIFIED OPTION|One verified option/i);
    await contents('#other-ways', /Other ways to make room/);
    assert.equal(await js(`document.querySelectorAll('.rise').length > 0`), true, 'verdict rises in on a fresh check');
    // Tabs: only verified replies. Switching a tab does not replay the animation.
    assert.equal(await js(`[...document.querySelectorAll('.slip-tab')].map(t => t.textContent).join('|')`), 'Yes, if|More time|Kind no');
    await click('#tab-no');
    assert.equal(await js(`document.querySelectorAll('.rise').length`), 0);
    assert.match(await replyTextValue(), /can't take it on by Thursday 19 Nov/);
    // Copy: only copies; the label confirms.
    const before = await persisted();
    await click('#copy-reply');
    await retry(async () => assert.equal(await text('#copy-reply'), 'Copied. Go send it.'));
    assert.deepEqual(await persisted(), before);
    // Reduced motion: no animation at all.
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Poster help', likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-headline', /^Not yet\.$/);
    assert.equal(await js(`getComputedStyle(document.querySelector('#fit-bar .fitbar-ok')).animationName`), 'none');
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    // Fits: Yes / Kind no; a plain bar with no coral.
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Study notes', likely: '1', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^That fits\.$/);
    assert.equal(await js(`[...document.querySelectorAll('.slip-tab')].map(t => t.textContent).join('|')`), 'Yes|Kind no');
    assert.equal(await js(`document.querySelectorAll('.fitbar-short').length`), 0);
    await contents('#fit-bar', /Fits: 1 hour/);

    // No verified option: honest wording, Kind no and a flexibility request (no date promised).
    await click('#edit-request');
    await fill('#proposal-form', { title: 'Huge project', likely: '20', deadline: '2026-11-17' });
    await contents('#check-option', /No change makes this fit/);
    assert.equal(await js(`[...document.querySelectorAll('.slip-tab')].map(t => t.textContent).join('|')`), 'Kind no|Ask for flexibility');

    // Just me: no slip, the verdict and option stay, and a primary add action.
    await click('#who-self');
    await retry(async () => assert.equal(await js(`document.querySelector('#reply-slip')`), null));
    await contents('#verdict-headline', /^Not yet\.$/);
    await contents('#self-text', /Nobody to answer, so this is just between you and the numbers\./);
    assert.equal(await js(`document.querySelector('#check-decisions .button-primary').textContent.trim()`), 'Say yes anyway');
    assert.equal((await persisted()).proposals[0].audience, 'self');
    await click('#who-others');
    await retry(async () => assert.ok(await js(`!!document.querySelector('#reply-slip')`)));
    await noOverflow('verdict');
    await noSqueeze('verdict');
    await setWidth(1200);
    await noOverflow('verdict desktop');
    await noSqueeze('verdict desktop');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T32
  await section('T32 phase 3: My week agenda cards, Reset answers for the pending request', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);
    await fixture(false, false);

    // My week: heading, one selected day card with BUSY / DEADLINE WORK and "free Nh", protected sleep row.
    await go('week');
    await contents('#screen-week h1', /^What I'm counting\.$/);
    await click('.daystrip-day', 'Tue');
    await contents('.wg-head.is-selected', /Tue\s*17\s*\d+(\.\d)?h free/);
    await contents('.wg-col.is-selected', /Deadline work/);
    await contents('.wg-col.is-selected .wg-sleep', /Sleep from 11:00 pm/);
    await fill('#week-busy-form', { day: '1', start: '10:00', end: '12:00', title: 'Lecture' });
    await contents('.wg-col.is-selected', /Lecture/);
    await contents('#busy-panel', /1 block you added/);
    await click('.wg-col.is-selected .wg-busy', 'Lecture');
    await click('#block-remove');
    await retry(async () => assert.deepEqual((await persisted()).days[1].busyWindows, []));
    assert.deepEqual((await persisted()).busyLabels, {}, 'the label goes with the block');
    await noSqueeze('week agenda');

    // Reset for a request that does not fit: verified ways to make room for it, applied only by an explicit button.
    await go('home');
    await fill('#proposal-form', { title: 'Poster help', likely: '4', deadline: '2026-11-19', tag: 'flexible' });
    await contents('#verdict-headline', /^Not yet\.$/);
    await click('#other-ways');
    await contents('#screen-rescue h1', /Making room for Poster help\./);
    await contents('#reset-lead', /With it, you'd be 1 hour short by Thursday 19 Nov\./);
    await contents('#reset-lead', /You can do this yourself/);
    assert.equal((await persisted()).tasks.some(task => task.title === 'Poster help'), false, 'nothing added by looking');
    await click('#apply-lead');
    await retry(async () => assert.ok((await persisted()).tasks.some(task => task.title === 'Poster help')));
    assert.equal((await persisted()).proposals.length, 0);
    assert.equal((await persisted()).appliedChanges.length, 1, 'a supported, undoable change');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T33
  await section('T33 phase 4: What my yeses cost, log first, insight only with 3 samples, ledger, Settings groups', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);
    await fixture(false, true);
    await go('feedback');
    await contents('#screen-feedback h1', /^What my yeses cost\.$/);
    await contents('#screen-feedback .eyebrow', /PAST ESTIMATES/);
    // Log first: a stepper and "Log it"; no insight and no ledger with nothing logged.
    assert.ok(await js(`document.querySelector('#log-it').getClientRects().length > 0`));
    assert.equal(await js(`document.querySelector('#insight-card')`), null);
    assert.equal(await js(`document.querySelector('#ledger')`), null);
    assert.equal(await js(`document.querySelector('#sleep-details').open`), false);
    assert.equal(await js(`document.querySelector('#history-details').open`), false);
    const guess = await text('#log-guess');
    assert.match(guess, /^You guessed \d+(\.\d)?h\.$/);
    await click('#log-more');
    // Log through the stepper, then see how it went, and undo it with Change it.
    await click('#log-it');
    await contents('#logged-card', /LOGGED.*(longer than you guessed|Quicker than you guessed|Right on your guess)/s);
    await contents('#logged-card', /Saved on this device\./);
    assert.equal((await persisted()).feedback.tasks.length, 1);
    await contents('#ledger', /The ledger/);
    assert.equal(await js(`document.querySelector('#insight-card')`), null, 'one sample is not an insight');
    // Three more of one type via the existing form fields; the third makes the insight appear.
    const firstId = (await persisted()).feedback.tasks[0].taskId;
    const others = ['dbms', 'ml', 'poster', 'french'].filter(id => id !== firstId).slice(0, 3);
    for (const [i, taskId] of others.entries()) {
      await fill('#completion-form', { taskId, taskType: 'project', actualHours: '4', recordedAt: `2026-11-1${7 + i}T12:00` });
    }
    await contents('#insight-card', /WHAT I'VE NOTICED.*Your projects run about \d+ minutes (long|short)\./s);
    assert.equal(await js(`document.querySelectorAll('#ledger .ledger-row').length`), 4);
    await contents('#ledger .ledger-row:first-of-type', /Guessed.*Took/s);
    await noOverflow('review');
    await noSqueeze('review');
    await setWidth(1200);
    await noOverflow('review desktop');
    await noSqueeze('review desktop');

    // Settings: grouped (sleep, work hours, preferences, data) with deletion apart.
    await setWidth(390);
    await go('settings');
    assert.deepEqual(await js(`[...document.querySelectorAll('#screen-settings h2')].map(node => node.textContent.trim())`), ['Sleep', 'When can you work?', 'Preferences', 'Your data', 'Delete everything']);
    assert.ok(await js(`!!document.querySelector('.danger-zone #clear')`));
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T34
  await section('T34 phase 5: night theme, and "wait till morning" only when the engine confirms it', async () => {
    const setWidth = width => command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await setWidth(390);
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await fixture(false, false);
    const clockAt = (day, hour, minute) => js(`__setFakeNow(new Date(2026, 10, ${day}, ${hour}, ${minute}).toISOString())`);
    const theme = () => js(`document.documentElement.dataset.theme`);

    // Daytime: day theme, and a fitting request gets the normal "That fits." (never the wait claim).
    assert.equal(await theme(), 'day');
    await go('home');
    await fill('#proposal-form', { title: 'Sponsor deck', likely: '3', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^That fits\.$/);
    await click('#check-decisions button', 'Not now');

    // By Tuesday night, work due Monday or Tuesday is already over: those tasks are not part of this claim.
    await setStorage(`saved.tasks = saved.tasks.filter(task => task.targetDay >= 2);`);
    await reload();
    // Past wind-down (sleep 23:00, so from 22:00): the theme follows the clock, independent of any advice.
    await clockAt(17, 21, 59);
    await go('home');
    assert.equal(await theme(), 'day');
    await clockAt(17, 23, 20);
    await go('check');
    await go('home');
    assert.equal(await theme(), 'night');
    assert.equal(await js(`getComputedStyle(document.body).backgroundColor`), 'rgb(35, 27, 23)');
    await fill('#proposal-form', { title: 'Sponsor deck', likely: '3', deadline: '2026-11-20' });
    // Verified by an engine run with nothing starting before Wednesday morning: this can wait.
    await contents('#verdict-headline', /^This can wait till morning\.$/);
    await contents('.vhero-eyebrow', /^11:20 PM · PAST YOUR WIND-DOWN$/);
    await contents('#verdict-lead', /Sponsor deck isn't due until Friday, and Wednesday, Thursday and Friday have room to spare\. Nothing gets better by doing it now\./);
    await contents('#fit-bar', /Wednesday, Thursday and Friday.*hours? free.*Sponsor deck needs 3 hours\. It fits, with .* to spare\./s);
    assert.match(await replyTextValue(), /come back to you tomorrow morning\./);
    const before = await persisted();
    await click('#copy-reply');
    await retry(async () => assert.equal(await text('#copy-reply'), 'Copied. Now go to sleep.'));
    assert.deepEqual(await persisted(), before, 'copying changes nothing');
    await noOverflow('night');
    await noSqueeze('night');
    // The full answer is one tap away.
    await click('#show-full');
    await contents('#verdict-headline', /^(That fits\.|Close call\.)$/); // Mon and Tue are over, so only Wed-Fri count
    await click('#check-decisions button', 'Not now');

    // Not confirmed: due Thursday, but starting Wednesday morning would not fit. The normal verdict shows instead.
    await go('home');
    await fill('#proposal-form', { title: 'Poster', likely: '3', deadline: '2026-11-19' });
    await retry(async () => assert.notEqual(await text('#verdict-headline'), ''));
    assert.doesNotMatch(await text('#verdict-headline'), /wait till morning/i);
    await contents('#verdict-headline', /^(Not yet\.|Close call\.|That fits\.)$/);
    await click('#check-decisions button', 'Not now');

    // Just me: no holding reply.
    await go('home');
    await click('#audience-self');
    await fill('#proposal-form', { title: 'Reading', likely: '2', deadline: '2026-11-20' });
    await contents('#verdict-headline', /^This can wait till morning\.$/);
    assert.equal(await js(`document.querySelector('#reply-slip')`), null);
    await click('#check-decisions button', 'Not now');

    // Morning again: day theme.
    await clockAt(18, 8, 0);
    await go('check');
    await go('home');
    assert.equal(await theme(), 'day');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T35
  await section('T35 calendar import: names and rooms, no "null", real free hours, time grid at 1440 and 390', async () => {
    const setWidth = (width, height = 900) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const classes = [
      ['20261116T114000', '20261116T123000', 'ZZ101 Object Oriented Programming', 'ELT 3'],
      ['20261116T124000', '20261116T133000', 'ZZ102 Machine Learning', 'ELT 4'],
      ['20261117T083000', '20261117T102000', 'ZZ103 Programming Workshop', 'IT block 2']
    ];
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...classes.flatMap(([a, b, name, room]) => [
      'BEGIN:VEVENT', `DTSTART;TZID=Asia/Kolkata:${a}`, `DTEND;TZID=Asia/Kolkata:${b}`, 'RRULE:FREQ=WEEKLY;COUNT=2', `SUMMARY:${name}`, `LOCATION:${room}`, 'END:VEVENT']),
      'END:VCALENDAR'].join('\r\n');
    const icsPath = join(profile, 'timetable.ics');
    await writeFile(icsPath, ics);
    await setWidth(1440);
    await fixture(false, false);
    await setStorage(`saved.tasks = []; saved.proposals = []; saved.busyLabels = {}; saved.days.forEach((day, i) => { day.busyWindows = []; day.workWindows = i % 7 < 5 ? [['09:00', '21:00']] : []; });`);
    await reload();
    await go('week');
    const doc = await command('DOM.getDocument', { depth: -1 });
    const input = await command('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#calendar-file' });
    await command('DOM.setFileInputFiles', { files: [icsPath], nodeId: input.nodeId });
    await contents('#import-message', /Imported 6 busy window\(s\)\./);
    await lacks('#import-message', /null/);
    await lacks('#busy-panel', /null/);
    // Every class shows its name and its room, never the bare word "Busy".
    const blocks = await js(`[...document.querySelectorAll('.wg-busy')].map(n => n.innerText.replace(/\\s+/g, ' ').trim())`);
    assert.ok(blocks.some(text => /ZZ101 Object Oriented Programming ELT 3 11:40 am to 12:30 pm/.test(text)), JSON.stringify(blocks));
    assert.ok(blocks.some(text => /ZZ103 Programming Workshop IT block 2/.test(text)));
    assert.ok(blocks.every(text => !/^Busy\b.*Busy/i.test(text)), 'the word Busy is not doubled');
    // Desktop: seven day columns, hours on the left, free bands labelled, and nothing overlapping.
    assert.equal(await js(`[...document.querySelectorAll('.wg-col')].filter(n => n.getClientRects().length).length`), 7);
    assert.ok(await js(`document.querySelector('.wg-axis').innerText.includes('8 am')`));
    assert.match(await js(`document.querySelector('.wg-free').getAttribute('aria-label')`), /Free to work \d+:\d\d to \d+:\d\d (am|pm)?.*, \d+(\.\d)?h/);
    const overlaps = await js(`(() => {
      const bad = [];
      for (const col of document.querySelectorAll('.wg-col')) {
        const boxes = [...col.querySelectorAll('.wg-busy, .wg-free, .wg-work')].map(n => ({ n, r: n.getBoundingClientRect() }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r;
          if (a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(boxes[i].n.className + ' x ' + boxes[j].n.className);
        }
      }
      return bad;
    })()`);
    assert.deepEqual(overlaps, [], 'no two blocks share the same minutes in a day');
    assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true, 'no sideways scroll at 1440');
    // Free hours equal work window minus busy blocks minus sleep minus planned work, per day, and are not all the same.
    const free = await js(`[...document.querySelectorAll('.free-table tbody tr')].map(tr => [...tr.children].map(c => c.textContent))`);
    for (const [, window, past, busy, sleep, planned, left] of free) {
      const n = value => Number(value.replace(/[^0-9.]/g, ''));
      assert.ok(Math.abs(n(window) - n(past) - n(busy) - n(sleep) - n(planned) - n(left)) < 0.11, JSON.stringify([window, past, busy, sleep, planned, left]));
    }
    const heads = await js(`[...document.querySelectorAll('.wg-dayfree')].map(n => n.textContent)`);
    assert.ok(new Set(heads.slice(0, 3)).size > 1, `weekday free hours differ with the classes: ${heads}`);
    await contents('#week-total', /\d+(\.\d)? free hours this week/);
    // Phone: one day as a vertical timeline.
    await setWidth(390, 844);
    assert.equal(await js(`[...document.querySelectorAll('.wg-col')].filter(n => n.getClientRects().length).length`), 1);
    assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true, 'no sideways scroll at 390');
    await click('.wg-busy', 'ZZ101');
    await contents('#block-detail', /ZZ101 Object Oriented Programming/);
    // Home: the hero follows real free time and the strip shows per-day hours.
    await go('home');
    assert.doesNotMatch(await text('#screen-home'), /null/);
    assert.match(await text('.weekstrip-hours'), /\d/);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T36
  await section('T36 add a busy block: day chips, empty-spot click, weekly repeat, past days not blocked', async () => {
    const setWidth = (width, height = 900) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await setWidth(1440);
    await fixture(false, false);
    await setStorage(`saved.tasks = []; saved.proposals = []; saved.busyLabels = {}; saved.days.forEach((day, i) => { day.busyWindows = []; day.workWindows = i % 7 < 5 ? [['09:00', '21:00']] : []; });`);
    await reload();
    await go('week');
    // Clicking an empty spot in Wednesday's column at about 10:10 opens the form for Wednesday at 10:00.
    await execute(() => {
      const col = document.querySelectorAll('.wg-col')[2];
      const rect = col.getBoundingClientRect();
      const base = 8;
      const y = rect.top + (rect.height / document.querySelector('#week-grid').style.getPropertyValue('--rows')) * (10 + 10 / 60 - base);
      col.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 10, clientY: y }));
    });
    await retry(async () => assert.equal(await js(`document.querySelector('#week-busy-form').hidden`), false));
    assert.equal(await js(`document.querySelector('#week-busy-day').value`), '2');
    assert.equal(await js(`document.querySelector('#week-busy-start').value`), '10:00');
    assert.equal(await js(`document.querySelector('#week-busy-end').value`), '11:00');
    assert.equal(await js(`document.querySelectorAll('.busy-day-chip').length`), 7, 'Mon to Sun chips');
    assert.equal(await js(`[...document.querySelectorAll('.busy-day-chip')].filter(n => n.disabled).length`), 0, 'no day is disabled');
    assert.equal(await js(`document.querySelector('.busy-day-chip[aria-pressed="true"]').textContent`), 'Wed');
    assert.equal(await js('document.activeElement.id'), 'week-busy-title');
    // Pick another day with a chip, name it, repeat weekly.
    await click('.busy-day-chip', 'Thu');
    assert.equal(await js(`document.querySelector('#week-busy-day').value`), '3');
    await execute(() => { const box = document.querySelector('#week-busy-repeat'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); });
    await contents('#week-busy-form .busy-add', /Add to Thu, every week/);
    await execute(() => { const t = document.querySelector('#week-busy-title'); t.value = 'Choir'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await execute(() => document.querySelector('#week-busy-form').requestSubmit());
    await retry(async () => {
      const saved = await persisted();
      const thursdays = saved.days.map((day, i) => [i, day.busyWindows]).filter(([, w]) => w.length).map(([i]) => i);
      assert.deepEqual(thursdays, [3, 10, 17, 24, 31]);
    });
    assert.ok(await js(`!!document.querySelector('.wg-busy[aria-label*="Choir"]')`), 'the new block is drawn');
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T37
  await section('T37 added tasks: Undo on the banner, Remove with one-tap confirm, gone after reload', async () => {
    const setWidth = (width, height = 900) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await setWidth(1440);
    await fixture(false, false);
    await setStorage(`saved.tasks = []; saved.proposals = []; saved.decisions = []; saved.days.forEach((day, i) => { day.busyWindows = []; day.workWindows = i % 7 < 5 ? [['09:00', '21:00']] : []; });`);
    await reload();
    const addTask = async title => {
      await go('home');
      await fill('#proposal-form', { title, likely: '2', deadline: '2026-11-20', tag: 'flexible' });
      await contents('#verdict-headline', /That fits\./);
      await click('button', 'Add it to my week');
      await contents('#status-region', /Added/);
      await lacks('#status-region', /null/);
    };
    // Add, then undo from the banner.
    await addTask('Stale deck');
    assert.equal((await persisted()).tasks.length, 1);
    await click('#notice-undo');
    await retry(async () => assert.equal((await persisted()).tasks.length, 0));
    await contents('#status-region', /Removed "Stale deck"/);
    assert.equal(await js(`document.querySelector('#notice-undo')`), null, 'no Undo on the removal notice');
    // Add another and remove it from the list: first tap asks, second tap removes.
    await addTask('Mistaken report');
    await go('week');
    await contents('#todo-panel', /Mistaken report/);
    assert.ok(await js(`document.querySelectorAll('.wg-work').length`) > 0, 'the grid shows the added work');
    await click('.todo-remove', '');
    await contents('#todo-panel', /Yes, remove/);
    assert.equal((await persisted()).tasks.length, 1, 'asking does not remove');
    await click('.todo-keep');
    await contents('#todo-panel', /Mistaken report/);
    await click('.todo-remove', '');
    await click('.todo-yes');
    await retry(async () => assert.equal((await persisted()).tasks.length, 0));
    await lacks('#todo-panel', /Mistaken report/);
    assert.equal(await js(`document.querySelectorAll('.wg-work').length`), 0, 'the grid no longer shows its work');
    // Both gone after a reload, and the record of the yeses went with them.
    await reload();
    await go('week');
    await lacks('#todo-panel', /Mistaken report|Stale deck/);
    assert.deepEqual((await persisted()).tasks, []);
    assert.deepEqual((await persisted()).decisions, []);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T38
  await section('T38 elapsed time: not free, labelled Past, never stored, same numbers everywhere', async () => {
    const setWidth = (width, height = 900) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await setWidth(1440);
    await fixture(false, false);
    // Mon-Fri evenings 18:00-21:00, 18:00-19:30 busy each day: 1.5h free a day. The clock is Wed 18 Nov 11:00.
    await setStorage(`saved.tasks = []; saved.proposals = []; saved.decisions = []; saved.busyLabels = {};
      saved.days.forEach((day, i) => { day.workWindows = i % 7 < 5 ? [['18:00', '21:00']] : []; day.busyWindows = i % 7 < 5 ? [['18:00', '19:30']] : []; });`);
    await reload();
    await js(`__setFakeNow(new Date(2026, 10, 18, 11, 0).toISOString())`);
    const storedBefore = await js(`localStorage.getItem('${STORAGE_KEY}')`);
    await go('home');
    // Home: Mon and Tue are over, so the strip says Past and the free hours are only what is ahead.
    assert.match(await text('.weekstrip-hours'), /Past\s*Past\s*1\.5h/);
    // 2h due Wednesday: Wed evening has 1.5h, Mon and Tue do not count, so it does not fit.
    await fill('#proposal-form', { title: 'Mentor meeting', likely: '2', deadline: '2026-11-18', tag: 'flexible' });
    await contents('#verdict-headline', /^Not yet\.$/);
    await contents('#fit-bar', /Time from now until Wednesday.*1\.5 hours free/s);
    assert.equal(await js(`localStorage.getItem('${STORAGE_KEY}').includes('"elapsed"')`), false);
    await click('#check-decisions button', 'Not now');
    // 1.5h does fit.
    await go('home');
    await fill('#proposal-form', { title: 'Short one', likely: '1.5', deadline: '2026-11-18', tag: 'flexible' });
    await contents('#verdict-headline', /^(That fits\.|Close call\.)$/);
    await click('#check-decisions button', 'Not now');
    // A deadline before today is said plainly.
    await go('home');
    await execute(() => {
      const form = document.querySelector('#proposal-form');
      form.elements.namedItem('title').value = 'Old one';
      form.elements.namedItem('likely').value = '1';
      form.elements.namedItem('deadline').value = '2026-11-16';
      form.requestSubmit();
    });
    await contents('#screen-home', /That was due in the past/);
    // My week: Mon and Tue hatched and labelled Past, no synthetic Busy blocks, past days do not say "1.5h free".
    await go('week');
    const heads = await js(`[...document.querySelectorAll('.wg-head')].map(n => n.innerText.replace(/\\s+/g, ' ').trim())`);
    assert.match(heads[0], /Past$/);
    assert.match(heads[1], /Past$/);
    assert.match(heads[2], /1\.5h free$/);
    assert.equal(await js(`document.querySelectorAll('.wg-past').length`) >= 3, true, 'two whole days plus today until now');
    assert.equal(await js(`document.querySelectorAll('.wg-busy').length`), 5, 'only the five real evening blocks, no synthetic Busy');
    assert.match(await js(`document.querySelector('.wg-past').textContent`), /Past/);
    // Nothing synthetic persisted: the plan is byte-identical apart from the proposals the checks added and discarded.
    const stored = JSON.parse(await js(`localStorage.getItem('${STORAGE_KEY}')`));
    assert.deepEqual(stored.days, JSON.parse(storedBefore).days, 'days are untouched by checking');
    await reload();
    assert.equal(await js(`/"elapsed"|\\["00:00","24:00"\\]/.test(localStorage.getItem('${STORAGE_KEY}'))`), false);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
  });

  // ---------------------------------------------------------------- T39
  await section('T39 form -> verdict -> cost -> week: one shortfall everywhere, nothing after the deadline, no blank form', async () => {
    const setWidth = (width, height = 900) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await setWidth(1440);
    await fixture(false, false);
    // Mon-Fri evenings 18:00-21:00; Mon-Thu are fully busy then, so Friday's 3h is all there is before Friday ends. Weekend is wide open.
    await setStorage(`saved.tasks = []; saved.proposals = []; saved.decisions = []; saved.busyLabels = {};
      saved.days.forEach((day, i) => { const d = i % 7; day.workWindows = d < 5 ? [['18:00', '21:00']] : d < 7 ? [['09:00', '21:00']] : [];
        day.busyWindows = d < 4 ? [['18:00', '21:00']] : []; });`);
    await reload();
    const number = value => Number(/(\d+(?:\.\d+)?)/.exec(value)[1]);
    await go('home');
    // 1. The form: new copy.
    await contents('#screen-home .card-title', /^What's on the table\?$/);
    assert.equal(await js(`document.querySelector('#proposal-form button[type=submit]').textContent.trim()`), 'Run the numbers');
    await fill('#proposal-form', { title: 'Report', likely: '4', deadline: '2026-11-20', tag: 'flexible', latestDate: '2026-11-22' });
    // 2. The verdict says 1 hour short.
    await contents('#verdict-headline', /^Not yet\.$/);
    const verdict = number(await text('#verdict-lead'));
    await contents('#fit-bar', /Short: 1 hour/);
    assert.equal(verdict, 1);
    await contents('#range-sentence', /^\d+(\.\d)?h (fits|is [\d.]+h short)\./);
    assert.equal(await js(`document.querySelector('#check-decisions').innerText.includes('Say yes anyway')`), true);
    await contents('#check-decisions', /It goes on your week and the gap stays visible\. It never takes sleep\./);
    // 3. "Say yes anyway" lands on the cost screen and saves nothing yet.
    await click('#check-decisions button', 'Say yes anyway');
    await contents('#cost-headline', /^1 hour short by Friday\.$/);
    await contents('#screen-cost .vhero-eyebrow', /^WHAT THIS YES COSTS$/);
    await contents('#cost-lines', /It uses all 3h of your free time until Friday\./);
    await contents('#cost-lines', /Sleep stays protected \(23:00-07:00\), so the shortfall lands on the deadline\./);
    await lacks('#cost-lines', /squeezed/);
    assert.equal(number(await text('#cost-headline')), verdict);
    await contents('#fit-bar', /Short: 1 hour/);
    await contents('#cost-close', /Ask for 1h more time, or offer a smaller version\.|One|change|Move|Shift/i);
    assert.equal(await js(`!!document.querySelector('#reply-slip')`), true, 'the same editable reply slip');
    assert.equal((await persisted()).tasks.length, 0, 'nothing is saved yet');
    assert.equal(await js('location.hash'), '#/cost');
    await noOverflow('cost');
    // 4. "Put it on my week" saves, lands on My week, with the toast and Undo.
    await click('#cost-put');
    await contents('#status-region', /^On your week\. 1h is still short by Friday\./);
    assert.ok(await js(`!!document.querySelector('#notice-undo')`));
    assert.equal(await js('location.hash'), '#/week');
    assert.equal(await js(`!!document.querySelector('#proposal-form')`), false, 'never the blank form');
    assert.equal((await persisted()).tasks.length, 1);
    // 5. My week: the same 1h, once, at the end of Friday above the sleep band; no work after the deadline.
    const week = number((await text('#week-verdict')).match(/Short by [\d.]+h/)[0]);
    assert.equal(week, verdict);
    assert.equal(await js(`document.querySelectorAll('.wg-short').length`), 1, 'one marker');
    assert.match(await text('.wg-short'), /^Short by 1h$/);
    assert.equal(number(await text('.wg-short')), verdict);
    const heads = await js(`[...document.querySelectorAll('.wg-head')].map(n => n.innerText.replace(/\\s+/g, ' ').trim())`);
    assert.match(heads[4], /1h short/);
    assert.doesNotMatch(heads[4], /0h free/);
    for (const index of [5, 6]) {
      assert.equal(await js(`document.querySelectorAll('.wg-col')[${index}].querySelectorAll('.wg-work').length`), 0, `no work after the deadline on day ${index}`);
    }
    const geometry = await js(`(() => {
      const col = document.querySelectorAll('.wg-col')[4];
      const short = col.querySelector('.wg-short').getBoundingClientRect();
      const sleep = col.querySelector('.wg-sleep').getBoundingClientRect();
      return { shortBottom: short.bottom, sleepTop: sleep.top };
    })()`);
    assert.ok(geometry.shortBottom <= geometry.sleepTop + 1, `the marker stays above sleep: ${JSON.stringify(geometry)}`);
    assert.equal(await js('document.querySelector("#screen-week").hidden'), false);
    // 6. Reset does not open by itself; it is one tap from the week's "Doesn't fit" card.
    assert.equal(await js('location.hash'), '#/week');
    // 7. Undo from the banner stays on My week, with the task gone.
    await click('#notice-undo');
    await retry(async () => assert.equal((await persisted()).tasks.length, 0));
    assert.equal(await js('location.hash'), '#/week');
    assert.equal(await js(`!!document.querySelector('#proposal-form')`), false, 'undo does not land on the blank form');
    assert.equal(await js(`document.querySelectorAll('.wg-short').length`), 0);
    // 8. "Never mind" goes Home and saves nothing.
    await go('home');
    await fill('#proposal-form', { title: 'Report', likely: '4', deadline: '2026-11-20', tag: 'flexible', latestDate: '2026-11-22' });
    await contents('#verdict-headline', /^Not yet\.$/);
    await click('#check-decisions button', 'Say yes anyway');
    await contents('#cost-headline', /1 hour short/);
    await click('#cost-never');
    await contents('#screen-home .card-title', /^What's on the table\?$/);
    assert.equal(await js('location.hash'), '#/home');
    assert.equal((await persisted()).tasks.length, 0);
    assert.equal((await persisted()).proposals.length, 0);
    // 9. Save again and remove it from the list: still on My week, grid updated.
    await fill('#proposal-form', { title: 'Report', likely: '4', deadline: '2026-11-20', tag: 'flexible', latestDate: '2026-11-22' });
    await click('#check-decisions button', 'Say yes anyway');
    await click('#cost-put');
    await contents('#todo-panel', /Report/);
    await click('.todo-remove', '');
    await click('.todo-yes');
    await retry(async () => assert.equal((await persisted()).tasks.length, 0));
    assert.equal(await js('location.hash'), '#/week');
    assert.equal(await js(`document.querySelectorAll('.wg-short').length`), 0);
    await js(`localStorage.removeItem('${STORAGE_KEY}')`);
    await setWidth(360);
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
