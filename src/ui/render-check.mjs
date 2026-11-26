import { defaultRange, roundHalfHour } from '../engine/commitments.mjs';
import { deadlineCost, verdictText } from '../engine/evaluate.mjs';
import { getEstimateSuggestion } from '../engine/feedback.mjs';
import { isHalfHour, TASK_TYPES } from '../engine/scheduler.mjs';
import {
  analyzeRequest,
  buildReply,
  dayLabel,
  describeBookedWeek,
  hoursPhrase
} from './check-model.mjs';
import {
  copyToClipboard,
  fmtHours,
  fmtSignedHours,
  h,
  taskTag,
  verdictLabel
} from './dom.mjs';
import { findSelfServeAcceptRepair } from './state.mjs';

const TASK_TYPE_LABELS = {
  other: { singular: 'other task', plural: 'other tasks', label: 'Other' },
  problem_set: { singular: 'problem set', plural: 'problem sets', label: 'Problem set' },
  lab: { singular: 'lab', plural: 'labs', label: 'Lab' },
  report: { singular: 'report', plural: 'reports', label: 'Report' },
  reading: { singular: 'reading', plural: 'readings', label: 'Reading' },
  project: { singular: 'project', plural: 'projects', label: 'Project' },
  club: { singular: 'club task', plural: 'club tasks', label: 'Club' }
};


// ---------------------------------------------------------------------------
// In-memory UI state. None of this is persisted and none of it is engine data:
// it only keeps what the student is typing across re-renders.
// ---------------------------------------------------------------------------

// Form fields being typed (new request) or edited (pending request).
let formDraft = null;
// True while the pending request is open for editing.
let editing = false;
// Per-request reply/smaller-offer state, keyed by proposal id.
const requestUi = new Map();
// One-shot flags used to move focus and announce the verdict after a check.
let pendingFocus = false;
let focusSelectorAfterRender = null;
let bookedOpen = false;
let moreOptionsOpen = false;

function getUi(proposalId) {
  if (!requestUi.has(proposalId)) {
    requestUi.set(proposalId, {
      text: '',
      autoText: '',
      touched: false,
      baseSignature: '',
      variant: 'decline',
      smaller: null
    });
  }
  return requestUi.get(proposalId);
}

function resetRequestUi() {
  requestUi.clear();
  editing = false;
}

function emptyDraft(state) {
  return {
    anchor: state.days[0]?.date ?? '',
    title: '',
    likely: '',
    min: '',
    max: '',
    // No default weekday: the student picks the real due date.
    deadline: '',
    tag: 'must-keep',
    latestDate: '',
    earliestDate: '',
    type: 'other'
  };
}

function draftFromProposal(proposal, state) {
  const range = defaultRange(proposal.likely);
  const date = index => state.days[index]?.date ?? '';
  return {
    anchor: state.days[0]?.date ?? '',
    title: proposal.title,
    likely: String(proposal.likely),
    min: proposal.min === range.min ? '' : String(proposal.min),
    max: proposal.max === range.max ? '' : String(proposal.max),
    deadline: date(proposal.targetDay),
    tag: taskTag(proposal),
    latestDate: proposal.flexible ? date(proposal.hardDay) : '',
    earliestDate: proposal.earliestDay > 0 ? date(proposal.earliestDay) : '',
    type: proposal.type ?? 'other'
  };
}

function getFormDraft(state, pending) {
  const firstDate = state.days[0]?.date ?? '';
  if (!formDraft || formDraft.anchor !== firstDate) {
    formDraft = editing && pending ? draftFromProposal(pending, state) : emptyDraft(state);
  }
  return formDraft;
}

export function resetCheckFormDraft() {
  formDraft = null;
  resetRequestUi();
}

/**
 * Maps an engine validation error message to the corresponding Commitment Check form field name.
 */
export function mapProposalErrorToField(message, fields = null) {
  const text = String(message ?? '');
  if (/^Name\b|ID and title/i.test(text)) return 'title';
  if (/^Typical hours\b/i.test(text)) return 'likely';
  if (/duration range|minimum ≤ typical ≤ maximum|half-hour duration increments/i.test(text)) {
    if (fields) {
      const hasMin = fields.min !== '' && fields.min !== null && fields.min !== undefined;
      const hasMax = fields.max !== '' && fields.max !== null && fields.max !== undefined;
      if (!hasMin && hasMax) return 'max';
      if (hasMax && !isHalfHour(Number(fields.max)) && (!hasMin || isHalfHour(Number(fields.min)))) {
        return 'max';
      }
      if (hasMax && Number(fields.max) < Number(fields.likely) && !(hasMin && Number(fields.min) > Number(fields.likely))) {
        return 'max';
      }
    }
    return 'min';
  }
  if (/^Latest acceptable date\b/i.test(text)) return 'latestDate';
  if (/^Earliest start\b|earliest start/i.test(text)) return 'earliestDate';
  if (/^Deadline\b|target\/hard deadline/i.test(text)) return 'deadline';
  if (/priority tag|Invalid priority/i.test(text)) return 'tag';
  if (/task type/i.test(text)) return 'type';
  return 'title';
}

/**
 * Computes the optional F3 learned estimate suggestion for a task type and entered typical hours.
 * Never mutates the student's entered value.
 */
export function describeEstimateSuggestion(profiles = [], type = 'other', typicalHours) {
  const profile = profiles.find(item => item.type === type) ?? { type, samples: 0, ratio: 1 };
  const labels = TASK_TYPE_LABELS[type] ?? TASK_TYPE_LABELS.other;

  if (profile.samples > 0 && profile.samples < 3) {
    return {
      status: 'learning',
      samples: profile.samples,
      ratio: profile.ratio,
      suggestedHours: null,
      text: `Estimate learning (${labels.label}): learning (${profile.samples} of 3 completed tasks logged).`
    };
  }

  const parsedHours = Number(typicalHours);
  if (profile.samples >= 3 && isHalfHour(parsedHours) && parsedHours >= 0.5) {
    const suggestedHours = getEstimateSuggestion(profile, parsedHours);
    if (suggestedHours !== null) {
      const displayRatio = Number(profile.ratio.toFixed(1));
      const exactRatio = Number(profile.ratio.toFixed(3));
      const ratioText = displayRatio === exactRatio
        ? `${displayRatio}×`
        : `${displayRatio}× (${exactRatio}×)`;
      return {
        status: 'ready',
        samples: profile.samples,
        ratio: profile.ratio,
        suggestedHours,
        text: `You said ${fmtHours(parsedHours)}. Your last ${profile.samples} ${labels.plural} took ${ratioText} your estimate. Use ${fmtHours(suggestedHours)}?`
      };
    }
  }

  return {
    status: 'none',
    samples: profile.samples,
    ratio: profile.ratio,
    suggestedHours: null,
    text: ''
  };
}

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

function renderExampleLine(state) {
  if (!state.demo) return null;
  const first = state.days[0]?.date;
  return h('p', { id: 'example-line', className: 'example-line' },
    `Example data: a sample week from ${first ? dayLabel(first) : ''}, not yours.`);
}

function renderRequestForm({ state, derived, dispatch, pending, rerender }) {
  const draft = getFormDraft(state, pending);
  const firstDate = state.days[0]?.date ?? '';
  const lastDate = state.days[state.days.length - 1]?.date ?? '';
  const isEdit = Boolean(editing && pending);

  const suggestionBox = h('div', { id: 'estimate-suggestion', className: 'suggestion-slot' });
  const rangePreview = h('small', { id: 'range-preview', className: 'field-hint' });
  const latestGroup = h('div', { id: 'latest-date-group', className: 'form-field', hidden: draft.tag !== 'flexible' });
  const formErrorBanner = h('p', { id: 'proposal-error', className: 'form-error-banner', role: 'alert', hidden: true });
  const fieldErrorNodes = {};
  const inputNodes = {};

  function makeFieldError(name) {
    const node = h('small', { id: `error-${name}`, className: 'field-error', role: 'alert', hidden: true });
    fieldErrorNodes[name] = node;
    return node;
  }

  function clearErrors() {
    formErrorBanner.textContent = '';
    formErrorBanner.hidden = true;
    for (const [name, errNode] of Object.entries(fieldErrorNodes)) {
      errNode.textContent = '';
      errNode.hidden = true;
      const input = inputNodes[name];
      if (input) {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }
  }

  function showValidationError(message, submittedFields = null) {
    clearErrors();
    const fieldName = mapProposalErrorToField(message, submittedFields);
    const errNode = fieldErrorNodes[fieldName];
    const input = inputNodes[fieldName];
    if (errNode) {
      errNode.textContent = message;
      errNode.hidden = false;
    }
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (errNode) input.setAttribute('aria-describedby', errNode.id);
      if (['min', 'max', 'tag', 'latestDate', 'earliestDate', 'type'].includes(fieldName)) {
        const details = document.getElementById('more-options');
        if (details) details.open = true;
      }
      input.focus();
    }
    formErrorBanner.textContent = message;
    formErrorBanner.hidden = false;
  }

  function updateDynamicHelpers() {
    const likelyNum = Number(draft.likely);
    if (isHalfHour(likelyNum) && likelyNum >= 0.5 && likelyNum <= 40) {
      const range = defaultRange(likelyNum);
      rangePreview.textContent = `Leave these blank and the check uses ${fmtHours(range.min)} as the quick case and ${fmtHours(range.max)} as the slow case.`;
    } else {
      rangePreview.textContent = 'Leave these blank and the check works out a quick case and a slow case from your estimate.';
    }

    const flexible = draft.tag === 'flexible';
    latestGroup.hidden = !flexible;
    if (!flexible) {
      draft.latestDate = '';
      if (inputNodes.latestDate) inputNodes.latestDate.value = '';
    }

    const info = describeEstimateSuggestion(derived.estimateProfiles, draft.type, draft.likely);
    if (info.status === 'ready' && info.suggestedHours !== likelyNum) {
      suggestionBox.replaceChildren(
        h('div', { className: 'estimate-suggestion-banner', role: 'status' },
          h('span', {}, info.text),
          h('button', {
            type: 'button',
            className: 'button button-secondary button-sm',
            onClick: () => {
              draft.likely = String(info.suggestedHours);
              if (inputNodes.likely) inputNodes.likely.value = draft.likely;
              updateDynamicHelpers();
            }
          }, `Use ${fmtHours(info.suggestedHours)}`)
        )
      );
    } else if (info.status === 'learning') {
      suggestionBox.replaceChildren(h('p', { className: 'field-hint learning-note' }, info.text));
    } else {
      suggestionBox.replaceChildren();
    }
  }

  const on = (name, extra) => ev => {
    draft[name] = ev.currentTarget.value;
    clearErrors();
    extra?.();
  };

  inputNodes.title = h('input', {
    id: 'proposal-title', name: 'title', type: 'text', maxlength: '80', required: true,
    autocomplete: 'off', value: draft.title,
    placeholder: 'e.g. Help with the club poster',
    onInput: on('title')
  });
  inputNodes.likely = h('input', {
    id: 'proposal-likely', name: 'likely', type: 'number', inputmode: 'decimal',
    min: '0.5', max: '40', step: '0.5', required: true, value: draft.likely,
    placeholder: 'e.g. 4',
    onInput: on('likely', updateDynamicHelpers)
  });
  inputNodes.deadline = h('input', {
    id: 'proposal-deadline', name: 'deadline', type: 'date',
    min: firstDate, max: lastDate, required: true, value: draft.deadline,
    onInput: on('deadline')
  });
  inputNodes.min = h('input', {
    id: 'proposal-min', name: 'min', type: 'number', inputmode: 'decimal',
    min: '0', max: '40', step: '0.5', value: draft.min, placeholder: 'Automatic',
    onInput: on('min')
  });
  inputNodes.max = h('input', {
    id: 'proposal-max', name: 'max', type: 'number', inputmode: 'decimal',
    min: '0', max: '60', step: '0.5', value: draft.max, placeholder: 'Automatic',
    onInput: on('max')
  });
  inputNodes.tag = h('select', {
    id: 'proposal-tag', name: 'tag', onChange: on('tag', updateDynamicHelpers)
  },
    h('option', { value: 'must-keep', selected: draft.tag === 'must-keep' }, 'Must do, fixed deadline'),
    h('option', { value: 'flexible', selected: draft.tag === 'flexible' }, 'Flexible, can slip to a later day'),
    h('option', { value: 'droppable', selected: draft.tag === 'droppable' }, 'Optional, I could drop it')
  );
  inputNodes.latestDate = h('input', {
    id: 'proposal-latest', name: 'latestDate', type: 'date',
    min: firstDate, max: lastDate, value: draft.latestDate,
    onInput: on('latestDate')
  });
  inputNodes.earliestDate = h('input', {
    id: 'proposal-earliest', name: 'earliestDate', type: 'date',
    min: firstDate, max: lastDate, value: draft.earliestDate,
    onInput: on('earliestDate')
  });
  inputNodes.type = h('select', {
    id: 'proposal-type', name: 'type', onChange: on('type', updateDynamicHelpers)
  },
    TASK_TYPES.map(typeKey =>
      h('option', { value: typeKey, selected: draft.type === typeKey },
        (TASK_TYPE_LABELS[typeKey] ?? TASK_TYPE_LABELS.other).label)
    )
  );

  latestGroup.replaceChildren(
    h('label', { for: 'proposal-latest' }, 'Latest day it could be done (optional)'),
    inputNodes.latestDate,
    h('small', { className: 'field-hint' }, 'Left blank, a flexible request can slip by one day.'),
    makeFieldError('latestDate')
  );

  updateDynamicHelpers();

  const moreOptions = h('details', {
    id: 'more-options',
    className: 'more-options',
    open: moreOptionsOpen,
    onToggle: ev => { moreOptionsOpen = ev.currentTarget.open; }
  },
    h('summary', {}, 'More options'),
    h('div', { className: 'more-options-body' },
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-min' }, 'Quickest it could take (hours)'),
          inputNodes.min,
          makeFieldError('min')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-max' }, 'Longest it could take (hours)'),
          inputNodes.max,
          makeFieldError('max')
        )
      ),
      rangePreview,
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-tag' }, 'How firm is it?'),
          inputNodes.tag,
          makeFieldError('tag')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-type' }, 'What kind of task is it?'),
          inputNodes.type,
          h('small', { className: 'field-hint' }, 'Helps the app learn how long your tasks really take.'),
          makeFieldError('type')
        )
      ),
      latestGroup,
      h('div', { className: 'form-field' },
        h('label', { for: 'proposal-earliest' }, 'Can\'t start before (optional)'),
        inputNodes.earliestDate,
        h('small', { className: 'field-hint' }, `Left blank, work can start from the first loaded day (${dayLabel(firstDate)}).`),
        makeFieldError('earliestDate')
      )
    )
  );

  return h('section', { className: 'check-form-panel', 'aria-label': isEdit ? 'Edit your request' : 'New request' },
    h('form', {
      id: 'proposal-form',
      className: 'commitment-form',
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        clearErrors();
        const fields = {
          title: inputNodes.title.value,
          likely: inputNodes.likely.value,
          min: inputNodes.min.value,
          max: inputNodes.max.value,
          deadline: inputNodes.deadline.value,
          tag: inputNodes.tag.value,
          latestDate: inputNodes.latestDate.value,
          earliestDate: inputNodes.earliestDate.value,
          type: inputNodes.type.value
        };
        try {
          if (isEdit) {
            const ui = getUi(pending.id);
            ui.smaller = null;
            pendingFocus = true;
            // Leave edit mode first: dispatch re-renders synchronously.
            editing = false;
            const keptDraft = formDraft;
            formDraft = null;
            try {
              dispatch({ type: 'UPDATE_PROPOSAL', proposalId: pending.id, fields }, { rethrow: true });
            } catch (failure) {
              editing = true;
              formDraft = keptDraft;
              throw failure;
            }
          } else {
            resetRequestUi();
            pendingFocus = true;
            dispatch({ type: 'ADD_PROPOSAL', fields }, { rethrow: true });
            formDraft = null;
          }
        } catch (error) {
          pendingFocus = false;
          showValidationError(error?.message || 'Check the details you entered.', fields);
        }
      }
    },
      h('div', { className: 'form-field' },
        h('label', { for: 'proposal-title' }, 'What are you being asked to do?'),
        inputNodes.title,
        makeFieldError('title')
      ),
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-likely' }, 'About how many hours will it take?'),
          inputNodes.likely,
          makeFieldError('likely'),
          suggestionBox
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-deadline' }, 'When is it due?'),
          inputNodes.deadline,
          makeFieldError('deadline')
        )
      ),
      moreOptions,
      formErrorBanner,
      h('div', { className: 'form-submit-row' },
        h('button', { type: 'submit', className: 'button button-primary button-large' },
          isEdit ? 'Check again' : 'Check it'),
        isEdit
          ? h('button', {
              type: 'button',
              className: 'link-button',
              onClick: () => {
                editing = false;
                formDraft = null;
                rerender();
              }
            }, 'Cancel')
          : null
      )
    )
  );
}

function renderRequestSummary({ proposal, state, rerender }) {
  const dueDate = state.days[proposal.targetDay]?.date;
  return h('section', { className: 'request-summary', 'aria-label': 'Your request' },
    h('div', {},
      h('p', { className: 'eyebrow' }, 'Your request'),
      h('p', { className: 'request-title' }, proposal.title),
      h('p', { className: 'request-meta' },
        `${hoursPhrase(proposal.likely)} of work, due ${dayLabel(dueDate)}`)
    ),
    h('button', {
      type: 'button',
      id: 'edit-request',
      className: 'link-button',
      onClick: () => {
        editing = true;
        formDraft = null;
        rerender();
        document.getElementById('proposal-title')?.focus();
      }
    }, 'Edit request')
  );
}

const VERDICT_WORDS = { fits: 'Fits', tight: 'Tight', short: "Doesn't fit" };

function renderVerdict({ analysis, state }) {
  const proposalNote = analysis.baselineBroken && analysis.kind === 'short'
    ? "Your week already had a gap before this request, so the numbers above show both."
    : '';
  return h('section', {
    id: 'check-verdict',
    className: `verdict-block verdict-${analysis.kind}`,
    'aria-labelledby': 'verdict-headline'
  },
    h('p', { className: `verdict-word verdict-word-${analysis.kind}` }, VERDICT_WORDS[analysis.kind]),
    h('h2', { id: 'verdict-headline', className: 'verdict-headline', tabindex: '-1' }, analysis.headline),
    analysis.detail ? h('p', { className: 'verdict-detail' }, analysis.detail) : null,
    proposalNote ? h('p', { className: 'verdict-detail' }, proposalNote) : null,
    analysis.kind === 'short' && analysis.option && analysis.afterClause?.kind === 'hours' && analysis.afterClause.hours >= 2
      ? h('p', { className: 'aside-line' }, 'That would need the 25th hour. Here is one way to get some time back.')
      : null,
    h('p', { className: 'verdict-sleep' },
      `Sleep stays protected (${state.sleep.start}–${state.sleep.end}) in every number here.`)
  );
}

function renderOption({ analysis, state, dispatch }) {
  if (analysis.kind === 'fits') return null;
  if (!analysis.option) {
    if (analysis.kind === 'tight') return null;
    return h('section', { id: 'check-option', className: 'option-card option-none' },
      h('p', { className: 'eyebrow' }, 'Verified option'),
      h('h3', {}, 'No change makes this fit.'),
      h('p', {}, analysis.noOptionText)
    );
  }
  const option = analysis.option;
  const resultText = option.spareHours !== null
    ? `With that change it fits. Your tightest day, ${dayLabel(option.spareDate)}, still has ${hoursPhrase(option.spareHours)} to spare.`
    : 'With that change it fits.';
  const lead = analysis.kind === 'tight' ? 'If you want more room' : 'One change that would make it fit';
  return h('section', { id: 'check-option', className: `option-card${option.needsApproval ? ' option-approval' : ''}` },
    h('div', { className: 'option-head' },
      h('p', { className: 'eyebrow' }, 'Verified option'),
      h('span', { className: `option-tag ${option.needsApproval ? 'needs-approval' : 'self-serve'}` },
        option.needsApproval ? 'If approved' : 'You can do this yourself')
    ),
    h('h3', {}, lead),
    h('p', { className: 'option-label' }, option.label),
    h('p', { className: 'option-result' }, resultText),
    option.needsApproval
      ? h('p', { className: 'option-note' },
          'This needs someone else to agree first. Until they do, nothing in your week changes.')
      : null,
    h('p', { className: 'option-note' },
      'Checked against your other commitments, sleep protected.'),
    analysis.alternative
      ? h('p', { className: 'option-note' },
          `A change you can make yourself: ${analysis.alternative.label}.`)
      : null
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
    h('p', { className: 'eyebrow' }, 'It depends on the estimate'),
    h('p', { className: 'range-sentence' }, analysis.range.sentence),
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
          pendingFocus = true;
          dispatch({
            type: 'UPDATE_PROPOSAL',
            proposalId: proposal.id,
            fields: { ...base, likely: String(hours), min: '', max: '' }
          }, { rethrow: true });
        } catch (failure) {
          pendingFocus = false;
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
                pendingFocus = true;
                try {
                  dispatch({ type: 'UPDATE_PROPOSAL', proposalId: proposal.id, fields }, { rethrow: true });
                } catch {
                  pendingFocus = false;
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

function renderReplySlip({ analysis, proposal, state, ui, rerender }) {
  const smaller = ui.smaller && ui.smaller.active
    ? { active: true, scope: ui.smaller.scope }
    : null;
  const reply = buildReply({
    analysis,
    proposal,
    days: state.days,
    variant: ui.variant,
    smaller,
    includeWorkload: false
  });

  if (!ui.touched || ui.text === reply.text) {
    ui.touched = false;
    ui.text = reply.text;
    ui.baseSignature = analysis.signature;
  }
  ui.autoText = reply.text;
  const flagged = ui.touched && analysis.signature !== ui.baseSignature;

  const textarea = h('textarea', {
    id: 'reply-text',
    className: 'reply-text',
    rows: '6',
    spellcheck: 'true',
    'aria-describedby': 'reply-note'
  });
  textarea.value = ui.text;
  textarea.addEventListener('input', () => {
    ui.text = textarea.value;
    ui.touched = textarea.value !== ui.autoText;
  });

  const copyStatus = h('span', {
    id: 'copy-status', className: 'copy-status', role: 'status', 'aria-live': 'polite'
  });
  let copyTimer = null;

  const copyButton = h('button', {
    type: 'button',
    id: 'copy-reply',
    className: 'button button-primary',
    // Copying only writes text to the clipboard. It never dispatches to the
    // store, so it cannot accept a request, record an approval or apply a repair.
    onClick: async () => {
      const ok = await copyToClipboard(textarea.value);
      copyStatus.textContent = ok ? 'Copied' : "Couldn't copy. Select the text and copy it yourself.";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyStatus.textContent = ''; }, 3000);
    }
  }, 'Copy reply');

  const variantControls = analysis.replyKind === 'decline'
    ? h('div', { className: 'variant-toggle', role: 'group', 'aria-label': 'What kind of reply' },
        [['decline', 'Say no kindly'], ['flex', 'Ask for flexibility']].map(([value, label]) =>
          h('button', {
            type: 'button',
            className: `button button-quiet${ui.variant === value ? ' is-on' : ''}`,
            'aria-pressed': String(ui.variant === value),
            onClick: () => {
              ui.variant = value;
              ui.touched = false;
              rerender();
            }
          }, label))
      )
    : null;

  return h('section', { id: 'reply-slip', className: 'reply-slip', 'aria-labelledby': 'reply-title' },
    h('div', { className: 'slip-head' },
      h('h3', { id: 'reply-title' }, "Here's what you could send"),
      h('span', { className: 'slip-kind' }, reply.label)
    ),
    flagged
      ? h('div', { id: 'reply-flag', className: 'reply-flag', role: 'status' },
          h('strong', {}, 'Check this before sending.'),
          ' Your week changed since this was drafted, so what it says may no longer be right. Your edits are kept.',
          h('button', {
            type: 'button',
            className: 'button button-outline button-sm',
            onClick: () => {
              ui.baseSignature = analysis.signature;
              rerender();
            }
          }, "I've checked it")
        )
      : null,
    variantControls,
    h('label', { for: 'reply-text', className: 'sr-only' }, 'Reply draft. You can edit it.'),
    textarea,
    h('p', { id: 'reply-note', className: 'slip-note' },
      [reply.note, 'Copying adds nothing to your week and sends nothing.']
        .filter(Boolean).join(' ')),
    h('div', { className: 'slip-actions' },
      copyButton,
      copyStatus,
      ui.touched
        ? h('button', {
            type: 'button',
            className: 'link-button',
            onClick: () => { ui.touched = false; rerender(); }
          }, 'Use the suggested wording again')
        : null
    )
  );
}

function renderDecisions({ analysis, proposal, after, dispatch, ui }) {
  const proposalIds = [proposal.id];
  const selfServe = findSelfServeAcceptRepair(after.repairs, proposalIds);
  const done = () => { resetRequestUi(); };
  const buttons = [];

  if (analysis.fits) {
    buttons.push(h('button', {
      type: 'button', className: 'button button-primary',
      onClick: () => { done(); dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds, mode: 'accept' }); }
    }, 'Add it to my week'));
  } else {
    if (selfServe) {
      buttons.push(h('button', {
        type: 'button', className: 'button button-primary',
        onClick: () => {
          done();
          dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds, mode: 'accept-repair', repairId: selfServe.id });
        }
      }, 'Add it with this change'));
    }
    buttons.push(h('button', {
      type: 'button', className: 'link-button',
      onClick: () => { done(); dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds, mode: 'override' }); }
    }, 'Add it anyway'));
  }
  buttons.push(h('button', {
    type: 'button', className: 'link-button',
    onClick: () => { done(); dispatch({ type: 'DISCARD_PROPOSAL', proposalIds }); }
  }, 'Not now'));

  return h('section', { id: 'check-decisions', className: 'decisions' },
    h('p', { className: 'eyebrow' }, 'Your week'),
    h('p', { className: 'decision-help' },
      analysis.fits
        ? 'Nothing is added until you choose.'
        : analysis.option && analysis.option.needsApproval
          ? 'Wait for the reply before adding this. Adding it anyway keeps the shortfall visible on your week.'
          : "Adding it anyway keeps the shortfall visible on your week. It never takes time from your sleep."),
    h('div', { className: 'decision-actions' }, buttons)
  );
}

function renderBooked({ analysis, proposal, state, derived, after, dispatch }) {
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
        focusSelectorAfterRender = '#busy-day';
        dispatch({
          type: 'ADD_BUSY_BLOCK',
          dayIndex: Number(daySelect.value),
          start: startInput.value,
          end: endInput.value
        }, { rethrow: true });
      } catch (failure) {
        focusSelectorAfterRender = null;
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
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, 'Edit in My week')
    )
  );

  return h('details', {
    id: 'booked-week',
    className: 'quiet-details booked',
    open: bookedOpen,
    onToggle: ev => { bookedOpen = ev.currentTarget.open; }
  },
    h('summary', {}, "See what's booked"),
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
                          focusSelectorAfterRender = '#booked-week summary';
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

function renderIncompleteNotes({ state, analysis }) {
  const notes = [];
  if (!state.calendarImportedAt && !state.demo) {
    notes.push("No calendar has been imported. Classes and other fixed blocks only count if you've added them.");
  }
  const anyWork = state.days.some(day => (day.workWindows ?? []).length);
  if (!anyWork) notes.push('No work windows are set, so there are no hours to schedule into.');
  if (!notes.length) return null;
  return h('div', { id: 'incomplete-note', className: 'incomplete-note', role: 'note' },
    notes.map(note => h('p', {}, note))
  );
}

/**
 * Renders the Check screen: ask, verdict, one verified option, reply.
 */
export function renderCheckScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const rerender = () => renderCheckScreen(container, ctx);
  const pending = state.proposals[0] ?? null;
  const checked = derived.commitmentCheck;
  if (!pending) editing = false;

  const parts = [];
  const showResults = Boolean(pending && checked && !editing);
  if (!showResults) parts.push(
    h('header', { className: 'screen-intro' },
      h('h1', { className: 'screen-title' }, 'Check a request'),
      h('p', { className: 'screen-lede' },
        'Someone asked you to take on one more thing. Tell me about it and I will check it against your real week.')
    )
  );

  const exampleBlock = renderExampleLine(state);
  if (exampleBlock) parts.push(exampleBlock);

  if (state.unresolvedConflict && !derived.evaluation.typical.feasible) {
    parts.push(
      h('div', { className: 'banner banner-warn', role: 'status' },
        h('div', { className: 'banner-body' },
          h('strong', {}, 'Your week already has a gap. '),
          'You added something earlier even though it did not fit. This check keeps that in mind.'
        ),
        h('button', {
          type: 'button', className: 'button button-outline button-sm',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
        }, 'See what can move')
      )
    );
  }

  let analysis = null;
  if (pending && checked && !editing) {
    const index = 0;
    const before = checked.before;
    const after = checked.separate[index];
    const ui = getUi(pending.id);
    analysis = analyzeRequest({
      state, derived, proposal: pending, before, after,
      smaller: ui.smaller && ui.smaller.active ? ui.smaller : null
    });

    parts.push(renderRequestSummary({ proposal: pending, state, rerender }));
    parts.push(renderVerdict({ analysis, state }));
    const incomplete = renderIncompleteNotes({ state, analysis });
    if (incomplete) parts.push(incomplete);
    const option = renderOption({ analysis, state, dispatch });
    if (option) parts.push(option);
    parts.push(renderReplySlip({ analysis, proposal: pending, state, ui, rerender }));
    const range = renderEstimateRange(analysis, after, state);
    if (range) parts.push(range);
    const smallerOffer = renderSmallerOffer({ analysis, proposal: pending, state, ui, dispatch, rerender });
    if (smallerOffer) parts.push(smallerOffer);
    parts.push(renderDecisions({ analysis, proposal: pending, after, dispatch, ui }));
    parts.push(renderBooked({ analysis, proposal: pending, state, derived, after, dispatch }));
    parts.push(renderFullNumbers({ analysis, proposal: pending, state, before, after }));

    if (state.proposals.length > 1) {
      parts.push(
        h('section', { className: 'extra-pending', id: 'extra-pending' },
          h('p', { className: 'eyebrow' }, 'Also waiting on a decision'),
          h('ul', {},
            state.proposals.slice(1).map(item =>
              h('li', {},
                `${item.title} (${hoursPhrase(item.likely)}) `,
                h('button', {
                  type: 'button', className: 'button button-quiet button-sm',
                  onClick: () => dispatch({ type: 'DISCARD_PROPOSAL', proposalIds: [item.id] })
                }, 'Not now')
              ))
          )
        )
      );
    }
  } else {
    parts.push(renderRequestForm({ state, derived, dispatch, pending, rerender }));
  }

  container.replaceChildren(...parts);

  if (analysis) {
    if (pendingFocus) {
      pendingFocus = false;
      announce(`${VERDICT_WORDS[analysis.kind]}. ${analysis.headline}`);
      const heading = document.getElementById('verdict-headline');
      heading?.focus({ preventScroll: false });
      heading?.scrollIntoView?.({ block: 'start' });
    }
  } else if (pendingFocus) {
    pendingFocus = false;
  }
  if (focusSelectorAfterRender) {
    const target = container.querySelector(focusSelectorAfterRender);
    focusSelectorAfterRender = null;
    target?.focus();
  }
}
