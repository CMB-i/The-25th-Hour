import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8000';
const profile = await mkdtemp(join(tmpdir(),'25th-hour-chromium-'));
const chrome = spawn(process.env.CHROMIUM ?? 'chromium', [
  '--headless','--disable-gpu','--disable-background-networking','--no-first-run',
  '--remote-debugging-port=0',`--user-data-dir=${profile}`, ...(process.env.CHROMIUM_NO_SANDBOX ? ['--no-sandbox'] : []),
  'about:blank'
], {stdio:'ignore'});
let ws;
async function retry(run) {
  let error;
  for (let i = 0; i < 100; i++) {
    try { return await run(); } catch (failure) { error = failure; await delay(50); }
  }
  throw error;
}

try {
  const port = await retry(async () => (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',reject,{once:true});
  });
  const pending = new Map();
  const errors = [];
  const requests = [];
  let messageId = 0;
  const command = (method, params = {}) => new Promise((resolve,reject) => {
    const id = ++messageId;
    pending.set(id,{resolve,reject});
    ws.send(JSON.stringify({id,method,params}));
  });
  ws.addEventListener('message',({data}) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(Error(message.error.message));
      else call.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    if (message.method === 'Page.javascriptDialogOpening') void command('Page.handleJavaScriptDialog',{accept:true});
  });

  const js = async expression => {
    const result = await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const execute = (fn,...args) => js(`(${fn})(...${JSON.stringify(args)})`);
  const text = selector => execute(s => document.querySelector(s).textContent,selector);
  const click = (selector, label) => execute((s,name) => {
    const target = name ? [...document.querySelectorAll(s)].find(b => b.textContent === name) : document.querySelector(s);
    if (!target || target.disabled) throw Error(`Missing or disabled: ${name || s}`);
    target.click();
  },selector,label);
  const submit = (selector, values) => execute((s,entries) => {
    const form = document.querySelector(s);
    for (const [name,value] of Object.entries(entries)) {
      const input = form.elements.namedItem(name);
      input.value = value;
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    form.requestSubmit();
  },selector,values);
  const contents = async (selector, expected) => assert.match(await text(selector),expected);
  const ready = () => retry(async () => assert.notEqual(await text('#verdict h3'),''));
  const upload = content => execute(value => {
    const files = new DataTransfer();
    files.items.add(new File([value],'calendar.ics',{type:'text/calendar'}));
    const input = document.querySelector('#calendar-file');
    input.files = files.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  },content);
  const setStorage = mutate => execute(source => {
    const key = 'the25thhour.v1';
    const saved = JSON.parse(localStorage.getItem(key));
    Function('saved',source)(saved);
    localStorage.setItem(key,JSON.stringify(saved));
  },mutate);
  const persisted = () => js("JSON.parse(localStorage.getItem('the25thhour.v1'))");
  const reload = async () => {
    await command('Page.reload');
    await delay(150);
    await ready();
  };
  await Promise.all(['Runtime','Page','Network','Log'].map(domain => command(domain + '.enable')));
  await command('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:origin});
  await ready();
  assert.ok(requests.every(url => url.startsWith(origin) || url.startsWith('data:')),requests.join('\n'));
  const initialRequests = requests.length;

  await contents('#verdict',/infeasible.*Thursday.*15h.*13h.*2h/s);
  await contents('#verdict',/Weekly hours only \(simulated baseline\).*18h required \/ 20h available/s);
  await contents('#verdict',/Deadline-aware scheduler \(same allocation, no repair step\)/);
  assert.equal(await js("document.querySelector('#verdict').getAttribute('aria-live')"),'polite');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  await contents('#freshness',/may be out of date/);
  await click('#next-week');
  await contents('#week-range',/2026-11-23/);
  await click('#previous-week');
  await click('#repairs article:first-of-type button');
  await contents('#preview',/Repair preview.*fits/s);
  await contents('#verdict h3',/^infeasible$/);
  await click('#preview button','Apply self-serve repair');
  await contents('#verdict h3',/^at-risk$/);
  await click('#undo');
  await contents('#verdict h3',/^infeasible$/);

  await click('#demo-fixed');
  await click('#repairs article:nth-of-type(2) button');
  await contents('#preview',/If approved/);
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  await command('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await click('#preview button','Copy approval request text');
  await retry(() => contents('#notice',/Approval request copied/));
  assert.match(await js('navigator.clipboard.readText()'),/date|deadline.*2026-11-20/i);
  assert.ok(await js("[...document.querySelectorAll('#preview button')].find(b=>b.textContent==='Apply approved repair').disabled"));
  assert.equal((await persisted()).tasks.find(t => t.id === 'poster').hardDay,3);
  await click('#preview button','Mark declined');
  await contents('#preview',/declined/);
  await contents('#verdict h3',/^infeasible$/);
  await click('#preview button','Mark approved');
  assert.equal((await persisted()).tasks.find(t => t.id === 'poster').hardDay,3);
  await click('#preview button','Apply approved repair');
  assert.equal((await persisted()).tasks.find(t => t.id === 'poster').hardDay,4);
  await contents('#verdict h3',/^at-risk$/);

  await click('#include-research');
  await contents('#repairs',/No change needed/);
  await submit('#proposal-form',{title:'Extra project',likely:41,deadline:'2026-11-19'});
  await contents('#proposal-error',/Typical hours/);
  await submit('#proposal-form',{title:'Extra project',likely:8,deadline:'2026-11-19'});
  await contents('#proposals',/Without proposals — feasible.*With proposal — infeasible/s);
  assert.ok(!(await persisted()).tasks.some(t => t.title === 'Extra project'));
  await click('#proposals button','Accept anyway');
  await contents('#verdict',/infeasible.*Unresolved deadline conflict/s);
  await contents('#repairs',/No verified fix/);

  for (const [i,name] of ['One','Two','Three'].entries()) {
    await submit('#proposal-form',{title:`Problem set ${name}`,likely:4,type:'problem_set',deadline:'2026-11-27'});
    await click('#proposals button','Accept anyway');
    const task = (await persisted()).tasks.find(t => t.title === `Problem set ${name}`);
    await submit('#completion-form',{taskId:task.id,actualHours:6,recordedAt:`2026-11-${18+i}T12:00`});
  }
  await contents('#review',/problem_set: 1\.392× \(3 samples\)/);
  await submit('#sleep-form',{hours:6.5,stress:2});
  assert.equal((await persisted()).feedback.sleepReports[0].plannedSleepMinutes,480);
  await execute(() => {
    const form = document.querySelector('#proposal-form');
    form.elements.type.value = 'problem_set';
    form.elements.likely.value = '4';
    form.elements.likely.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await contents('#estimate-suggestion',/suggesting 5\.5h/);
  assert.equal(await js("document.querySelector('#proposal-form').elements.likely.value"),'4');
  await click('#estimate-suggestion button','Use 5.5h');
  assert.equal(await js("document.querySelector('#proposal-form').elements.likely.value"),'5.5');

  const injection = '<img src=x onerror=alert(1)>';
  await submit('#paste-form',{tasks:`${injection} | 1h | 2026-11-19 | droppable\nBad | 0.3h | 2026-11-19`});
  await contents('#import-message',/Added 1, skipped 1/);
  assert.ok((await text('#week-plan')).includes(injection));
  assert.equal(await js('document.querySelectorAll("img").length'),0);
  await upload(`BEGIN:VEVENT\nDTSTART:20261116T160000\nDTEND:20261116T170000\nSUMMARY:${injection}\nEND:VEVENT`);
  await retry(() => contents('#import-message',/Imported 1 busy window/));
  assert.ok(!(await text('body')).includes('SUMMARY:'));
  await contents('#freshness',/Based on your calendar.*Last edited/s);
  await upload('x'.repeat(1_000_001));
  await contents('#import-message',/exceeds the 1 MB/);
  await submit('#settings-form',{sleepStart:'22:30',sleepEnd:'07:00'});
  assert.equal((await persisted()).sleep.start,'22:30');
  const weekState = await persisted();
  assert.equal(weekState.feedback.tasks.length,3);
  assert.ok(weekState.appliedChanges.length);
  assert.equal(requests.length,initialRequests,'No network traffic during interactions');

  await reload();
  assert.deepEqual(await persisted(),weekState);
  await contents('#review',/1\.392/);
  await setStorage("saved.calendarImportedAt = '2000-01-01T00:00:00.000Z';");
  await reload();
  await contents('#freshness',/may be out of date.*Based on your calendar.*Last edited/s);
  await setStorage(`saved.tasks = [{id:'tight',title:'Tight',min:3,likely:3,max:3,targetDay:0,hardDay:0,earliestDay:0,priority:1}];
    saved.feedback.tasks = [];`);
  await reload();
  await contents('#repairs',/No further verified change/);

  await execute(() => {
    for (const control of document.querySelectorAll('a,button,input,select,textarea')) {
      if (control.disabled || !control.getClientRects().length) continue;
      if (control.tabIndex < 0) throw Error(`Unreachable control: ${control.outerHTML}`);
    }
    document.activeElement.blur();
  });
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await js('document.activeElement.tagName'),'A');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  await click('#clear');
  await retry(async () => assert.equal(await persisted(),null));
  await contents('#week-plan',/No open tasks/);
  await reload();
  assert.equal(await persisted(),null);
  assert.ok(!(await text('body')).includes(injection));
  await click('#include-research');
  await submit('#proposal-form',{title:'Research replacement',likely:5,deadline:'2026-11-19'});
  await click('#proposals button','Accept with a self-serve repair');
  const repaired = await persisted();
  assert.equal(repaired.tasks.find(task => task.id === 'poster').targetDay,4);
  assert.equal(repaired.tasks.find(task => task.title === 'Research replacement').isProposal,false);
  await click('#undo');
  assert.equal((await persisted()).tasks.find(task => task.id === 'poster').targetDay,3);
  await click('#clear');
  await retry(async () => assert.equal(await persisted(),null));
  const timing = await execute(async () => {
    const {workload} = await import('./tests/fixtures/workload.mjs');
    const {evaluate} = await import('./src/engine/evaluate.mjs');
    const {findRepairs} = await import('./src/engine/repairs.mjs');
    const {days,tasks} = workload();
    const start = performance.now();
    const verdict = evaluate(tasks,days).verdict;
    const evaluated = performance.now();
    const count = findRepairs(tasks,days).length;
    return {verdict,count,evaluateMs:evaluated-start,repairMs:performance.now()-evaluated};
  });
  assert.equal(timing.verdict,'infeasible');
  assert.ok(timing.count > 0);
  assert.ok(timing.evaluateMs < 100);
  assert.ok(timing.repairMs < 250);
  assert.deepEqual(errors,[]);
  console.log('PASS T21 Chromium interface states, keyboard, layout and console');
  console.log('PASS T22 Chromium reload, feedback/settings persistence, and clear');
  console.log('PASS T23 Chromium untrusted input, size limit and no network after load');
  console.log(`PASS T24 Chromium 35 days / 30 tasks: evaluate ${timing.evaluateMs.toFixed(2)} ms; findRepairs ${timing.repairMs.toFixed(2)} ms`);
} finally {
  ws?.close();
  chrome.kill();
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise(resolve => chrome.once('exit',resolve));
  await rm(profile,{recursive:true,force:true,maxRetries:5});
}
