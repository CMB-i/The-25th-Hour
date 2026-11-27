import { defaultRange } from '../engine/commitments.mjs';
import { campusDate, getEstimateSuggestion } from '../engine/feedback.mjs';
import { isHalfHour, TASK_TYPES } from '../engine/scheduler.mjs';
import { session, getUi, resetRequestUi } from './check-session.mjs';
import { dayLabel } from './check-model.mjs';
import { fmtHours, h, taskTag } from './dom.mjs';

const TASK_TYPE_LABELS = {
  other: { singular: 'other task', plural: 'other tasks', label: 'Other' },
  problem_set: { singular: 'problem set', plural: 'problem sets', label: 'Problem set' },
  lab: { singular: 'lab', plural: 'labs', label: 'Lab' },
  report: { singular: 'report', plural: 'reports', label: 'Report' },
  reading: { singular: 'reading', plural: 'readings', label: 'Reading' },
  project: { singular: 'project', plural: 'projects', label: 'Project' },
  club: { singular: 'club task', plural: 'club tasks', label: 'Club' }
};

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
  if (/^Deadline\b|target\/hard deadline|when it's due/i.test(text)) return 'deadline';
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

// A task type the student did not pick can still be recognised from the words they used.
// This only decides which learned profile to look at; every number still comes from the estimate-learning API.
const TYPE_HINTS = [
  [/problem set|pset/i, 'problem_set'],
  [/\blab\b/i, 'lab'],
  [/report|essay|paper/i, 'report'],
  [/\bread/i, 'reading'],
  [/project/i, 'project'],
  [/club|poster|society/i, 'club']
];

export function effectiveTaskType(type, title) {
  if (type && type !== 'other') return type;
  const hit = TYPE_HINTS.find(([pattern]) => pattern.test(String(title ?? '')));
  return hit ? hit[1] : 'other';
}


// ---------------------------------------------------------------------------
// Draft handling
// ---------------------------------------------------------------------------

function emptyDraft(state) {
  return {
    anchor: state.days[0]?.date ?? '',
    title: '',
    likely: '3',
    min: '',
    max: '',
    deadline: '',
    tag: 'must-keep',
    latestDate: '',
    earliestDate: '',
    type: 'other',
    audience: 'others'
  };
}

export function draftFromProposal(proposal, state) {
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
    type: proposal.type ?? 'other',
    audience: proposal.audience === 'self' ? 'self' : 'others'
  };
}

function getFormDraft(state, pending) {
  const firstDate = state.days[0]?.date ?? '';
  if (!session.formDraft || session.formDraft.anchor !== firstDate) {
    session.formDraft = session.editing && pending ? draftFromProposal(pending, state) : emptyDraft(state);
  }
  return session.formDraft;
}

/** The next few due dates as chips, from today: tomorrow, +2, +3 and "Next wk". All within the loaded weeks. */
export function dueChoices(state, now = new Date()) {
  const today = campusDate(now.toISOString());
  const base = state.days.findIndex(day => day.date === today);
  const from = base;
  const picks = [];
  for (const offset of [1, 2, 3]) {
    const day = state.days[from + offset];
    if (day) picks.push({ date: day.date, label: dayLabel(day.date).split(' ')[0].slice(0, 3) });
  }
  const next = state.days[from + 7];
  if (next) picks.push({ date: next.date, label: 'Next wk' });
  return picks.map(pick => ({ ...pick, aria: dayLabel(pick.date) }));
}

const hoursText = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${n} ${n === 1 ? 'hour' : 'hours'}`;
};

const nextHours = (value, direction) => {
  const n = Number(value);
  const base = Number.isFinite(n) && n > 0 ? n : 3;
  const step = direction > 0 ? (base < 4 ? 0.5 : 1) : (base <= 4 ? 0.5 : 1);
  return Math.min(40, Math.max(0.5, Math.round((base + direction * step) * 2) / 2));
};

/**
 * The request form: what, how long, when, who is waiting. Shared by Home and Check (edit).
 * Advanced fields stay under More options with their defaults.
 */
export function renderRequestForm({ state, derived, dispatch, pending, rerender, onSubmitted, title = "What's on the table?" }) {
  const draft = getFormDraft(state, pending);
  const firstDate = state.days[0]?.date ?? '';
  const lastDate = state.days[state.days.length - 1]?.date ?? '';
  const isEdit = Boolean(session.editing && pending);

  const suggestionBox = h('div', { id: 'estimate-suggestion', className: 'suggestion-slot' });
  const rangePreview = h('small', { id: 'range-preview', className: 'field-hint' });
  const latestGroup = h('div', { id: 'latest-date-group', className: 'form-field', hidden: draft.tag !== 'flexible' });
  const formErrorBanner = h('p', { id: 'proposal-error', className: 'form-error-banner', role: 'alert', hidden: true });
  const fieldErrorNodes = {};
  const inputNodes = {};
  const hoursOut = h('span', { id: 'hours-out', className: 'step-value', 'aria-live': 'polite' }, hoursText(draft.likely));
  const dueRow = h('div', { className: 'chip-row even', role: 'group', 'aria-label': 'Due date', id: 'due-chips' });

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
      if (input.type !== 'hidden') input.focus();
    }
    formErrorBanner.textContent = message;
    formErrorBanner.hidden = false;
  }

  function refreshHours() {
    hoursOut.textContent = hoursText(draft.likely);
  }

  function refreshDue() {
    for (const chip of dueRow.querySelectorAll('button')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.date === draft.deadline));
    }
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
    const info = describeEstimateSuggestion(derived.estimateProfiles, effectiveTaskType(draft.type, draft.title), draft.likely);
    if (info.status === 'ready' && info.suggestedHours !== likelyNum) {
      suggestionBox.replaceChildren(
        h('div', { className: 'learned-line', role: 'status' },
          h('span', {}, info.text),
          h('button', {
            type: 'button', className: 'learned-btn',
            onClick: () => {
              draft.likely = String(info.suggestedHours);
              inputNodes.likely.value = draft.likely;
              refreshHours();
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
    autocomplete: 'off', value: draft.title, className: 'text-input',
    placeholder: 'e.g. Sponsor deck for the club',
    onInput: on('title', updateDynamicHelpers)
  });
  inputNodes.likely = h('input', {
    id: 'proposal-likely', name: 'likely', type: 'hidden', value: draft.likely
  });
  inputNodes.likely.addEventListener('input', () => { draft.likely = inputNodes.likely.value; refreshHours(); clearErrors(); updateDynamicHelpers(); });
  inputNodes.deadline = h('input', {
    id: 'proposal-deadline', name: 'deadline', type: 'date',
    min: firstDate, max: lastDate, required: true, value: draft.deadline,
    onInput: ev => { draft.deadline = ev.currentTarget.value; clearErrors(); refreshDue(); }
  });
  inputNodes.min = h('input', {
    id: 'proposal-min', name: 'min', type: 'number', inputmode: 'decimal',
    min: '0', max: '40', step: '0.5', value: draft.min, placeholder: 'Automatic', onInput: on('min')
  });
  inputNodes.max = h('input', {
    id: 'proposal-max', name: 'max', type: 'number', inputmode: 'decimal',
    min: '0', max: '60', step: '0.5', value: draft.max, placeholder: 'Automatic', onInput: on('max')
  });
  inputNodes.tag = h('select', { id: 'proposal-tag', name: 'tag', onChange: on('tag', updateDynamicHelpers) },
    h('option', { value: 'must-keep', selected: draft.tag === 'must-keep' }, 'Must do, fixed deadline'),
    h('option', { value: 'flexible', selected: draft.tag === 'flexible' }, 'Flexible, can slip to a later day'),
    h('option', { value: 'droppable', selected: draft.tag === 'droppable' }, 'Optional, I could drop it')
  );
  inputNodes.latestDate = h('input', {
    id: 'proposal-latest', name: 'latestDate', type: 'date', min: firstDate, max: lastDate,
    value: draft.latestDate, onInput: on('latestDate')
  });
  inputNodes.earliestDate = h('input', {
    id: 'proposal-earliest', name: 'earliestDate', type: 'date', min: firstDate, max: lastDate,
    value: draft.earliestDate, onInput: on('earliestDate')
  });
  inputNodes.type = h('select', { id: 'proposal-type', name: 'type', onChange: on('type', updateDynamicHelpers) },
    TASK_TYPES.map(typeKey =>
      h('option', { value: typeKey, selected: draft.type === typeKey },
        (TASK_TYPE_LABELS[typeKey] ?? TASK_TYPE_LABELS.other).label))
  );

  // Due-date chips; the date field under "Pick a date" stays the source of truth.
  for (const choice of dueChoices(state)) {
    dueRow.append(h('button', {
      type: 'button', className: 'chip', 'aria-pressed': String(draft.deadline === choice.date),
      'aria-label': choice.aria, dataset: { date: choice.date },
      onClick: () => {
        draft.deadline = choice.date;
        inputNodes.deadline.value = choice.date;
        clearErrors();
        refreshDue();
      }
    }, choice.label));
  }

  latestGroup.replaceChildren(
    h('label', { for: 'proposal-latest' }, 'Latest day it could be done (optional)'),
    inputNodes.latestDate,
    h('small', { className: 'field-hint' }, 'Left blank, a flexible request can slip by one day.'),
    makeFieldError('latestDate')
  );
  updateDynamicHelpers();

  const moreOptions = h('details', {
    id: 'more-options', className: 'more-options', open: session.moreOptionsOpen,
    onToggle: ev => { session.moreOptionsOpen = ev.currentTarget.open; }
  },
    h('summary', {}, 'More options'),
    h('div', { className: 'more-options-body' },
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' }, h('label', { for: 'proposal-min' }, 'Quickest it could take (hours)'), inputNodes.min, makeFieldError('min')),
        h('div', { className: 'form-field' }, h('label', { for: 'proposal-max' }, 'Longest it could take (hours)'), inputNodes.max, makeFieldError('max'))
      ),
      rangePreview,
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' }, h('label', { for: 'proposal-tag' }, 'How firm is it?'), inputNodes.tag, makeFieldError('tag')),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-type' }, 'What kind of task is it?'), inputNodes.type,
          h('small', { className: 'field-hint' }, 'Helps the app learn how long your tasks really take.'), makeFieldError('type'))
      ),
      latestGroup,
      h('div', { className: 'form-field' },
        h('label', { for: 'proposal-earliest' }, "Can't start before (optional)"),
        inputNodes.earliestDate,
        h('small', { className: 'field-hint' }, `Left blank, work can start from the first loaded day (${dayLabel(firstDate)}).`),
        makeFieldError('earliestDate'))
    )
  );

  return h('form', {
    id: 'proposal-form', className: 'card request-card', novalidate: true,
    'aria-label': isEdit ? 'Edit what you are checking' : 'New thing to check',
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
        type: inputNodes.type.value,
        audience: document.querySelector('#proposal-form input[name="audience"]:checked')?.value ?? draft.audience ?? 'others'
      };
      try {
        if (!fields.deadline) throw Error("Pick when it's due.");
        if (isEdit) {
          const ui = getUi(pending.id);
          ui.smaller = null;
          ui.learnedUsed = false;
          session.pendingFocus = true;
          // Leave edit mode first: dispatch re-renders synchronously.
          session.editing = false;
          const kept = session.formDraft;
          session.formDraft = null;
          try {
            dispatch({ type: 'UPDATE_PROPOSAL', proposalId: pending.id, fields }, { rethrow: true });
          } catch (failure) {
            session.editing = true;
            session.formDraft = kept;
            throw failure;
          }
        } else {
          resetRequestUi();
          session.pendingFocus = true;
          dispatch({ type: 'ADD_PROPOSAL', fields }, { rethrow: true });
          session.formDraft = null;
          onSubmitted?.();
        }
      } catch (error) {
        session.pendingFocus = false;
        showValidationError(error?.message || 'Check the details you entered.', fields);
      }
    }
  },
    h('h2', { className: 'card-title' }, title),
    h('div', { className: 'field' },
      h('label', { for: 'proposal-title', className: 'field-label' }, 'What is it?'),
      inputNodes.title,
      makeFieldError('title')
    ),
    h('div', { className: 'field' },
      h('span', { className: 'field-label', id: 'hours-label' }, 'How long might it take?'),
      h('div', { className: 'stepper', role: 'group', 'aria-labelledby': 'hours-label' },
        h('button', {
          type: 'button', id: 'hours-less', className: 'step-btn', 'aria-label': 'Fewer hours',
          onClick: () => { draft.likely = String(nextHours(draft.likely, -1)); inputNodes.likely.value = draft.likely; clearErrors(); refreshHours(); updateDynamicHelpers(); }
        }, '−'),
        hoursOut,
        h('button', {
          type: 'button', id: 'hours-more', className: 'step-btn', 'aria-label': 'More hours',
          onClick: () => { draft.likely = String(nextHours(draft.likely, 1)); inputNodes.likely.value = draft.likely; clearErrors(); refreshHours(); updateDynamicHelpers(); }
        }, '+')
      ),
      inputNodes.likely,
      makeFieldError('likely'),
      suggestionBox
    ),
    h('div', { className: 'field' },
      h('span', { className: 'field-label' }, 'When is it due?'),
      dueRow,
      h('details', { className: 'pick-date', id: 'pick-date' },
        h('summary', {}, 'Pick a date'),
        inputNodes.deadline
      ),
      makeFieldError('deadline')
    ),
    h('fieldset', { className: 'field audience-choice', id: 'audience-choice' },
      h('legend', { className: 'field-label' }, "Who's waiting on an answer?"),
      h('div', { className: 'chip-row even' },
        [['others', 'Someone else'], ['self', 'Just me']].map(([value, label]) =>
          h('label', { className: 'chip-input', for: `audience-${value}` },
            h('input', {
              id: `audience-${value}`, type: 'radio', name: 'audience', value,
              checked: draft.audience === value,
              onChange: ev => { if (ev.currentTarget.checked) draft.audience = value; }
            }),
            h('span', { className: 'chip' }, label)))
      )
    ),
    moreOptions,
    formErrorBanner,
    h('button', { type: 'submit', className: 'button button-primary button-large' },
      isEdit ? 'Run the numbers again' : 'Run the numbers'),
    isEdit
      ? h('button', {
          type: 'button', className: 'link-button center',
          onClick: () => { session.editing = false; session.formDraft = null; rerender?.(); }
        }, 'Cancel')
      : null
  );
}

export { getFormDraft, emptyDraft };
