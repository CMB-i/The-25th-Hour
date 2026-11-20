import { defaultRange, roundHalfHour } from '../engine/commitments.mjs';
import { deadlineCost, verdictText } from '../engine/evaluate.mjs';
import { getEstimateSuggestion } from '../engine/feedback.mjs';
import { draftApprovalRequest } from '../engine/repairs.mjs';
import { isHalfHour, TASK_TYPES } from '../engine/scheduler.mjs';
import {
  buildVerdictCopy,
  fmtHours,
  fmtShortDate,
  fmtShortWeekday,
  fmtSignedHours,
  h,
  taskTag,
  taskTagLabel,
  verdictClass,
  verdictIcon,
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

// Preserves in-progress draft inputs across re-renders until form submission succeeds or resets.
let formDraft = null;

function defaultDeadlineDate(days, weekIndex = 0) {
  if (!days.length) return '';
  const thursdayIndex = Math.min(days.length - 1, weekIndex * 7 + 3);
  return days[thursdayIndex]?.date ?? days[0].date;
}

function getFormDraft(state) {
  const firstDate = state.days[0]?.date ?? '';
  const lastDate = state.days[state.days.length - 1]?.date ?? '';
  const proposalCount = state.proposals.length;
  if (!formDraft || formDraft.anchor !== firstDate || formDraft.proposalCount !== proposalCount) {
    formDraft = {
      anchor: firstDate,
      proposalCount,
      title: '',
      likely: '',
      min: '',
      max: '',
      deadline: defaultDeadlineDate(state.days, state.weekIndex),
      tag: 'must-keep',
      latestDate: '',
      earliestDate: '',
      type: 'other'
    };
  }
  if (formDraft.deadline < firstDate || formDraft.deadline > lastDate) {
    formDraft.deadline = defaultDeadlineDate(state.days, state.weekIndex);
  }
  return formDraft;
}

export function resetCheckFormDraft(state) {
  formDraft = null;
  if (state) getFormDraft(state);
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

function renderOutcomeCard({ title, badgeText, beforeOutcome, afterOutcome, proposals, state, dispatch }) {
  const summary = buildCommitmentSummary(beforeOutcome, afterOutcome, proposals, state.days);
  const beforeCls = verdictClass(summary.beforeVerdict);
  const afterCls = verdictClass(summary.afterVerdict);
  const proposalIds = proposals.map(task => task.id);
  const canPlainAccept = afterOutcome.evaluation.typical.feasible;
  const selfServe = summary.selfServeRepair;
  const top = summary.topRepair;
  const isMulti = proposals.length > 1;

  const proposalMetaList = proposals.map(task => {
    const tag = taskTag(task);
    const targetDate = state.days[task.targetDay]?.date ?? '';
    const hardDate = state.days[task.hardDay]?.date ?? '';
    const earliestDate = state.days[task.earliestDay]?.date ?? '';
    const typeLabel = (TASK_TYPE_LABELS[task.type] ?? TASK_TYPE_LABELS.other).label;
    const deadlineDetail = task.hardDay > task.targetDay
      ? `${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)} (${targetDate}) target · flexible up to ${fmtShortWeekday(hardDate)} ${fmtShortDate(hardDate)} (${hardDate})`
      : `${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)} (${targetDate})`;
    return h('li', { className: 'proposal-meta-item' },
      h('div', {},
        h('strong', {}, task.title),
        ' · ',
        h('span', {}, `${fmtHours(task.likely)} typical (${fmtHours(task.min)}–${fmtHours(task.max)} range)`),
        ' · ',
        h('span', {}, `Due ${deadlineDetail}`),
        earliestDate && task.earliestDay > 0 ? h('span', {}, ` · Starts ${earliestDate}`) : null,
        h('span', {}, ` · Type: ${typeLabel}`)
      ),
      h('span', { className: `task-pill ${tag}` }, taskTagLabel(tag))
    );
  });

  const repairSection = afterOutcome.evaluation.verdict === 'feasible'
    ? h('div', { className: 'check-repair-box good' },
        h('strong', {}, '✓ No schedule repair required: '),
        'Every deadline is met even if tasks run long, with at least 1h of conservative buffer.'
      )
    : top
      ? h('div', { className: `check-repair-box ${top.needsApproval ? 'risk' : 'good'}` },
          h('div', { className: 'check-repair-head' },
            h('strong', {}, 'Top verified repair recommendation'),
            h('span', { className: `repair-status ${top.needsApproval ? 'pending' : 'self-serve'}` },
              top.needsApproval ? 'Needs approval (pending)' : 'Self-serve'
            )
          ),
          h('p', { className: 'check-repair-title' },
            `${top.actions.map(action => action.label).join(' + ')} → ${verdictIcon(top.test.verdict)} ${verdictLabel(top.test.verdict)}`
          ),
          h('p', { className: 'helper' }, top.actions.map(action => action.description).join(' ')),
          top.needsApproval
            ? h('div', { className: 'approval-guard-note' },
                h('p', { className: 'tiny-note' },
                  'Guardrail: This top repair requires external approval and will never be auto-applied. You can preview its request draft below or manage approvals in Make It Work after deciding.'
                ),
                h('pre', { className: 'draft-box' }, draftApprovalRequest(top, state.days))
              )
            : null,
          selfServe && selfServe.id !== top.id
            ? h('p', { className: 'tiny-note' },
                `Self-serve alternative available for one-click acceptance: ${selfServe.actions.map(action => action.label).join(' + ')} (Result: ${verdictLabel(selfServe.test.verdict)}).`
              )
            : null
        )
      : h('div', { className: 'check-repair-box alert' },
          h('strong', {}, '✕ No verified repair available: '),
          "No verified fix with the changes you've allowed. This is a capacity problem, not a scheduling problem."
        );

  const selfServeButtonLabel = selfServe
    ? `Accept${isMulti ? ' all' : ''} with suggested change (${selfServe.actions.map(action => action.label).join(' + ')})`
    : `Accept${isMulti ? ' all' : ''} with suggested change (none available)`;

  return h('article', { className: 'panel proposal-outcome-card' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, badgeText),
        h('h3', {}, title)
      ),
      h('span', { className: `verdict-badge ${afterCls}` },
        `With commitment: ${verdictIcon(summary.afterVerdict)} ${verdictLabel(summary.afterVerdict).toUpperCase()}`
      )
    ),

    h('ul', { className: 'proposal-meta-list' }, proposalMetaList),

    // 1 & 2. Side-by-side Without vs With Feasibility Verdicts
    h('div', { className: 'before-after-grid' },
      h('div', { className: `before-after-box ${beforeCls}` },
        h('div', { className: 'verdict-top' },
          h('span', {}, '1 · WITHOUT THIS COMMITMENT'),
          h('span', { className: `verdict-badge ${beforeCls}` },
            `${verdictIcon(summary.beforeVerdict)} ${verdictLabel(summary.beforeVerdict).toUpperCase()}`
          )
        ),
        h('strong', { className: 'ba-headline' }, buildVerdictCopy(beforeOutcome.evaluation, state.days).headline),
        h('p', {}, summary.withoutLine)
      ),
      h('div', { className: `before-after-box ${afterCls}` },
        h('div', { className: 'verdict-top' },
          h('span', {}, '2 · WITH THIS COMMITMENT'),
          h('span', { className: `verdict-badge ${afterCls}` },
            `${verdictIcon(summary.afterVerdict)} ${verdictLabel(summary.afterVerdict).toUpperCase()}`
          )
        ),
        h('strong', { className: 'ba-headline' }, buildVerdictCopy(afterOutcome.evaluation, state.days).headline),
        h('p', {}, summary.withLine)
      )
    ),

    // 3, 4, 5, 6. Key Numbers Breakdown Grid
    h('div', { className: 'impact-metrics-grid' },
      h('div', { className: 'preview-fact' },
        h('span', {}, '3 · Additional workload'),
        h('strong', {}, `+${fmtHours(summary.addedLikely)} typical`),
        h('small', {}, `Range: ${fmtHours(summary.addedMin)}–${fmtHours(summary.addedMax)}`)
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, '4 · Binding deadline'),
        h('strong', {}, summary.bindingWeekday ? `${summary.bindingWeekday} (${fmtShortDate(summary.bindingDate)})` : 'None'),
        h('small', {}, summary.bindingDate || 'No deadlines')
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, '5 · Required vs. available'),
        h('strong', {}, `${fmtHours(summary.requiredHours)} due / ${fmtHours(summary.availableHours)} free`),
        h('small', {}, summary.bindingWeekday ? `Cumulative through ${summary.bindingWeekday}` : 'Cumulative')
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, '6 · Shortfall / margin'),
        h('strong', { className: summary.shortfallHours > 0 ? 'not-ok' : 'ok' },
          summary.shortfallHours > 0
            ? `−${fmtHours(summary.shortfallHours)} short`
            : `${fmtSignedHours(summary.marginHours)} spare`
        ),
        h('small', {}, `Conservative: ${fmtSignedHours(summary.conservativeMarginHours)}`)
      )
    ),

    // Plain-language Cost Statement (SPEC section 7.1)
    h('div', { className: 'cost-statement-box' },
      h('span', { className: 'field-eyebrow' }, 'PLAIN-LANGUAGE COST STATEMENT'),
      h('p', {}, h('strong', {}, 'Without this: '), summary.withoutLine),
      h('p', {}, h('strong', {}, 'With this: '), summary.withLine),
      summary.tasksDueLine ? h('p', {}, summary.tasksDueLine) : null,
      h('p', {}, summary.topRepairLine)
    ),

    // 7. Top Verified Repair Recommendation
    repairSection,

    // Four Decision Actions
    h('div', { className: 'decision-actions' },
      h('button', {
        type: 'button',
        className: 'button button-primary',
        disabled: !canPlainAccept,
        title: canPlainAccept
          ? 'Add this commitment directly to your schedule'
          : 'Typical estimates miss a deadline; use "Accept with suggested change" or "Accept anyway"',
        onClick: () => dispatch({
          type: 'ACCEPT_PROPOSAL',
          proposalIds,
          mode: 'accept'
        })
      }, isMulti ? 'Accept all' : 'Accept'),

      h('button', {
        type: 'button',
        className: 'button button-secondary',
        disabled: !selfServe,
        onClick: () => dispatch({
          type: 'ACCEPT_PROPOSAL',
          proposalIds,
          mode: 'accept-repair',
          repairId: selfServe?.id
        })
      }, selfServeButtonLabel),

      h('button', {
        type: 'button',
        className: 'button button-outline',
        onClick: () => dispatch({
          type: 'ACCEPT_PROPOSAL',
          proposalIds,
          mode: 'override'
        })
      }, isMulti ? 'Accept all anyway' : 'Accept anyway'),

      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({
          type: 'DISCARD_PROPOSAL',
          proposalIds
        })
      }, isMulti ? 'Not now (discard all)' : 'Not now')
    ),
    !canPlainAccept
      ? h('p', { className: 'tiny-note' },
          'Note: "Accept" is disabled when typical estimates miss a deadline. You may apply the verified self-serve change above, or choose "Accept anyway" (which leaves the unresolved conflict visible on My Week without touching protected sleep).'
        )
      : null
  );
}

/**
 * Renders Screen 2: Should I Say Yes? (F1 Commitment Check).
 */
export function renderCheckScreen(container, { state, derived, dispatch }) {
  const draft = getFormDraft(state);
  const firstDate = state.days[0]?.date ?? '';
  const lastDate = state.days[state.days.length - 1]?.date ?? '';
  const copy = buildVerdictCopy(derived.evaluation, state.days);
  const verdictCls = verdictClass(derived.evaluation.verdict);

  const headerBar = h('section', { className: 'panel check-header' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('div', { className: 'panel-label' },
          h('span', { className: 'panel-index' }, '02'),
          'COMMITMENT CHECK · SHOULD I SAY YES?'
        ),
        h('h2', {}, 'Know what your next yes will cost.'),
        h('p', { className: 'helper' },
          'Enter a potential commitment in under ten seconds. Nothing joins your schedule until you choose an acceptance option.'
        )
      ),
      h('span', { className: `verdict-badge ${verdictCls}` },
        `Current plan: ${verdictIcon(derived.evaluation.verdict)} ${verdictLabel(derived.evaluation.verdict).toUpperCase()}`
      )
    ),
    h('div', { className: 'rescue-summary-line' },
      h('strong', {}, 'Current baseline plan: '),
      `${copy.headline} ${copy.body}`
    ),
    h('div', { className: 'quick-actions' },
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, '← Back to My Week'),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
      }, 'Open Make It Work'),
      state.demo
        ? h('button', {
            type: 'button',
            className: 'button button-outline',
            onClick: () => dispatch({
              type: 'UPDATE_DEMO_RESEARCH',
              includeResearch: !state.includeResearch,
              researchHours: state.researchHours
            })
          }, state.includeResearch
            ? 'Exclude built-in 5h demo research (start from 13h feasible week)'
            : 'Re-include built-in 5h demo research')
        : null
    )
  );

  const unresolvedBanner = state.unresolvedConflict && !derived.evaluation.typical.feasible
    ? h('div', { className: 'banner banner-alert', role: 'status' },
        h('div', { className: 'banner-body' },
          h('strong', {}, 'Unresolved deadline conflict on your plan: '),
          'You previously accepted an infeasible commitment with "Accept anyway". The conflict remains visible until resolved.'
        ),
        h('button', {
          type: 'button',
          className: 'button button-outline button-sm',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
        }, 'Resolve in Make It Work')
      )
    : null;

  const suggestionBox = h('div', { id: 'estimate-suggestion', className: 'suggestion-slot' });
  const rangePreview = h('small', { id: 'range-preview', className: 'field-hint' });
  const latestGroup = h('div', {
    id: 'latest-date-group',
    className: 'form-field',
    hidden: draft.tag !== 'flexible'
  });
  const formErrorBanner = h('p', {
    id: 'proposal-error',
    className: 'form-error-banner',
    role: 'alert',
    hidden: true
  });

  const fieldErrorNodes = {};
  const inputNodes = {};

  function makeFieldError(name) {
    const node = h('small', {
      id: `error-${name}`,
      className: 'field-error',
      role: 'alert',
      hidden: true
    });
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
    }
    formErrorBanner.textContent = message;
    formErrorBanner.hidden = false;
  }

  function updateDynamicHelpers() {
    const likelyNum = Number(draft.likely);
    if (isHalfHour(likelyNum) && likelyNum >= 0.5 && likelyNum <= 40) {
      const range = defaultRange(likelyNum);
      rangePreview.textContent = `Leave min/max blank to use D3 default range: ${fmtHours(range.min)} – ${fmtHours(range.max)} (0.8× to 1.4× typical, rounded to 0.5h).`;
    } else {
      rangePreview.textContent = 'Optional. Leave blank to auto-fill 0.8× (min, at least 0.5h) and 1.4× (max) rounded to 0.5h.';
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
      suggestionBox.replaceChildren(
        h('p', { className: 'field-hint learning-note' }, info.text)
      );
    } else {
      suggestionBox.replaceChildren();
    }
  }

  inputNodes.title = h('input', {
    id: 'proposal-title',
    name: 'title',
    type: 'text',
    maxlength: '80',
    required: true,
    value: draft.title,
    placeholder: 'e.g. Robotics Club Perception Module',
    onInput: ev => {
      draft.title = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.likely = h('input', {
    id: 'proposal-likely',
    name: 'likely',
    type: 'number',
    min: '0.5',
    max: '40',
    step: '0.5',
    required: true,
    value: draft.likely,
    placeholder: 'e.g. 5',
    onInput: ev => {
      draft.likely = ev.currentTarget.value;
      clearErrors();
      updateDynamicHelpers();
    }
  });

  inputNodes.min = h('input', {
    id: 'proposal-min',
    name: 'min',
    type: 'number',
    min: '0',
    max: '40',
    step: '0.5',
    value: draft.min,
    placeholder: 'Auto (0.8×)',
    onInput: ev => {
      draft.min = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.max = h('input', {
    id: 'proposal-max',
    name: 'max',
    type: 'number',
    min: '0',
    max: '60',
    step: '0.5',
    value: draft.max,
    placeholder: 'Auto (1.4×)',
    onInput: ev => {
      draft.max = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.deadline = h('input', {
    id: 'proposal-deadline',
    name: 'deadline',
    type: 'date',
    min: firstDate,
    max: lastDate,
    required: true,
    value: draft.deadline,
    onInput: ev => {
      draft.deadline = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.tag = h('select', {
    id: 'proposal-tag',
    name: 'tag',
    onChange: ev => {
      draft.tag = ev.currentTarget.value;
      clearErrors();
      updateDynamicHelpers();
    }
  },
    h('option', { value: 'must-keep', selected: draft.tag === 'must-keep' }, 'Must-keep (fixed target)'),
    h('option', { value: 'flexible', selected: draft.tag === 'flexible' }, 'Flexible (target can move)'),
    h('option', { value: 'droppable', selected: draft.tag === 'droppable' }, 'Droppable (optional)')
  );

  inputNodes.latestDate = h('input', {
    id: 'proposal-latest',
    name: 'latestDate',
    type: 'date',
    min: firstDate,
    max: lastDate,
    value: draft.latestDate,
    onInput: ev => {
      draft.latestDate = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.earliestDate = h('input', {
    id: 'proposal-earliest',
    name: 'earliestDate',
    type: 'date',
    min: firstDate,
    max: lastDate,
    value: draft.earliestDate,
    onInput: ev => {
      draft.earliestDate = ev.currentTarget.value;
      clearErrors();
    }
  });

  inputNodes.type = h('select', {
    id: 'proposal-type',
    name: 'type',
    onChange: ev => {
      draft.type = ev.currentTarget.value;
      clearErrors();
      updateDynamicHelpers();
    }
  },
    TASK_TYPES.map(typeKey =>
      h('option', { value: typeKey, selected: draft.type === typeKey },
        (TASK_TYPE_LABELS[typeKey] ?? TASK_TYPE_LABELS.other).label
      )
    )
  );

  latestGroup.replaceChildren(
    h('label', { for: 'proposal-latest' }, 'Latest acceptable date (hard deadline, optional)'),
    inputNodes.latestDate,
    h('small', { className: 'field-hint' },
      'If left blank for a flexible commitment, defaults to deadline + 1 day (capped at the last loaded day).'
    ),
    makeFieldError('latestDate')
  );

  updateDynamicHelpers();

  const formPanel = h('section', { className: 'panel check-form-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'NEW COMMITMENT PROPOSAL'),
        h('h3', {}, 'Should I say yes to this?')
      ),
      h('span', { className: 'pill' }, `Loaded dates: ${firstDate} to ${lastDate}`)
    ),
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
          latestDate: inputNodes.tag.value === 'flexible' ? inputNodes.latestDate.value : inputNodes.latestDate.value,
          earliestDate: inputNodes.earliestDate.value,
          type: inputNodes.type.value
        };
        try {
          dispatch({ type: 'ADD_PROPOSAL', fields }, { rethrow: true });
        } catch (error) {
          showValidationError(error?.message || 'Check the entered commitment details.', fields);
        }
      }
    },
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-title' }, 'Commitment name *'),
          inputNodes.title,
          h('small', { className: 'field-hint' }, 'Required, 1 to 80 characters.'),
          makeFieldError('title')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-likely' }, 'Typical hours needed *'),
          inputNodes.likely,
          h('small', { className: 'field-hint' }, 'Required, 0.5 to 40h in half-hour steps (0.5, 1, 1.5, …).'),
          makeFieldError('likely'),
          suggestionBox
        )
      ),

      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-min' }, 'Optimistic (minimum) hours (optional)'),
          inputNodes.min,
          makeFieldError('min')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-max' }, 'Conservative (maximum) hours (optional)'),
          inputNodes.max,
          makeFieldError('max')
        )
      ),
      rangePreview,

      h('div', { className: 'form-grid-three' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-deadline' }, 'Target deadline date *'),
          inputNodes.deadline,
          h('small', { className: 'field-hint' }, `Must be within ${firstDate} – ${lastDate}.`),
          makeFieldError('deadline')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-tag' }, 'Priority tag *'),
          inputNodes.tag,
          makeFieldError('tag')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-type' }, 'Task type (for estimate learning)'),
          inputNodes.type,
          makeFieldError('type')
        )
      ),

      latestGroup,

      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'proposal-earliest' }, 'Earliest start date (optional)'),
          inputNodes.earliestDate,
          h('small', { className: 'field-hint' }, `Defaults to first loaded day (${firstDate}).`),
          makeFieldError('earliestDate')
        )
      ),

      formErrorBanner,

      h('div', { className: 'form-submit-row' },
        h('button', { type: 'submit', className: 'button button-primary' }, 'Check commitment'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          onClick: () => {
            resetCheckFormDraft(state);
            renderCheckScreen(container, { state, derived, dispatch });
          }
        }, 'Reset form')
      )
    )
  );

  const resultsSection = h('section', {
    id: 'proposals-results',
    className: 'proposals-results',
    'aria-live': 'polite'
  });

  if (!state.proposals.length || !derived.commitmentCheck) {
    resultsSection.append(
      h('div', { className: 'panel empty-proposals' },
        h('span', { className: 'panel-label' }, 'NO PENDING DRAFTS'),
        h('h3', {}, 'No draft commitments pending decision'),
        h('p', { className: 'helper' },
          'Submit the form above to evaluate a potential commitment side by side against your current week before accepting it.'
        )
      )
    );
  } else {
    const checked = derived.commitmentCheck;

    if (state.proposals.length > 1 && checked.together) {
      resultsSection.append(
        renderOutcomeCard({
          title: `Combined impact: all ${state.proposals.length} pending proposals together`,
          badgeText: `EVALUATED TOGETHER · ${state.proposals.length} PROPOSALS`,
          beforeOutcome: checked.before,
          afterOutcome: checked.together,
          proposals: state.proposals,
          state,
          dispatch
        })
      );
    }

    checked.separate.forEach((outcome, index) => {
      const proposal = state.proposals[index];
      if (!proposal) return;
      const badgeText = state.proposals.length > 1
        ? `EVALUATED SEPARATELY · PROPOSAL ${index + 1} OF ${state.proposals.length}`
        : 'BEFORE & AFTER COMPARISON · DRAFT PROPOSAL';
      resultsSection.append(
        renderOutcomeCard({
          title: `Proposal: ${proposal.title}`,
          badgeText,
          beforeOutcome: checked.before,
          afterOutcome: outcome,
          proposals: [proposal],
          state,
          dispatch
        })
      );
    });
  }

  container.replaceChildren(
    headerBar,
    ...(unresolvedBanner ? [unresolvedBanner] : []),
    formPanel,
    resultsSection
  );
}
