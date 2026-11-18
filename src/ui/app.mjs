import { makeSlots, plannedSleepMinutes } from '../engine/capacity.mjs';
import { createProposal, evaluateCommitments } from '../engine/commitments.mjs';
import { deadlineCost, evaluate, verdictText, weeklyComparison } from '../engine/evaluate.mjs';
import { buildEstimateProfiles, campusDate, getEstimateSuggestion, sevenDayReview, updateEstimateProfile } from '../engine/feedback.mjs';
import { demoData } from '../engine/demo-data.mjs';
import { parseIcs, parsePastedTasks } from '../engine/importers.mjs';
import { applyRepair, draftApprovalRequest, emptyRepairMessage, findRepairs } from '../engine/repairs.mjs';
import { isHalfHour } from '../engine/scheduler.mjs';
import { LOADED_WEEKS, rebasePlan, rollingDays, weekView } from '../engine/weeks.mjs';
import { makeState } from './state.mjs';
import { clearState, loadState, saveState } from './storage.mjs';

const el = id => document.getElementById(id);
const field = (form, name) => form.elements.namedItem(name);
const now = () => new Date().toISOString();
const campusNow = () => new Date(Date.now() + 19_800_000).toISOString().slice(0,16);
const weekdayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, run, disabled = false) {
  const element = node('button', label);
  element.type = 'button';
  element.disabled = disabled;
  element.addEventListener('click', () => attempt(run));
  return element;
}

function attempt(run, errorTarget = 'notice') {
  const showError = error => { el(errorTarget).textContent = error.message; };
  try {
    const pending = run();
    if (pending instanceof Promise) pending.catch(showError);
  } catch (error) {
    showError(error);
  }
}

function getBrowserStorage() {
  try { return window.localStorage; } catch { return null; }
}
const storage = getBrowserStorage();
const loaded = loadState(storage);
let state = loaded.state ?? makeState();

function dispatch(changes, {edit = true, persist = true} = {}) {
  state = {...state,...changes, ...(edit ? {lastEditedAt:now()} : {})};
  if (persist) {
    try { saveState(storage, state); }
    catch { state = {...state,notice:'Browser storage is unavailable. Changes are open for this session.'}; }
  }
  render();
}

const options = () => ({sleep:state.sleep});
const active = () => {
  const completed = new Set(state.feedback.tasks.map(task => task.taskId));
  return state.tasks.filter(task => !completed.has(task.id));
};
const profileList = () => buildEstimateProfiles(state.feedback.tasks);
const currentDate = () => state.demo ? state.days[0].date : campusDate(now());
const fingerprint = () => JSON.stringify([active(),state.days,state.sleep]);
const repairLabel = repair => repair.actions.map(action => action.label).join(' + ');

function costText(cost) {
  return cost ? `${cost.weekday} (${cost.date}) is the binding deadline. ${cost.requiredHours}h due, ${cost.availableHours}h available, ${cost.shortfallHours}h short.` :
    'No deadline demand.';
}

function appendSchedule(target, schedule, indices) {
  const list = node('ul');
  for (const index of indices) {
    const day = schedule.byDay[index];
    const booked = day.assigned.reduce((sum, item) => sum + item.minutes, 0);
    const row = node('li', `${day.date} — ${booked / 60}h scheduled / ${day.capacity / 60}h available`);
    if (day.assigned.length) {
      const slots = node('ul');
      for (const slot of day.assigned) slots.append(node('li', `${slot.label} ${slot.taskTitle}${slot.late ? ' (late)' : ''}`));
      row.append(slots);
    }
    list.append(row);
  }
  target.append(list);
}

function renderWeek(evaluation) {
  const stale = !state.calendarImportedAt || Date.now() - Date.parse(state.calendarImportedAt) > 86_400_000;
  el('freshness').textContent = [
    stale && 'Your calendar may be out of date. Re-import before relying on this.',
    state.calendarImportedAt && `Based on your calendar from ${state.calendarImportedAt}.`,
    state.tasksImportedAt && `Tasks imported ${state.tasksImportedAt}.`,
    state.lastEditedAt && `Last edited ${state.lastEditedAt}.`
  ].filter(Boolean).join(' ');
  const cost = deadlineCost(evaluation.typical,state.days);
  const week = weekView(state.days,state.weekIndex);
  const baseline = weeklyComparison(evaluation.typical,week.dayIndices);
  const verdict = el('verdict');
  verdict.replaceChildren(
    node('h3', evaluation.verdict),
    node('p', verdictText(evaluation,state.days)),
    node('p', costText(cost)),
    node('p', `Weekly hours only (simulated baseline) — ${baseline.requiredMinutes / 60}h required / ${baseline.capacityMinutes / 60}h available.`),
    node('p', `Deadline-aware scheduler (same allocation, no repair step) — ${evaluation.typical.feasible ? 'typical estimates fit' : 'typical estimates miss a deadline'}.`)
  );
  if (cost?.tasks.length) verdict.append(node('p', `Tasks due by that date — ${cost.tasks.map(task => `${task.title} (${task.hours}h)`).join(', ')}.`));
  if (evaluation.verdict === 'at-risk') verdict.append(node('p', `Conservative estimates — ${costText(deadlineCost(evaluation.conservative,state.days))}`));
  if (state.unresolvedConflict && evaluation.typical.misses.some(miss => state.days[miss.dueDay].date >= currentDate())) {
    verdict.append(node('strong','Unresolved deadline conflict accepted by override.'));
  }

  el('week-range').textContent = `${week.startDate} to ${week.endDate}`;
  el('previous-week').disabled = state.weekIndex === 0;
  el('next-week').disabled = state.weekIndex === LOADED_WEEKS - 1;
  el('research-controls').hidden = !state.demo;
  el('include-research').checked = state.includeResearch;
  el('research-hours').value = state.researchHours;
  const plan = el('week-plan');
  plan.replaceChildren();
  const tasks = node('ul');
  for (const task of active().filter(t => !t.removed && week.dayIndices.includes(t.targetDay))) {
    const tag = task.allowDrop ? 'droppable' : task.flexible ? 'flexible' : 'must-keep';
    tasks.append(node('li', `${task.title} — ${task.likely}h, ${state.days[task.targetDay].date}, ${tag}`));
  }
  plan.append(node('h3','Tasks'), tasks);
  if (!tasks.childElementCount) tasks.append(node('li','No open tasks due this week.'));
  appendSchedule(plan,evaluation.typical,week.dayIndices);
}

function acceptDraft(drafts, outcome, choice, repair) {
  const ids = drafts.map(task => task.id);
  let plan = [...active(),...drafts];
  let change;
  if (repair) {
    const previous = plan.filter(task => repair.actions.some(action => action.taskId === task.id &&
      !(action.type === 'drop' && ids.includes(task.id)))).map(task => ({...task,isProposal:ids.includes(task.id) ? false : task.isProposal}));
    plan = applyRepair(plan,state.days,repair.id,options());
    change = {previous, labels:repair.actions.map(action => action.label), approved:false, recordedAt:now()};
  }
  const updated = new Map(plan.map(task => [task.id,task]));
  const tasks = state.tasks.map(task => updated.get(task.id) ?? task);
  for (const id of ids) {
    const task = updated.get(id);
    if (!task.removed) tasks.push({...task,isProposal:false});
  }
  dispatch({tasks, proposals:state.proposals.filter(task => !ids.includes(task.id)),
    appliedChanges:change ? [...state.appliedChanges,change] : state.appliedChanges,
    unresolvedConflict:state.unresolvedConflict || (choice === 'override' && !outcome.evaluation.typical.feasible),
    notice:'Commitment decision saved.'});
}

function renderProposals() {
  const target = el('proposals');
  target.replaceChildren();
  if (!state.proposals.length) return;
  const checked = evaluateCommitments(active(),state.proposals,state.days,options());
  target.append(node('p', `Without proposals — ${checked.before.evaluation.verdict}. ${costText(checked.before.cost)}`));
  function show(drafts, outcome, title) {
    const article = node('article');
    article.append(node('h3',title), node('p', `With proposal — ${outcome.evaluation.verdict}. ${costText(outcome.cost)}`));
    if (outcome.cost?.tasks.length) article.append(node('p',outcome.cost.tasks.map(task => `${task.title} (${task.hours}h)`).join(', ')));
    const top = outcome.repairs[0];
    const selfServe = outcome.repairs.find(repair => !repair.needsApproval);
    if (top) article.append(node('p',`${repairLabel(top)} — ${top.test.verdict}${top.needsApproval ? ', needs approval' : ''}.`));
    if (selfServe && selfServe !== top) article.append(node('p',`Self-serve option — ${repairLabel(selfServe)}.`));
    article.append(
      button('Accept',() => acceptDraft(drafts,outcome,'accept'), !outcome.evaluation.typical.feasible),
      button('Accept with a self-serve repair',() => acceptDraft(drafts,outcome,'repair',selfServe),!selfServe),
      button('Accept anyway',() => acceptDraft(drafts,outcome,'override')),
      button('Not now',() => dispatch({proposals:state.proposals.filter(task => !drafts.includes(task))}))
    );
    target.append(article);
  }
  checked.separate.forEach((outcome,index) => show([state.proposals[index]],outcome,state.proposals[index].title));
  if (state.proposals.length > 1) show(state.proposals,checked.together,'All pending proposals together');
}

function applyLiveRepair(repair, token) {
  if (token !== fingerprint()) throw Error('The plan changed. Preview the current repair again.');
  const affected = new Set(repair.actions.map(action => action.taskId));
  const approvedActionIds = state.pendingApprovals.filter(record =>
    record.token === token && record.status === 'approved').map(record => record.actionId);
  const live = applyRepair(active(),state.days,repair.id,{...options(),approvedActionIds});
  const byId = new Map(live.map(task => [task.id,task]));
  const tasks = state.tasks.map(task => byId.get(task.id) ?? task);
  const change = {previous:state.tasks.filter(task => affected.has(task.id)), approved:repair.needsApproval,
    labels:repair.actions.map(action => action.label), recordedAt:now()};
  dispatch({tasks,selectedRepairId:null,pendingApprovals:[],appliedChanges:[...state.appliedChanges,change],
    notice:`Verified repair applied. New verdict: ${repair.test.verdict}.`});
}

function renderRescue(evaluation) {
  const token = fingerprint();
  const status = id => state.pendingApprovals.find(record => record.token === token && record.actionId === id)?.status ?? 'pending';
  const repairs = findRepairs(active(),state.days,options());
  const target = el('repairs');
  target.replaceChildren(node('p',`Current verdict — ${evaluation.verdict}`));
  const preview = el('preview');
  preview.replaceChildren();
  el('undo').disabled = !state.appliedChanges.length;
  if (!repairs.length) target.append(node('p',emptyRepairMessage(evaluation.verdict)));
  for (const repair of repairs.slice(0,5)) {
    const article = node('article');
    const dependent = repair.actions.filter(action => action.needsApproval);
    const statuses = dependent.map(action => status(action.id));
    article.append(node('h3',repairLabel(repair)),
      node('p',`${repair.test.verdict} after ${repair.actions.length} change(s) — ${repair.needsApproval ? `Needs approval (${statuses.join(', ')})` : 'Self-serve'}.`),
      button('Preview',() => dispatch({selectedRepairId:repair.id},{edit:false,persist:false})));
    target.append(article);
    if (state.selectedRepairId !== repair.id) continue;
    preview.append(node('h3',repair.needsApproval ? 'If approved' : 'Repair preview'),
      node('p',verdictText(repair.test,state.days)),
      node('p',costText(deadlineCost(repair.test.typical,state.days))));
    appendSchedule(preview,repair.test.typical,weekView(state.days,state.weekIndex).dayIndices);
    if (!repair.needsApproval) {
      preview.append(button('Apply self-serve repair',() => applyLiveRepair(repair,token)));
      continue;
    }

    const label = node('label','Include my workload summary');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    label.prepend(checkbox);
    const draft = node('textarea');
    draft.readOnly = true;
    draft.setAttribute('aria-label','Approval request text');
    draft.hidden = true;
    preview.append(label,button('Copy approval request text',async () => {
      draft.value = draftApprovalRequest(repair,state.days,{includeWorkload:checkbox.checked});
      draft.hidden = false;
      draft.select();
      try {
        await navigator.clipboard.writeText(draft.value);
        el('notice').textContent = 'Approval request copied.';
      } catch {
        el('notice').textContent = 'Copy the selected request text using your browser’s copy command.';
      }
    }), draft);
    for (const action of dependent) {
      const record = nextStatus => {
        const pendingApprovals = state.pendingApprovals.filter(item => item.token === token && item.actionId !== action.id);
        pendingApprovals.push({token,actionId:action.id,status:nextStatus,recordedAt:now()});
        dispatch({pendingApprovals});
      };
      preview.append(node('p',`${action.label} — ${status(action.id)}`),
        button('Mark approved',() => record('approved'), status(action.id) === 'approved'),
        button('Mark declined',() => record('declined'), status(action.id) === 'declined'));
    }
    preview.append(button('Apply approved repair',() => applyLiveRepair(repair,token),!statuses.every(value => value === 'approved')));
  }
}

function renderSuggestion() {
  const form = el('proposal-form');
  const input = field(form,'likely');
  const typical = input.valueAsNumber;
  const profile = profileList().find(item => item.type === field(form,'type').value);
  const target = el('estimate-suggestion');
  target.replaceChildren();
  if (!isHalfHour(typical) || typical < 0.5 || typical > 40) return;
  const suggestion = getEstimateSuggestion(profile,typical);
  if (suggestion === null) {
    target.textContent = `Learning (${profile.samples} of 3 samples).`;
    return;
  }
  target.append(node('p',`You entered ${typical}h. This task type has a learned ratio of ${profile.ratio.toFixed(2)}×, suggesting ${suggestion}h.`));
  if (suggestion >= 0.5 && suggestion <= 40) target.append(button(`Use ${suggestion}h`,() => {
    input.value = suggestion;
    renderSuggestion();
  }));
}

function presetCompletion() {
  const form = el('completion-form');
  const task = state.tasks.find(t => t.id === field(form,'taskId').value);
  const saved = state.feedback.tasks.find(t => t.taskId === task?.id);
  field(form,'actualHours').value = saved?.actualHours ?? task?.likely ?? '';
  field(form,'recordedAt').value = saved?.recordedAt ?? campusNow();
}

function renderFeedback() {
  const elapsed = active().filter(task => !task.removed && task.likely > 0 && state.days[task.targetDay].date < currentDate());
  el('feedback-prompt').textContent = elapsed.length
    ? 'How long did your past-due tasks actually take? Use the task list below to record completion.'
    : '';

  const form = el('completion-form');
  const select = field(form,'taskId');
  const previous = select.value;
  select.replaceChildren(...state.tasks.filter(task => !task.removed && task.likely > 0)
    .map(task => new Option(task.title,task.id)));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  if (!field(form,'recordedAt').value || previous !== select.value) presetCompletion();
  const reviewDate = state.demo ? [campusDate(now()),state.days[0].date].sort().at(-1) : campusDate(now());
  const review = sevenDayReview({feedback:state.feedback.tasks,sleepReports:state.feedback.sleepReports,
    appliedChanges:state.appliedChanges,tasks:state.tasks,days:state.days,throughDate:reviewDate});
  const view = el('review');
  view.replaceChildren(node('h3',`Seven-day review — ${review.fromDate} to ${review.throughDate}`),node('p',review.summary));
  const ratios = node('ul');
  for (const profile of review.profiles) ratios.append(node('li',`${profile.type}: ${profile.ratio.toFixed(3)}× (${profile.samples} samples)`));
  view.append(ratios);
  for (const record of review.estimates) view.append(node('p',`${record.title} — ${record.estimatedLikely}h estimated, ${record.actualHours}h actual. Target ${record.metTarget ? 'met' : 'missed'}, hard deadline ${record.metHardDeadline ? 'met' : 'missed'}.`));
  for (const change of review.adjustments) view.append(node('p',`${campusDate(change.recordedAt)} — ${change.labels.join(', ')} (${change.approved ? 'approved' : 'self-serve'})`));
  for (const record of review.reports) view.append(node('p',`${record.date} — ${record.hoursSlept}h reported, ${record.plannedHours}h protected${record.stress ? `, stress ${record.stress}/5` : ''}.`));
  const sleepDate = field(el('sleep-form'),'date');
  if (!sleepDate.value) sleepDate.value = campusDate(now());
}

function render() {
  el('notice').textContent = state.notice;
  const evaluation = evaluate(active(),state.days,options());
  renderWeek(evaluation);
  renderProposals();
  renderRescue(evaluation);
  renderFeedback();
  renderSuggestion();
}

function fillSettings() {
  const form = el('settings-form');
  field(form,'sleepStart').value = state.sleep.start;
  field(form,'sleepEnd').value = state.sleep.end;
  field(form,'anchor').value = state.settings.anchor;
  field(form,'windows').value = state.settings.weeklyWorkWindows.flatMap((windows,index) =>
    windows.map(([start,end]) => `${weekdayLabels[index]} ${start}-${end}`)).join('\n');
}

function switchDemo(fixed) {
  const demo = demoData(fixed);
  if (!state.demo) {
    if (state.tasks.length && !window.confirm('Replace the current plan with the demo?')) return;
    dispatch(makeState({fixed}));
    fillSettings();
    return;
  }
  const demoIds = new Set(demo.tasks.map(task => task.id));
  const originals = demo.tasks.filter(task => state.includeResearch || task.id !== 'research').map(task => {
    if (task.id !== 'research') return task;
    const likely = state.researchHours;
    return {...task,min:likely - 1,likely,max:likely + 1};
  });
  const sample = rebasePlan(demo.days,originals,state.days).tasks;
  const tasks = [...sample,...state.tasks.filter(task => !demoIds.has(task.id))];
  dispatch({fixed,tasks,appliedChanges:state.appliedChanges.filter(change => !change.previous.some(t => demoIds.has(t.id))),
    pendingApprovals:[],selectedRepairId:null,notice:fixed ? 'Fixed demo' : 'Flexible demo'});
}

function changeResearch() {
  const includeResearch = el('include-research').checked;
  const likely = el('research-hours').valueAsNumber;
  if (!isHalfHour(likely) || likely < 4 || likely > 6) throw Error('Demo research must be 4–6h in half-hour increments.');
  const demo = demoData(state.fixed);
  const research = demo.tasks.find(task => task.id === 'research');
  const [task] = rebasePlan(demo.days,[research],state.days).tasks;
  const tasks = state.tasks.filter(item => item.id !== task.id);
  if (includeResearch) tasks.push({...task,min:likely - 1,likely,max:likely + 1});
  dispatch({tasks,includeResearch,researchHours:likely,pendingApprovals:[],selectedRepairId:null,
    appliedChanges:state.appliedChanges.filter(change => !change.previous.some(item => item.id === task.id))});
}

el('demo-flexible').onclick = () => attempt(() => switchDemo(false));
el('demo-fixed').onclick = () => attempt(() => switchDemo(true));
el('include-research').onchange = () => attempt(changeResearch);
el('research-hours').onchange = () => attempt(changeResearch);
el('previous-week').onclick = () => dispatch({weekIndex:state.weekIndex - 1},{edit:false});
el('next-week').onclick = () => dispatch({weekIndex:state.weekIndex + 1},{edit:false});
el('undo').onclick = () => attempt(() => {
  const change = state.appliedChanges.at(-1);
  const previous = new Map(change.previous.map(task => [task.id,task]));
  dispatch({tasks:state.tasks.map(task => previous.get(task.id) ?? task),appliedChanges:state.appliedChanges.slice(0,-1),
    pendingApprovals:[],selectedRepairId:null,notice:'Last repair undone.'});
});

const proposalForm = el('proposal-form');
function clearProposalError() {
  const error = el('proposal-error');
  error.textContent = '';
  for (const input of proposalForm.elements) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}
function showProposalError(error) {
  const region = el('proposal-error');
  const fields = [
    [/^Name/,'title'], [/^Typical/,'likely'], [/^Latest/,'latestDate'],
    [/^Earliest/,'earliestDate'], [/^Deadline/,'deadline'], [/priority/,'tag'], [/task type/,'type'],
    [/duration|range/,'min']
  ];
  const entry = fields.find(([pattern]) => pattern.test(error.message));
  if (entry) {
    const input = field(proposalForm,entry[1]);
    input.setAttribute('aria-invalid','true');
    input.setAttribute('aria-describedby',region.id);
    input.closest('label').after(region);
  }
  region.textContent = error.message;
}
proposalForm.oninput = () => attempt(() => {
  const flexible = field(proposalForm,'tag').value === 'flexible';
  el('latest-field').hidden = !flexible;
  if (!flexible) field(proposalForm,'latestDate').value = '';
  clearProposalError();
  renderSuggestion();
},'proposal-error');
proposalForm.onsubmit = event => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(proposalForm));
    for (const key of ['min','likely','max']) if (values[key] !== '') values[key] = field(proposalForm,key).valueAsNumber;
    const task = createProposal(values,state.days,{existingTasks:[...state.tasks,...state.proposals,...state.feedback.tasks.map(entry => ({id:entry.taskId}))],notBeforeDate:currentDate()});
    dispatch({proposals:[...state.proposals,task]});
    proposalForm.reset();
    proposalForm.oninput();
  } catch (error) {
    showProposalError(error);
  }
};

const completion = el('completion-form');
field(completion,'taskId').onchange = presetCompletion;
function complete(asPlanned) {
  const task = state.tasks.find(t => t.id === field(completion,'taskId').value);
  if (!task) throw Error('Choose a task.');
  const recordedAt = field(completion,'recordedAt').value;
  if (!campusDate(recordedAt)) throw Error('Enter a valid completion time.');
  const previous = state.feedback.tasks.find(item => item.taskId === task.id);
  const entry = {...previous,taskId:task.id,title:task.title,type:task.type ?? 'other',
    estimatedLikely:previous?.estimatedLikely ?? task.likely,
    actualHours:asPlanned ? previous?.estimatedLikely ?? task.likely : field(completion,'actualHours').valueAsNumber,
    recordedAt,targetDate:previous?.targetDate ?? state.days[task.targetDay].date,
    hardDate:previous?.hardDate ?? state.days[task.hardDay].date};
  updateEstimateProfile(null,entry);
  const tasks = previous ? state.feedback.tasks.map(item => item.taskId === task.id ? entry : item) :
    [...state.feedback.tasks,entry];
  dispatch({feedback:{...state.feedback,tasks},notice:'Task feedback saved.'});
  presetCompletion();
}
completion.onsubmit = event => {
  event.preventDefault();
  attempt(() => complete(false));
};
el('as-planned').onclick = () => attempt(() => complete(true));
el('sleep-form').onsubmit = event => {
  event.preventDefault();
  attempt(() => {
    const form = event.currentTarget;
    const date = field(form,'date').value;
    const hoursSlept = field(form,'hours').valueAsNumber;
    const stress = field(form,'stress').valueAsNumber;
    if (!campusDate(date) || !isHalfHour(hoursSlept) || hoursSlept > 24) throw Error('Enter a valid night and sleep duration.');
    const previous = state.feedback.sleepReports.find(report => report.date === date);
    const report = {date,hoursSlept,plannedSleepMinutes:previous?.plannedSleepMinutes ?? plannedSleepMinutes(state.sleep)};
    if (Number.isInteger(stress) && stress >= 1 && stress <= 5) report.stress = stress;
    dispatch({feedback:{...state.feedback,sleepReports:[...state.feedback.sleepReports.filter(item => item.date !== date),report]},
      notice:'Sleep report saved.'});
  });
};

el('settings-form').onsubmit = event => {
  event.preventDefault();
  attempt(() => {
    const form = event.currentTarget;
    const sleep = {start:field(form,'sleepStart').value,end:field(form,'sleepEnd').value};
    const anchor = field(form,'anchor').value;
    const weeklyWorkWindows = weekdayLabels.map(() => []);
    for (const [index,line] of field(form,'windows').value.split('\n').entries()) {
      if (!line.trim()) continue;
      const match = /^\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d\d:\d\d)\s*-\s*(\d\d:\d\d)\s*$/.exec(line);
      if (!match) throw Error(`Work windows line ${index + 1}: use Mon 16:00-20:00.`);
      weeklyWorkWindows[weekdayLabels.indexOf(match[1])].push(match.slice(2));
    }
    const newDays = rollingDays(anchor,weeklyWorkWindows);
    const rebased = rebasePlan(state.days,active().filter(t => !t.removed),newDays);
    const drafts = rebasePlan(state.days,state.proposals,newDays);
    const datesChanged = newDays[0].date !== state.days[0].date;
    if (!datesChanged) rebased.tasks = state.tasks;
    makeSlots(rebased.days,sleep);
    const retained = new Set(rebased.tasks.map(t => t.id));
    const appliedChanges = state.appliedChanges.map(change => ({
      ...change, previous:rebasePlan(state.days,change.previous.filter(task => retained.has(task.id)),newDays).tasks
    }));
    dispatch({...rebased,proposals:drafts.tasks,sleep,settings:{anchor,weeklyWorkWindows},appliedChanges,
      demo:state.demo && !datesChanged,weekIndex:datesChanged ? 0 : state.weekIndex,
      pendingApprovals:[],selectedRepairId:null,
      calendarImportedAt:datesChanged ? null : state.calendarImportedAt,notice:'Settings saved.'});
    el('settings-error').textContent = '';
  },'settings-error');
};

el('paste-form').onsubmit = event => {
  event.preventDefault();
  attempt(() => {
    const form = event.currentTarget;
    const existingIds = [...state.tasks,...state.proposals,...state.feedback.tasks.map(record => ({id:record.taskId}))].map(task => task.id);
    const imported = parsePastedTasks(field(form,'tasks').value,state.days,{existingIds});
    if (imported.data.length) dispatch({tasks:[...state.tasks,...imported.data],tasksImportedAt:now()});
    el('import-message').textContent = `Added ${imported.data.length}, skipped ${imported.warnings.length}. ${imported.warnings.join(' ')}`;
  },'import-message');
};
el('calendar-file').onchange = event => attempt(async () => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1_000_000) throw Error('Calendar file exceeds the 1 MB size limit.');
  const text = await file.text();
  const imported = parseIcs(text,state.days);
  if (imported.data.length) {
    const days = state.days.map(day => ({...day,busyWindows:[]}));
    for (const entry of imported.data) days[entry.index].busyWindows.push([entry.start,entry.end]);
    dispatch({days,calendarImportedAt:now(),pendingApprovals:[],selectedRepairId:null});
  }
  el('import-message').textContent = `Imported ${imported.data.length} busy window(s). ${imported.warnings.join(' ')}`;
},'import-message');

el('clear').onclick = () => attempt(() => {
  if (!window.confirm('Clear the saved plan, settings, approvals and feedback?')) return;
  if (storage) clearState(storage);
  for (const form of document.forms) form.reset();
  el('calendar-file').value = '';
  for (const id of ['import-message','proposal-error','settings-error']) el(id).textContent = '';
  dispatch({...makeState({demo:false}),notice:'Local data cleared.'},{edit:false,persist:false});
  fillSettings();
  proposalForm.oninput();
});

try {
  dispatch({notice:loaded.warning},{edit:false,persist:false});
} catch {
  dispatch({...makeState(),notice:'Saved data could not be read. A fresh plan is open.'},{edit:false,persist:false});
}
fillSettings();
