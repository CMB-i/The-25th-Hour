import { defaultRange, roundHalfHour } from '../engine/commitments.mjs';
import { weekdayName as weekdayNameOf } from '../engine/dates.mjs';
import { deadlineCost, verdictText } from '../engine/evaluate.mjs';
import { getEstimateSuggestion } from '../engine/feedback.mjs';
import { isHalfHour, TASK_TYPES } from '../engine/scheduler.mjs';
import {
  analyzeRequest,
  buildReply,
  buildReplyTabs,
  dayLabel,
  describeBookedWeek,
  hoursPhrase
} from './check-model.mjs';
import {
  copyToClipboard,
  fmtHours,
  fmtSignedHours,
  h,
  setBlobTone,
  svg,
  taskTag,
  verdictLabel
} from './dom.mjs';
import { hasWorkWindows, renderRangePicker, saveHoursFor } from './hours-editor.mjs';
import { makeCopyControls } from './reply-slip.mjs';
import { clockText, namesJoined, verifyWait } from './night.mjs';
import { openWeekBusy } from './render-week.mjs';
import { findSelfServeAcceptRepair } from './state.mjs';
import { getUi, resetCheckFormDraft, resetRequestUi, session } from './check-session.mjs';
import {
  describeEstimateSuggestion,
  draftFromProposal,
  effectiveTaskType,
  mapProposalErrorToField,
  renderRequestForm
} from './request-form.mjs';

export { describeEstimateSuggestion, effectiveTaskType, mapProposalErrorToField, renderRequestForm, resetCheckFormDraft };



/**
 * Purely summarizes the 7 required decision points comparing the plan without and with draft proposals.
 */
export function buildCommitmentSummary(beforeOutcome, afterOutcome, proposals, days) {
  const beforeEval = beforeOutcome.evaluation;
  const afterEval = afterOutcome.evaluation;
  const beforeCost = beforeOutcome.cost;
  const afterCost = afterOutcome.cost;
  const afterConsCost = deadlineCost(afterEval.conservative, days);

  const addedLikely = roundHalfHour(proposals.reduce((sum, task) => sum + task.likely, 0));
  const addedMin = roundHalfHour(proposals.reduce((sum, task) => sum + task.min, 0));
  const addedMax = roundHalfHour(proposals.reduce((sum, task) => sum + task.max, 0));

  const withoutLine = beforeCost
    ? `${verdictLabel(beforeEval.verdict)}. Tightest deadline: ${beforeCost.weekday} (${beforeCost.date}), ${
        beforeCost.shortfallHours > 0
          ? `short by ${fmtHours(beforeCost.shortfallHours)}`
          : `${fmtHours(beforeCost.marginHours)} to spare`
      }.`
    : `${verdictLabel(beforeEval.verdict)}. No existing deadline demand.`;

  const withLine = afterCost
    ? afterEval.verdict === 'infeasible'
      ? `Infeasible. Work due by ${afterCost.weekday} (${afterCost.date}): ${fmtHours(afterCost.requiredHours)}. Time available by ${afterCost.weekday}: ${fmtHours(afterCost.availableHours)}. Short by ${fmtHours(afterCost.shortfallHours)}.`
      : afterEval.verdict === 'at-risk'
        ? `At risk. Work due by ${afterCost.weekday} (${afterCost.date}): ${fmtHours(afterCost.requiredHours)} of ${fmtHours(afterCost.availableHours)} available (${fmtHours(afterCost.marginHours)} typical buffer; ${afterConsCost ? fmtSignedHours(afterConsCost.marginHours) : '0h'} conservative).`
        : `Feasible. Work due by ${afterCost.weekday} (${afterCost.date}): ${fmtHours(afterCost.requiredHours)} of ${fmtHours(afterCost.availableHours)} available (${fmtHours(afterCost.marginHours)} to spare).`
    : `${verdictLabel(afterEval.verdict)}.`;

  const tasksDueLine = afterCost?.tasks?.length
    ? `Tasks due by ${afterCost.weekday}: ${afterCost.tasks.map(task => `${task.title} (${fmtHours(task.hours)})`).join(', ')}.`
    : '';

  const draftIds = proposals.map(task => task.id);
  const topRepair = afterOutcome.repairs[0] ?? null;
  const selfServeRepair = findSelfServeAcceptRepair(afterOutcome.repairs, draftIds);

  let topRepairLine = 'Smallest verified fix: None needed — this commitment fits your week.';
  if (afterEval.verdict !== 'feasible') {
    if (topRepair) {
      const topTypCost = deadlineCost(topRepair.test.typical, days);
      const spareText = topTypCost
        ? `${fmtHours(Math.max(0, topTypCost.marginHours))} spare`
        : '';
      const modeLabel = topRepair.needsApproval ? 'Needs approval' : 'Self-serve';
      topRepairLine = `Smallest verified fix: ${topRepair.actions.map(action => action.label).join(' + ')} (${modeLabel}). Result: ${verdictLabel(topRepair.test.verdict)}${spareText ? `, ${spareText}` : ''}.`;
    } else {
      topRepairLine = "Smallest verified fix: No verified fix with the changes you've allowed (capacity problem, not a scheduling problem).";
    }
  }

  return {
    beforeVerdict: beforeEval.verdict,
    afterVerdict: afterEval.verdict,
    beforeHeadline: verdictText(beforeEval, days),
    afterHeadline: verdictText(afterEval, days),
    withoutLine,
    withLine,
    tasksDueLine,
    topRepairLine,
    addedLikely,
    addedMin,
    addedMax,
    bindingWeekday: afterCost?.weekday ?? null,
    bindingDate: afterCost?.date ?? null,
    requiredHours: afterCost?.requiredHours ?? 0,
    availableHours: afterCost?.availableHours ?? 0,
    shortfallHours: afterCost?.shortfallHours ?? 0,
    marginHours: afterCost?.marginHours ?? 0,
    conservativeMarginHours: afterConsCost?.marginHours ?? 0,
    topRepair,
    selfServeRepair
  };
}


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function announce(text) {
  const node = document.getElementById('sr-announcer');
  if (!node) return;
  node.textContent = '';
  setTimeout(() => { node.textContent = text; }, 60);
}

/** One opt-in line from the existing estimate-learning API, so the student needn't open Past estimates. */
function renderLearnedLine({ proposal, derived, state, dispatch }) {
  const ui = getUi(proposal.id);
  if (ui.learnedUsed) return null; // one offer per request: accepting it must not trigger a second bump
  const type = effectiveTaskType(proposal.type, proposal.title);
  const info = describeEstimateSuggestion(derived.estimateProfiles, type, proposal.likely);
  if (info.status !== 'ready' || info.suggestedHours === proposal.likely) return null;
  return h('div', { id: 'estimate-line', className: 'learned-line', role: 'status' },
    h('span', {}, info.text),
    h('button', {
      type: 'button', id: 'use-learned', className: 'learned-btn',
      onClick: () => {
        const fields = draftFromProposal(proposal, state);
        session.pendingFocus = true;
        ui.learnedUsed = true;
        try {
          dispatch({
            type: 'UPDATE_PROPOSAL',
            proposalId: proposal.id,
            fields: { ...fields, type, likely: String(info.suggestedHours) }
          }, { rethrow: true });
        } catch {
          session.pendingFocus = false;
          ui.learnedUsed = false;
        }
      }
    }, `Use ${fmtHours(info.suggestedHours)}`)
  );
}

function renderRequestSummary({ proposal, state, rerender }) {
  const dueDate = state.days[proposal.targetDay]?.date;
  const summary = `${proposal.title} · ${fmtHours(proposal.likely)} · ${dueDate ? weekdayNameOf(dueDate) : ''}`;
  return h('button', {
    type: 'button', id: 'edit-request', className: 'request-summary',
    'aria-label': `${summary}. Edit`,
    onClick: () => {
      session.editing = true;
      session.formDraft = null;
      rerender();
      document.getElementById('proposal-title')?.focus();
    }
  },
    h('span', { className: 'summary-icon', 'aria-hidden': 'true' },
      svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none' },
        svg('path', { d: 'M4 3h8l3 3v9H4z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }),
        svg('path', { d: 'M7 9h5M7 12h5', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }))),
    h('span', { className: 'summary-text' }, summary),
    h('span', { className: 'summary-edit', 'aria-hidden': 'true' }, 'Edit')
  );
}

const VERDICT_WORDS = { fits: 'Fits', tight: 'Tight', short: "Doesn't fit" };

function renderVerdict({ analysis, state, animate }) {
  const baselineNote = analysis.baselineBroken && analysis.kind === 'short'
    ? 'Your week already had a gap before this, so the numbers above show both.'
    : '';
  return h('section', {
    id: 'check-verdict',
    className: `vhero vhero-${analysis.kind}${animate ? ' rise' : ''}`,
    'aria-labelledby': 'verdict-headline'
  },
    h('div', { className: 'eyebrow vhero-eyebrow' }, analysis.eyebrow),
    h('h1', { id: 'verdict-headline', className: 'vhero-title', tabindex: '-1', role: 'status' }, analysis.bigWord),
    h('p', { id: 'verdict-lead', className: 'vhero-lead' }, analysis.lead),
    analysis.detail ? h('p', { className: 'vhero-detail' }, analysis.detail) : null,
    baselineNote ? h('p', { className: 'vhero-detail' }, baselineNote) : null,
    analysis.kind === 'short' && analysis.option && analysis.afterClause?.kind === 'hours' && analysis.afterClause.hours >= 2
      ? h('p', { className: 'aside-line' }, 'That would need the 25th hour. Here is one way to get some time back.')
      : null,
    analysis.kind === 'fits'
      ? null
      : h('p', { className: 'vhero-sleep' }, `Sleep stays protected (${state.sleep.start}–${state.sleep.end}) in every number here.`)
  );
}

const oneDecimal = value => Math.round(value * 10) / 10;

/** Needed versus free, from the engine run: green is what fits, coral is the shortfall. */
export function renderBar({ analysis, animate }) {
  const bar = analysis.bar;
  if (!bar) return null;
  const scale = Math.max(bar.need, bar.free, 0.5);
  const pct = value => `${Math.round((value / scale) * 1000) / 10}%`;
  const label = bar.short > 0
    ? `${hoursPhrase(bar.need)} needed, ${hoursPhrase(bar.free)} free before ${bar.dayName}, ${hoursPhrase(bar.short)} short.`
    : `${hoursPhrase(bar.need)} needed, ${hoursPhrase(bar.free)} free before ${bar.dayName}. It fits.`;
  return h('section', { id: 'fit-bar', className: `fitbar${animate ? ' rise' : ''}`, role: 'img', 'aria-label': label },
    h('div', { className: 'fitbar-head' },
      h('span', {}, bar.fromNow ? `Time from now until ${bar.dayName}` : `Time before ${bar.dayName}`),
      h('span', {}, `${hoursPhrase(bar.free)} free`)),
    h('div', { className: 'fitbar-track-wrap' },
      h('div', { className: 'fitbar-track' },
        h('div', { className: `fitbar-ok${animate ? ' grow' : ''}`, style: `width:${pct(bar.ok)}` }),
        bar.short > 0 ? h('div', { className: `fitbar-short${animate ? ' grow' : ''}`, style: `width:${pct(bar.short)}` }) : null),
      h('div', { className: 'fitbar-cap', 'aria-hidden': 'true', style: `left:${pct(bar.free)}` })),
    h('div', { className: 'legend-row', 'aria-hidden': 'true' },
      h('span', {}, h('i', { className: 'swatch sage' }), `Fits: ${hoursPhrase(bar.ok)}`),
      bar.short > 0 ? h('span', {}, h('i', { className: 'swatch coral' }), `Short: ${hoursPhrase(bar.short)}`) : null,
      h('span', {}, h('i', { className: 'swatch marker' }), 'Your free time ends here'))
  );
}

function renderOption({ analysis, state, dispatch, animate }) {
  if (analysis.kind === 'fits') return null;
  if (!analysis.option) {
    if (analysis.kind === 'tight') return null;
    return h('section', { id: 'check-option', className: `option-card option-none${animate ? ' rise' : ''}` },
      h('div', { className: 'eyebrow option-eyebrow' }, 'Verified option'),
      h('h2', { className: 'option-title' }, 'No change makes this fit.'),
      h('p', { className: 'option-body' }, analysis.noOptionText)
    );
  }
  const option = analysis.option;
  const resultText = option.spareHours !== null
    ? `With that change it fits. Your tightest day, ${dayLabel(option.spareDate)}, still has ${hoursPhrase(option.spareHours)} to spare, and your sleep stays untouched.`
    : 'With that change it fits, and your sleep stays untouched.';
  return h('section', { id: 'check-option', className: `option-card${option.needsApproval ? ' option-approval' : ''}${animate ? ' rise' : ''}` },
    h('div', { className: 'option-head' },
      h('div', { className: 'eyebrow option-eyebrow' }, analysis.kind === 'tight' ? 'If you want more room' : 'One verified option'),
      h('span', { className: `option-tag ${option.needsApproval ? 'needs-approval' : 'self-serve'}` },
        option.needsApproval ? 'If approved' : 'You can do this yourself')),
    h('h2', { className: 'option-title' }, `${option.label}.`),
    h('p', { className: 'option-body' },
      resultText,
      option.needsApproval ? ' Someone else has to say yes first.' : ''),
    analysis.alternative
      ? h('p', { className: 'option-note' }, `A change you can make yourself: ${analysis.alternative.label}.`)
      : null,
    h('button', {
      type: 'button', id: 'other-ways', className: 'link-button',
      onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
    }, 'Other ways to make room')
  );
}

function renderEstimateRange(analysis, after, state) {
  if (!analysis.range) return null;
  const levels = [
    ['optimistic', 'If everything goes quickly'],
    ['typical', 'As estimated'],
    ['conservative', 'If everything runs long']
  ];
  return h('section', { id: 'estimate-range', className: 'range-block' },
    h('p', { id: 'range-sentence', className: 'range-sentence' }, analysis.range.sentence),
    h('p', { className: 'option-note' }, 'Your other commitments are held at their usual estimates in this comparison.'),
    h('details', { className: 'quiet-details', id: 'all-estimates' },
      h('summary', {}, 'Compare all three estimates'),
      h('p', { className: 'helper' }, 'Here every commitment runs quick, as estimated, or long together.'),
      h('ul', { className: 'estimate-list' },
        levels.map(([key, label]) => {
          const schedule = after.evaluation[key];
          const cost = deadlineCost(schedule, state.days);
          const detail = cost
            ? `${dayLabel(cost.date)}: ${cost.marginHours < 0 ? `${hoursPhrase(-cost.marginHours)} short` : `${hoursPhrase(cost.marginHours)} to spare`}`
            : 'Nothing due';
          return h('li', {},
            h('strong', {}, label),
            ` — ${schedule.feasible ? 'fits' : "doesn't fit"}. ${detail}.`);
        })
      )
    )
  );
}

function renderSmallerOffer({ analysis, proposal, state, ui, dispatch, rerender }) {
  const active = ui.smaller && ui.smaller.active;
  if (!active && analysis.kind !== 'short') return null;
  if (!active && proposal.likely <= 0.5) return null;

  const statusLine = active
    ? (analysis.fits
        ? `The smaller version (${hoursPhrase(proposal.likely)}) fits. The full request (${hoursPhrase(ui.smaller.fullHours)}) didn't.`
        : `Even the smaller version (${hoursPhrase(proposal.likely)}) doesn't fit.`)
    : '';

  const scopeInput = h('input', {
    id: 'smaller-scope', name: 'scope', type: 'text', maxlength: '120', autocomplete: 'off',
    value: ui.smaller?.scope ?? '',
    placeholder: 'e.g. just the first draft'
  });
  const hoursInput = h('input', {
    id: 'smaller-hours', name: 'hours', type: 'number', inputmode: 'decimal', min: '0.5', step: '0.5',
    value: active ? String(proposal.likely) : '', placeholder: 'e.g. 2'
  });
  const error = h('p', { id: 'smaller-error', className: 'field-error', role: 'alert', hidden: true });

  return h('section', { id: 'smaller-offer', className: 'smaller-offer' },
    h('p', { className: 'eyebrow' }, 'Could you offer less?'),
    active ? h('p', { id: 'smaller-status', className: 'smaller-status', role: 'status' }, statusLine) : null,
    h('form', {
      id: 'smaller-form',
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        error.hidden = true;
        const fullHours = active ? ui.smaller.fullHours : proposal.likely;
        const fullFields = active ? ui.smaller.fullFields : null;
        const hours = Number(hoursInput.value);
        if (!isHalfHour(hours) || hours < 0.5) {
          error.textContent = 'Enter the hours in half-hour steps, such as 1.5 or 2.';
          error.hidden = false;
          return;
        }
        if (hours >= fullHours) {
          error.textContent = `A smaller version needs fewer than ${hoursPhrase(fullHours)}.`;
          error.hidden = false;
          return;
        }
        const base = fullFields ?? draftFromProposal(proposal, state);
        const next = {
          active: true,
          scope: scopeInput.value.trim(),
          fullHours,
          fullFields: base
        };
        try {
          ui.smaller = next;
          session.pendingFocus = true;
          dispatch({
            type: 'UPDATE_PROPOSAL',
            proposalId: proposal.id,
            fields: { ...base, likely: String(hours), min: '', max: '' }
          }, { rethrow: true });
        } catch (failure) {
          session.pendingFocus = false;
          ui.smaller = active ? ui.smaller : null;
          error.textContent = failure?.message || 'Could not check that smaller version.';
          error.hidden = false;
        }
      }
    },
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'smaller-scope' }, 'What would you do instead?'),
          scopeInput
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'smaller-hours' }, 'Estimated hours for that'),
          hoursInput
        )
      ),
      error,
      h('div', { className: 'form-submit-row' },
        h('button', { type: 'submit', className: 'button button-secondary' }, 'Check the smaller version'),
        active
          ? h('button', {
              type: 'button',
              className: 'link-button',
              onClick: () => {
                const fields = ui.smaller.fullFields;
                ui.smaller = null;
                session.pendingFocus = true;
                try {
                  dispatch({ type: 'UPDATE_PROPOSAL', proposalId: proposal.id, fields }, { rethrow: true });
                } catch {
                  session.pendingFocus = false;
                }
              }
            }, 'Back to the full request')
          : null
      )
    ),
    h('p', { className: 'option-note' },
      "A smaller version only counts as fitting once the check has run on it.")
  );
}

export function renderReplySlip({ analysis, proposal, state, ui, rerender }) {
  const smaller = ui.smaller && ui.smaller.active ? { active: true, scope: ui.smaller.scope } : null;
  const tabs = buildReplyTabs({ analysis, proposal, days: state.days, smaller, includeWorkload: false });
  const tabsSignature = `${analysis.signature}|${tabs.map(tab => tab.id).join(',')}`;
  // When the set of verified replies changes, start from the first one; otherwise keep the chosen tab.
  const tabIds = tabs.map(tab => tab.id).join(',');
  if (!ui.tab || ui.tabIds !== tabIds || !tabs.some(tab => tab.id === ui.tab)) ui.tab = tabs[0].id;
  ui.tabIds = tabIds;
  const current = tabs.find(tab => tab.id === ui.tab);

  if (!ui.touched || ui.text === current.text) {
    ui.touched = false;
    ui.text = current.text;
    ui.baseSignature = tabsSignature;
  }
  ui.autoText = current.text;
  // Edits survive a rerun. If the verified replies changed underneath them, say so.
  const flagged = ui.touched && tabsSignature !== ui.baseSignature;

  const textarea = h('textarea', {
    id: 'reply-text', className: 'reply-text', rows: '5', spellcheck: 'true', 'aria-describedby': 'reply-note'
  });
  textarea.value = ui.text;
  const fit = () => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight + 2}px`; };
  textarea.addEventListener('input', () => {
    ui.text = textarea.value;
    ui.touched = textarea.value !== ui.autoText;
    fit();
  });
  const copy = makeCopyControls(() => textarea.value);

  return h('section', { id: 'reply-slip', className: 'reply-slip', 'aria-labelledby': 'reply-title' },
    h('div', { className: 'slip-perforation', 'aria-hidden': 'true' }),
    h('div', {},
      h('h2', { id: 'reply-title', className: 'slip-title' }, "Here's what you could send."),
      h('p', { id: 'reply-hint', className: 'slip-hint' }, current.hint)),
    flagged
      ? h('div', { id: 'reply-flag', className: 'reply-flag', role: 'status' },
          h('strong', {}, 'Check this before sending.'),
          ' Your week changed since this was drafted, so what it says may no longer be right. Your edits are kept.',
          h('button', {
            type: 'button', className: 'link-button',
            onClick: () => { ui.baseSignature = tabsSignature; rerender(); }
          }, "I've checked it"))
      : null,
    h('div', { className: 'slip-tabs', role: 'tablist', 'aria-label': 'Kind of reply' },
      tabs.map(tab =>
        h('button', {
          type: 'button', role: 'tab', id: `tab-${tab.id}`, className: 'slip-tab',
          'aria-selected': String(tab.id === ui.tab),
          onClick: () => { ui.tab = tab.id; ui.touched = false; rerender(); }
        }, tab.label))),
    h('label', { for: 'reply-text', className: 'sr-only' }, 'Your reply, editable'),
    textarea,
    copy.button,
    copy.status,
    h('p', { id: 'reply-note', className: 'slip-caption' },
      [current.note, "Copying only copies. Your week doesn't change until you say so."].filter(Boolean).join(' ')),
    ui.touched
      ? h('button', {
          type: 'button', className: 'link-button center',
          onClick: () => { ui.touched = false; rerender(); }
        }, 'Use the suggested wording again')
      : null
  );
}

/** Who is waiting on an answer, switchable after the check. */
function renderAudienceToggle({ proposal, state, dispatch }) {
  const set = audience => {
    if ((proposal.audience === 'self' ? 'self' : 'others') === audience) return;
    const fields = draftFromProposal(proposal, state);
    dispatch({ type: 'UPDATE_PROPOSAL', proposalId: proposal.id, fields: { ...fields, audience } });
  };
  const self = proposal.audience === 'self';
  return h('div', { className: 'segmented', role: 'group', 'aria-label': 'Who is waiting' },
    h('button', { type: 'button', id: 'who-others', 'aria-pressed': String(!self), onClick: () => set('others') }, 'Someone else asked'),
    h('button', { type: 'button', id: 'who-self', 'aria-pressed': String(self), onClick: () => set('self') }, 'Just me'));
}

function renderDecisions({ analysis, proposal, after, dispatch }) {
  const proposalIds = [proposal.id];
  const selfServe = findSelfServeAcceptRepair(after.repairs, proposalIds);
  const forSelf = proposal.audience === 'self';
  const done = () => { resetRequestUi(); };
  const add = analysis.fits
    ? { label: 'Add it to my week', run: () => dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds, mode: 'accept', thenScreen: 'week' }) }
    : selfServe
      ? { label: 'Add it to my week, with this change', run: () => dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds, mode: 'accept-repair', repairId: selfServe.id, thenScreen: 'week' }) }
      : null;
  const anyway = !analysis.fits
    ? { label: 'Say yes anyway', run: () => dispatch({ type: 'NAVIGATE', screen: 'cost' }) }
    : null;
  const notNow = () => dispatch({ type: 'DISCARD_PROPOSAL', proposalIds, thenScreen: 'home' });
  const help = analysis.fits
    ? 'Nothing is added until you choose.'
    : analysis.option && analysis.option.needsApproval
      ? 'Wait for their reply before adding this. It goes on your week and the gap stays visible. It never takes sleep.'
      : 'It goes on your week and the gap stays visible. It never takes sleep.';

  if (forSelf) {
    const primary = add ?? anyway;
    return h('section', { id: 'check-decisions', className: 'decisions decisions-self' },
      h('p', { id: 'self-text', className: 'decision-text' },
        analysis.fits
          ? `Nobody to answer. It fits${analysis.afterCost ? ` with ${hoursPhrase(Math.max(0, analysis.afterCost.marginHours))} to spare` : ''}.`
          : `Nobody to answer, so this is just between you and the numbers. ${analysis.option ? `${analysis.option.label} makes it fit. ` : ''}Without a change, ${analysis.afterClause ? `you're ${analysis.afterClause.text}` : 'it does not fit'}.`),
      h('button', { type: 'button', className: 'button button-primary', onClick: () => { done(); primary.run(); } }, primary.label),
      add && anyway
        ? h('button', { type: 'button', className: 'link-button center', onClick: () => { done(); anyway.run(); } }, anyway.label)
        : null,
      h('button', { type: 'button', className: 'link-button center muted', onClick: () => { done(); notNow(); } }, 'Not now')
    );
  }
  const links = [add, anyway].filter(Boolean).map(item =>
    h('button', { type: 'button', className: 'link-button', onClick: () => { done(); item.run(); } }, item.label));
  return h('section', { id: 'check-decisions', className: 'decisions' },
    ...links,
    h('button', { type: 'button', className: 'link-button muted', onClick: () => { done(); notNow(); } }, 'Not now'),
    h('p', { className: 'decision-help' }, help)
  );
}

function renderBookedDetails({ analysis, proposal, state, derived, after, dispatch }) {
  const through = Math.max(proposal.targetDay, analysis.afterCost?.dayIndex ?? 0);
  const info = describeBookedWeek({
    state, derived, throughDayIndex: through, schedule: after.evaluation.typical
  });
  const errorBox = h('p', { id: 'busy-error', className: 'field-error', role: 'alert', hidden: true });
  const daySelect = h('select', { id: 'busy-day', name: 'day' },
    info.rows.map(row => h('option', { value: String(row.index) }, row.label)));
  const startInput = h('input', { id: 'busy-start', name: 'start', type: 'time', value: '09:00', step: '1800' });
  const endInput = h('input', { id: 'busy-end', name: 'end', type: 'time', value: '10:00', step: '1800' });

  const addForm = h('form', {
    id: 'busy-form',
    novalidate: true,
    onSubmit: ev => {
      ev.preventDefault();
      errorBox.hidden = true;
      try {
        session.focusSelectorAfterRender = '#busy-day';
        dispatch({
          type: 'ADD_BUSY_BLOCK',
          dayIndex: Number(daySelect.value),
          start: startInput.value,
          end: endInput.value
        }, { rethrow: true });
      } catch (failure) {
        session.focusSelectorAfterRender = null;
        errorBox.textContent = failure?.message || 'Could not add that block.';
        errorBox.hidden = false;
      }
    }
  },
    h('p', { className: 'eyebrow' }, 'Something missing? Add a fixed block'),
    h('div', { className: 'form-grid-three' },
      h('div', { className: 'form-field' }, h('label', { for: 'busy-day' }, 'Day'), daySelect),
      h('div', { className: 'form-field' }, h('label', { for: 'busy-start' }, 'From'), startInput),
      h('div', { className: 'form-field' }, h('label', { for: 'busy-end' }, 'To'), endInput)
    ),
    errorBox,
    h('div', { className: 'form-submit-row' },
      h('button', { type: 'submit', className: 'button button-secondary' }, 'Add block and check again'),
      h('button', {
        type: 'button', id: 'booked-to-week', className: 'link-button',
        onClick: () => { openWeekBusy(); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
      }, 'Edit in My week')
    )
  );

  return h('details', {
    id: 'booked-week',
    className: 'quiet-details booked',
    open: session.bookedOpen,
    onToggle: ev => { session.bookedOpen = ev.currentTarget.open; }
  },
    h('summary', {}, 'What the check counted'),
    h('p', { className: 'helper' },
      `This is everything the check counted from ${dayLabel(info.rows[0]?.date)} to ${dayLabel(info.rows[info.rows.length - 1]?.date)}.`),
    info.evidence.length
      ? h('ul', { className: 'evidence-list' }, info.evidence.map(line => h('li', {}, line)))
      : null,
    h('ul', { className: 'booked-days' },
      info.rows.map(row =>
        h('li', { className: 'booked-day' },
          h('strong', {}, row.label),
          h('div', { className: 'booked-line' },
            row.busy.length
              ? [
                  'Busy: ',
                  row.busy.map(block =>
                    h('span', { className: 'busy-chip' },
                      `${block.start}–${block.end}`,
                      h('button', {
                        type: 'button',
                        className: 'chip-remove',
                        'aria-label': `Remove busy block ${block.start} to ${block.end} on ${row.label}`,
                        onClick: () => {
                          session.focusSelectorAfterRender = '#booked-week summary';
                          dispatch({ type: 'REMOVE_BUSY_BLOCK', dayIndex: row.index, start: block.start, end: block.end });
                        }
                      }, 'Remove')
                    ))
                ]
              : 'No busy blocks.'
          ),
          h('div', { className: 'booked-line' },
            row.work.length
              ? `Work windows: ${row.work.map(win => `${win.start}–${win.end}`).join(', ')}. `
              : 'No work windows. ',
            `Free for work after busy blocks and sleep: ${hoursPhrase(row.availableHours)}.`
          )
        ))
    ),
    h('p', { className: 'eyebrow' }, 'Deadlines counted'),
    h('ul', { className: 'deadline-list' },
      [
        ...info.deadlines.map(item =>
          h('li', {}, `${item.title}, ${hoursPhrase(item.hours)}, due ${dayLabel(item.date)}`)),
        h('li', {}, `This request: ${proposal.title}, ${hoursPhrase(proposal.likely)}, due ${dayLabel(state.days[proposal.targetDay]?.date)}`)
      ]
    ),
    addForm
  );
}

/** The top link opens My week; this is the evidence under the answer. */
function renderBooked(args) {
  return renderBookedDetails(args);
}

function renderFullNumbers({ analysis, proposal, state, before, after }) {
  const beforeCost = deadlineCost(before.evaluation.typical, state.days);
  const withoutLine = analysis.baselineBroken && analysis.beforeClause
    ? `You're ${analysis.beforeClause.text}.`
    : beforeCost
      ? `Everything fits. Your tightest day, ${dayLabel(beforeCost.date)}, has ${hoursPhrase(Math.max(0, beforeCost.marginHours))} to spare.`
      : 'Nothing is due yet.';
  const dueLine = analysis.afterCost?.tasks?.length
    ? `Due by ${dayLabel(analysis.afterCost.date)}: ${analysis.afterCost.tasks.map(task => `${task.title} (${fmtHours(task.hours)})`).join(', ')}.`
    : '';
  return h('details', { id: 'full-numbers', className: 'quiet-details' },
    h('summary', {}, 'Full numbers'),
    h('div', { className: 'cost-statement-box' },
      h('p', {}, h('strong', {}, 'Without this request: '), withoutLine),
      h('p', {}, h('strong', {}, 'With this request: '), analysis.headline),
      dueLine ? h('p', {}, dueLine) : null,
      h('p', {}, `Added work: ${hoursPhrase(proposal.likely)} as estimated, between ${fmtHours(proposal.min)} and ${fmtHours(proposal.max)}.`)
    )
  );
}

function renderIncompleteNotes({ state, dispatch }) {
  if (state.calendarImportedAt || state.days.some(day => (day.busyWindows ?? []).length)) return null;
  return h('div', { id: 'incomplete-note', className: 'incomplete-note', role: 'note' },
    h('p', {}, "No timetable has been added, so classes and other fixed blocks aren't counted."),
    h('button', {
      type: 'button', id: 'note-add-timetable', className: 'link-button',
      onClick: () => { openWeekBusy(); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
    }, 'Add your timetable')
  );
}

/** Asks for work hours when the plan has none before the deadline, then re-runs the same check. */
function renderAvailabilityPrompt({ state, proposal, dispatch }) {
  const due = state.days[proposal.targetDay]?.date;
  const picker = renderRangePicker({
    idPrefix: 'avail',
    applyLabel: 'Use these hours and check',
    onApply: (indexes, start, end) => {
      session.pendingFocus = true;
      try {
        saveHoursFor(state, dispatch, indexes, start, end);
      } catch (failure) {
        session.pendingFocus = false;
        throw failure;
      }
    }
  });
  return h('section', { id: 'availability-prompt', className: 'availability-prompt card', 'aria-labelledby': 'availability-heading' },
    h('h1', { id: 'availability-heading', className: 'availability-headline', tabindex: '-1' },
      "When could you work on this before it's due?"),
    h('p', { className: 'vhero-lead' },
      `There are no work hours set before ${dayLabel(due)}, so there's nothing to check it against yet. Pick the hours you could use. What you entered stays as it is.`),
    picker,
    h('p', { className: 'option-note' }, 'These become your weekly work hours. You can change single days later in Settings.')
  );
}

const HOLDING_REPLY = "Got it, thanks! I'm looking at my week and will come back to you tomorrow morning.";

/**
 * "This can wait till morning": shown only when an engine run confirmed the work still fits if nothing
 * starts before morning (see verifyWait). Otherwise the normal verdict is shown instead.
 */
function renderWait({ wait, proposal, state, ui, rerender, animate }) {
  const days = namesJoined(wait.dayNames);
  const hero = h('section', { id: 'check-verdict', className: `vhero vhero-wait${animate ? ' rise' : ''}`, 'aria-labelledby': 'verdict-headline' },
    h('div', { className: 'eyebrow vhero-eyebrow' }, `${clockText(new Date())} · PAST YOUR WIND-DOWN`),
    h('h1', { id: 'verdict-headline', className: 'vhero-title vhero-title-wait', tabindex: '-1', role: 'status' }, 'This can wait till morning.'),
    h('p', { id: 'verdict-lead', className: 'vhero-lead' },
      `${proposal.title} isn't due until ${wait.dueName}, and ${days} ${wait.dayNames.length > 1 ? 'have' : 'has'} ${wait.spare > 0 ? 'room to spare' : 'just enough room'}. Nothing gets better by doing it now.`));
  const pct = value => `${Math.round(Math.min(100, (value / Math.max(wait.free, 0.5)) * 100) * 10) / 10}%`;
  const bar = h('section', {
    id: 'fit-bar', className: `fitbar${animate ? ' rise' : ''}`, role: 'img',
    'aria-label': `${days} have ${hoursPhrase(wait.free)} free. ${proposal.title} needs ${hoursPhrase(wait.need)}.`
  },
    h('div', { className: 'fitbar-head' }, h('span', {}, days), h('span', {}, `${hoursPhrase(wait.free)} free`)),
    h('div', { className: 'fitbar-track' }, h('div', { className: `fitbar-ok${animate ? ' grow' : ''}`, style: `width:${pct(wait.need)}` })),
    h('p', { className: 'fitbar-note' }, `${proposal.title} needs ${hoursPhrase(wait.need)}. It fits, with ${hoursPhrase(wait.spare)} to spare.`));
  const parts = [hero, bar];
  if (proposal.audience !== 'self') {
    if (!ui.waitTouched) ui.waitText = HOLDING_REPLY;
    const textarea = h('textarea', { id: 'reply-text', className: 'reply-text', rows: '3', spellcheck: 'true' });
    textarea.value = ui.waitText;
    const fit = () => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight + 2}px`; };
    textarea.addEventListener('input', () => { ui.waitText = textarea.value; ui.waitTouched = textarea.value !== HOLDING_REPLY; fit(); });
    const copy = makeCopyControls(() => textarea.value, 'Copy reply', 'Copied. Now go to sleep.');
    parts.push(h('section', { id: 'reply-slip', className: 'reply-slip', 'aria-labelledby': 'reply-title' },
      h('div', { className: 'slip-perforation', 'aria-hidden': 'true' }),
      h('div', {},
        h('h2', { id: 'reply-title', className: 'slip-title' }, "Here's what you could send."),
        h('p', { className: 'slip-hint' }, "A holding reply, so nobody's waiting on you while you sleep.")),
      h('label', { for: 'reply-text', className: 'sr-only' }, 'Your reply, editable'),
      textarea, copy.button, copy.status,
      h('p', { className: 'slip-caption' }, "Copying only copies. Your week doesn't change until you say so.")));
  }
  parts.push(h('p', { className: 'fine-print night-note' }, "I only say this when the numbers back it up. If it didn't fit, you'd hear that instead."));
  parts.push(h('button', { type: 'button', id: 'show-full', className: 'link-button center', onClick: () => { ui.showFull = true; rerender(); } }, 'Show the full answer'));
  return parts;
}

/**
 * Renders the Check screen: the answer, the one verified option, the reply.
 */
/** The analysis of the pending request, built exactly as the verdict screen builds it (shared with the cost screen). */
export function analysisForPending({ state, derived }) {
  const pending = state.proposals[0] ?? null;
  const checked = derived.commitmentCheck;
  if (!pending || !checked) return null;
  const ui = getUi(pending.id);
  return analyzeRequest({
    state, derived, proposal: pending, before: checked.before, after: checked.separate[0],
    smaller: ui.smaller && ui.smaller.active ? ui.smaller : null
  });
}

export function renderCheckScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const rerender = () => renderCheckScreen(container, ctx);
  const pending = state.proposals[0] ?? null;
  const checked = derived.commitmentCheck;
  if (!pending) session.editing = false;

  const parts = [];
  const showResults = Boolean(pending && checked && !session.editing);
  const animate = session.pendingFocus;
  setBlobTone('coral');

  if (showResults) {
    parts.push(
      h('div', { className: 'result-top' },
        h('button', {
          type: 'button', id: 'back-home', className: 'back-link',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'home' })
        },
          svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
            svg('path', { d: 'M11 3L5 9l6 6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
          'Home'),
        h('button', {
          type: 'button', id: 'see-booked', className: 'link-button',
          onClick: () => { openWeekBusy(); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
        }, "See what's booked")
      )
    );
  } else {
    parts.push(
      h('header', { className: 'screen-intro' },
        h('h1', { className: 'screen-title' }, 'Before you say yes.'),
        h('p', { className: 'screen-lede' },
          "Tell me what's on the table. I'll check it against your actual week.")
      )
    );
  }

  if (state.unresolvedConflict && !derived.evaluation.typical.feasible) {
    parts.push(
      h('div', { className: 'banner banner-warn', role: 'status' },
        h('div', { className: 'banner-body' },
          h('strong', {}, 'Your week already has a gap. '),
          'You added something earlier even though it did not fit. This check keeps that in mind.'
        ),
        h('button', {
          type: 'button', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
        }, 'See what can move')
      )
    );
  }

  let analysis = null;
  let availabilityShown = false;
  let waitShown = false;
  if (pending && checked && !session.editing) {
    const before = checked.before;
    const after = checked.separate[0];
    const ui = getUi(pending.id);
    analysis = analyzeRequest({
      state, derived, proposal: pending, before, after,
      smaller: ui.smaller && ui.smaller.active ? ui.smaller : null
    });

    parts.push(renderRequestSummary({ proposal: pending, state, rerender }));
    if (!hasWorkWindows(state.days.slice(0, pending.hardDay + 1))) {
      // Never a verdict without availability.
      analysis = null;
      parts.push(renderAvailabilityPrompt({ state, proposal: pending, dispatch }));
      parts.push(h('div', { className: 'section-actions' },
        h('button', {
          type: 'button', className: 'link-button',
          onClick: () => { resetRequestUi(); dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: [pending.id] }); }
        }, 'Not now')));
      availabilityShown = true;
    } else {
      setBlobTone(analysis.kind === 'short' ? 'coral' : 'sage');
      const layout = [];
      const wait = analysis.fits && !ui.showFull ? verifyWait({ state, derived, proposal: pending, now: new Date() }) : null;
      if (wait) {
        waitShown = true;
        parts.push(...renderWait({ wait, proposal: pending, state, ui, rerender, animate }));
        parts.push(renderDecisions({ analysis, proposal: pending, after, dispatch }));
      } else {
      layout.push(renderVerdict({ analysis, state, animate }));
      const bar = renderBar({ analysis, animate });
      if (bar) layout.push(bar);
      const learned = renderLearnedLine({ proposal: pending, derived, state, dispatch });
      if (learned) layout.push(learned);
      const option = renderOption({ analysis, state, dispatch, animate });
      if (option) layout.push(option);
      layout.push(renderAudienceToggle({ proposal: pending, state, dispatch }));
      const forOthers = pending.audience !== 'self';
      if (forOthers) layout.push(renderReplySlip({ analysis, proposal: pending, state, ui, rerender }));
      layout.push(renderDecisions({ analysis, proposal: pending, after, dispatch }));
      const incomplete = renderIncompleteNotes({ state, dispatch });
      if (incomplete) layout.push(incomplete);
      const range = renderEstimateRange(analysis, after, state);
      if (range) layout.push(range);
      const smallerOffer = forOthers ? renderSmallerOffer({ analysis, proposal: pending, state, ui, dispatch, rerender }) : null;
      if (smallerOffer) layout.push(smallerOffer);
      layout.push(renderBooked({ analysis, proposal: pending, state, derived, after, dispatch }));
      layout.push(renderFullNumbers({ analysis, proposal: pending, state, before, after }));
      parts.push(h('div', { className: 'check-layout' }, layout));
      }
    }

    if (state.proposals.length > 1) {
      parts.push(
        h('section', { className: 'extra-pending', id: 'extra-pending' },
          h('p', { className: 'eyebrow' }, 'Also waiting on a decision'),
          h('ul', {},
            state.proposals.slice(1).map(item =>
              h('li', {},
                `${item.title} (${hoursPhrase(item.likely)}) `,
                h('button', {
                  type: 'button', className: 'link-button',
                  onClick: () => dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: [item.id] })
                }, 'Not now')
              ))
          )
        )
      );
    }
  } else {
    parts.push(renderRequestForm({ state, derived, dispatch, pending, rerender, title: pending ? 'Change what you are checking' : "What's on the table?" }));
  }

  container.replaceChildren(...parts);
  // Size the reply box to its text so nothing is clipped.
  for (const area of container.querySelectorAll('.reply-text')) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  if (analysis) {
    if (session.pendingFocus) {
      session.pendingFocus = false;
      announce(waitShown ? 'This can wait till morning.' : `${analysis.bigWord} ${analysis.lead}`);
      const heading = document.getElementById('verdict-headline');
      heading?.focus({ preventScroll: false });
      heading?.scrollIntoView?.({ block: 'start' });
    }
  } else if (availabilityShown && session.pendingFocus) {
    session.pendingFocus = false;
    document.getElementById('availability-heading')?.focus();
  } else if (session.pendingFocus) {
    session.pendingFocus = false;
  }
  if (session.focusSelectorAfterRender) {
    const target = container.querySelector(session.focusSelectorAfterRender);
    session.focusSelectorAfterRender = null;
    target?.focus();
  }
}
