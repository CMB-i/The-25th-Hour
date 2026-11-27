import { deadlineCost } from '../engine/evaluate.mjs';
import { draftApprovalRequest, emptyRepairMessage } from '../engine/repairs.mjs';
import { weekView } from '../engine/weeks.mjs';
import { conflictClause, dayLabel, hoursPhrase, isRepairForRequest } from './check-model.mjs';
import { fmtTimestamp, h, setBlobTone, svg, verdictLabel } from './dom.mjs';
import { makeCopyControls } from './reply-slip.mjs';
import { renderTimeline } from './render-timeline.mjs';
import { findSelfServeAcceptRepair, getApprovalRecord } from './state.mjs';

// Edited approval drafts, keyed by repair id. UI-only; never sent, never persisted.
const draftEdits = new Map();

function repairLabel(repair) {
  return repair.actions.map(action => action.label).join(' + ');
}

function effectText(repair, state) {
  const typical = deadlineCost(repair.test.typical, state.days);
  const lead = repair.needsApproval ? 'If approved' : 'After this change';
  if (!repair.test.typical.feasible) return `${lead}, it still doesn't fit.`;
  const word = repair.test.verdict === 'feasible' ? 'it fits' : 'it fits, but tightly';
  return typical
    ? `${lead}, ${word}. Your tightest day, ${dayLabel(typical.date)}, would have ${hoursPhrase(Math.max(0, typical.marginHours))} to spare.`
    : `${lead}, ${word}.`;
}

function previewWeekIndex(repair, derived) {
  const firstAction = repair.actions[0];
  const targetDay = firstAction?.toDay
    ?? repair.updated.find(task => task.id === firstAction?.taskId)?.targetDay;
  if (Number.isInteger(targetDay)) {
    return Math.min(derived.maxWeekIndex, Math.max(0, Math.floor(targetDay / 7)));
  }
  return derived.weekIndex;
}

function renderHistory(state, dispatch) {
  const changes = state.appliedChanges;
  if (!changes.length) return null;
  return h('details', { className: 'quiet-details history-panel', id: 'reset-history' },
    h('summary', {}, `Changes already made (${changes.length})`),
    h('ul', { className: 'plain-list' },
      [...changes].reverse().map(change =>
        h('li', {},
          h('strong', {}, (change.labels ?? []).join(' + ') || 'Applied adjustment'),
          change.recordedAt ? ` · applied ${fmtTimestamp(change.recordedAt)}` : '',
          change.approved ? ' · approved first' : ' · self-serve'))
    ),
    h('button', {
      type: 'button', id: 'undo-last', className: 'link-button',
      onClick: () => dispatch({ type: 'UNDO_LAST_REPAIR' })
    }, 'Undo last change')
  );
}

function renderApproval(selected, state, derived, dispatch) {
  const record = getApprovalRecord(state, selected.id, derived.fingerprint);
  const status = record?.status ?? 'pending';
  const auto = draftApprovalRequest(selected, state.days, { includeWorkload: state.draftIncludeWorkload });
  const textarea = h('textarea', {
    id: 'reply-text', className: 'reply-text', rows: '7', spellcheck: 'true',
    'aria-label': 'Request to send. You can edit it.'
  });
  textarea.value = draftEdits.get(selected.id) ?? auto;
  textarea.addEventListener('input', () => {
    if (textarea.value === auto) draftEdits.delete(selected.id);
    else draftEdits.set(selected.id, textarea.value);
  });
  const copy = makeCopyControls(() => textarea.value, 'Copy reply');
  return h('section', { className: 'reply-slip', id: 'reply-slip' },
    h('div', { className: 'slip-head' },
      h('h3', {}, "Here's what you could send"),
      h('span', { className: 'slip-kind' }, 'A request for someone to approve a change')
    ),
    textarea,
    h('label', { className: 'check-line' },
      h('input', {
        type: 'checkbox', checked: state.draftIncludeWorkload,
        onChange: ev => { draftEdits.delete(selected.id); dispatch({ type: 'SET_DRAFT_WORKLOAD', include: ev.currentTarget.checked }); }
      }),
      h('span', {}, 'Include a line about my workload')),
    h('p', { className: 'slip-note' },
      'Copying adds nothing to your week and sends nothing. Your plan only changes after you mark it approved and apply it yourself.'),
    h('div', { className: 'slip-actions' }, copy.button, copy.status),
    h('div', { className: 'approval-steps' },
      h('p', { id: 'approval-status', className: 'status-line' },
        status === 'approved'
          ? 'Approval recorded. Apply it when you are ready.'
          : status === 'declined'
            ? 'Marked declined. Your plan is unchanged.'
            : 'Waiting for their answer. Your plan is unchanged.'),
      h('div', { className: 'section-actions' },
        h('button', {
          type: 'button', className: `button ${status === 'approved' ? 'button-primary' : 'button-secondary'}`,
          'aria-pressed': String(status === 'approved'),
          onClick: () => dispatch({ type: 'SET_APPROVAL_STATUS', repairId: selected.id, status: 'approved' })
        }, 'Mark approved'),
        h('button', {
          type: 'button', className: 'link-button',
          'aria-pressed': String(status === 'declined'),
          onClick: () => dispatch({ type: 'SET_APPROVAL_STATUS', repairId: selected.id, status: 'declined' })
        }, 'Mark declined'),
        h('button', {
          type: 'button', id: 'apply-approved', className: 'button button-primary',
          disabled: status !== 'approved',
          onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: selected.id })
        }, 'Apply approved change')
      )
    )
  );
}

function backHome(dispatch) {
  return h('button', {
    type: 'button', id: 'reset-back', className: 'back-link',
    onClick: () => dispatch({ type: 'NAVIGATE', screen: 'home' })
  },
    svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
      svg('path', { d: 'M11 3L5 9l6 6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
    'Home');
}

/** A numbered step card, as in the Reset mock. */
function stepCard({ number, title, tag, body, actions, selected = false, className = '' }) {
  return h('div', { className: `step-card${selected ? ' is-first' : ''} ${className}`.trim() },
    h('span', { className: 'step-num', 'aria-hidden': 'true' }, String(number)),
    h('div', { className: 'step-body' },
      h('h2', { className: 'step-title' }, title),
      tag,
      h('p', { className: 'step-text' }, body),
      actions));
}

/**
 * Reset for a request that is still being decided: the verified ways to make room for *it*, from the
 * same engine run the check used. Adding it with a self-serve change is the existing explicit action.
 */
function renderRequestReset({ state, derived, dispatch, proposal, after }) {
  const repairs = after.repairs.filter(repair => isRepairForRequest(repair, proposal.id)).slice(0, 5);
  const selfServe = findSelfServeAcceptRepair(after.repairs, [proposal.id]);
  const clause = after.evaluation.typical.feasible ? null : conflictClause(after.evaluation.typical, state.days);
  const lead = h('section', { id: 'reset-lead', className: 'reset-lead' },
    h('div', { className: 'eyebrow' }, "LET'S RESET"),
    h('h1', { className: 'reset-title' }, `Making room for ${proposal.title}.`),
    h('p', { id: 'reset-status', className: 'status-pill status-pill-short' }, verdictLabel(after.evaluation.verdict)),
    h('p', { className: 'reset-lead-text' }, clause ? `With it, you'd be ${clause.text}.` : 'It fits, but with little room.'),
    repairs.length
      ? h('h2', { className: 'section-title reset-list-title' }, "Here's where we can start.")
      : h('p', { className: 'reset-lead-text' }, emptyRepairMessage('infeasible'))
  );
  repairs.forEach((repair, index) => {
    lead.append(stepCardFor({
      number: index + 1,
      first: index === 0,
      repair,
      state,
      actions: !repair.needsApproval && repair.id === selfServe?.id
        ? h('div', { className: 'section-actions' },
            h('button', {
              type: 'button', id: index === 0 ? 'apply-lead' : undefined, className: 'button button-primary',
              onClick: () => dispatch({ type: 'ACCEPT_PROPOSAL', proposalIds: [proposal.id], mode: 'accept-repair', repairId: repair.id })
            }, 'Add it to my week, with this change'))
        : repair.needsApproval
          ? h('button', {
              type: 'button', className: 'link-button',
              onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
            }, 'Back to your reply')
          : null
    }));
  });
  return [lead, h('div', { className: 'reset-foot' },
    h('button', { type: 'button', id: 'reset-back-check', className: 'link-button', onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' }) }, 'Back to your request'))];
}

function stepCardFor({ number, first, repair, state, actions }) {
  return stepCard({
    number,
    selected: first,
    title: `${repairLabel(repair)}.`,
    tag: h('span', { className: `option-tag ${repair.needsApproval ? 'needs-approval' : 'self-serve'}` },
      repair.needsApproval ? 'If approved' : 'You can do this yourself'),
    body: `${effectText(repair, state)} Checked against every deadline with sleep protected.`,
    actions
  });
}

/**
 * Renders Reset: the first conflict, one verified change and what to do next.
 */
export function renderRescueScreen(container, { state, derived, dispatch }) {
  const { evaluation, repairs } = derived;
  const parts = [backHome(dispatch)];
  const pending = state.proposals[0];
  const pendingAfter = pending && derived.commitmentCheck ? derived.commitmentCheck.separate[0] : null;
  if (pendingAfter && pendingAfter.evaluation.verdict !== 'feasible') {
    setBlobTone('coral');
    parts.push(...renderRequestReset({ state, derived, dispatch, proposal: pending, after: pendingAfter }));
    container.replaceChildren(...parts);
    return;
  }
  const history = renderHistory(state, dispatch);
  const tagFor = repair => h('span', { className: `option-tag ${repair.needsApproval ? 'needs-approval' : 'self-serve'}` },
    repair.needsApproval ? 'If approved' : 'You can do this yourself');

  if (evaluation.verdict === 'feasible') {
    setBlobTone('sage');
    parts.push(
      h('section', { id: 'reset-lead', className: 'reset-lead' },
        h('div', { className: 'eyebrow' }, "LET'S RESET"),
        h('h1', { className: 'reset-title' }, "That's better."),
        h('p', { id: 'reset-status', className: 'status-pill status-pill-fits' }, 'Fits'),
        h('p', { className: 'reset-lead-text' },
          `Nothing needs to move. ${emptyRepairMessage('feasible')}. Every deadline is met with at least an hour to spare, even if things run long, and your sleep is protected.`),
        h('button', {
          type: 'button', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
        }, 'Back to My week')
      )
    );
    if (history) parts.push(history);
    container.replaceChildren(...parts);
    return;
  }

  const clause = evaluation.typical.feasible ? null : conflictClause(evaluation.typical, state.days);
  const cost = deadlineCost(evaluation.typical, state.days);
  const first = clause
    ? `The first deadline at risk is ${dayLabel(clause.date)}. You're ${clause.text}.`
    : `The first deadline to watch is ${dayLabel(cost.date)}, with ${hoursPhrase(Math.max(0, cost.marginHours))} to spare.`;
  const tone = clause ? 'short' : 'tight';
  setBlobTone('coral');

  const visible = repairs.slice(0, 5);
  const selected = visible.find(item => item.id === state.selectedRepairId) ?? visible[0] ?? null;

  const lead = h('section', { id: 'reset-lead', className: 'reset-lead' },
    h('div', { className: 'eyebrow' }, "LET'S RESET"),
    h('h1', { className: 'reset-title' }, clause ? "It's a lot right now." : "It's tight right now."),
    h('p', { id: 'reset-status', className: `status-pill status-pill-${tone}` }, verdictLabel(evaluation.verdict)),
    h('p', { className: 'reset-lead-text' }, first)
  );

  if (!selected) {
    lead.append(
      h('p', { className: 'reset-lead-text' }, emptyRepairMessage(evaluation.verdict)),
      h('p', { className: 'option-note' },
        'Check what the app is counting: a missing busy block or wrong work hours can change this.'),
      h('div', { className: 'section-actions' },
        h('button', {
          type: 'button', id: 'reset-to-week', className: 'button button-primary',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
        }, 'Check what is counted'),
        h('button', {
          type: 'button', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
        }, 'Change work hours')
      )
    );
    parts.push(lead);
    if (history) parts.push(history);
    container.replaceChildren(...parts);
    return;
  }

  lead.append(
    h('h2', { className: 'section-title reset-list-title' }, "Here's where we can start."),
    stepCard({
      number: 1,
      selected: true,
      title: `${repairLabel(selected)}.`,
      tag: tagFor(selected),
      body: `${effectText(selected, state)} Checked against every deadline with sleep protected.`,
      actions: !selected.needsApproval
        ? h('div', { className: 'section-actions' },
            h('button', {
              type: 'button', id: 'apply-lead', className: 'button button-primary',
              onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: selected.id })
            }, 'Apply this change'))
        : null
    })
  );
  parts.push(lead);
  if (selected.needsApproval) parts.push(renderApproval(selected, state, derived, dispatch));

  const others = visible.filter(item => item.id !== selected.id);
  if (others.length) {
    parts.push(
      h('details', { className: 'quiet-details', id: 'reset-alternatives' },
        h('summary', {}, `Other options (${others.length})`),
        h('ul', { className: 'alt-list' },
          others.map((repair, index) =>
            h('li', { className: 'repair-card' },
              stepCard({
                number: index + 2,
                title: `${repairLabel(repair)}.`,
                tag: tagFor(repair),
                body: effectText(repair, state),
                actions: h('button', {
                  type: 'button', className: 'link-button',
                  onClick: () => dispatch({ type: 'SELECT_REPAIR', repairId: repair.id })
                }, 'Use this instead')
              }))))
      )
    );
  }

  const week = weekView(state.days, previewWeekIndex(selected, derived));
  parts.push(
    h('details', { className: 'quiet-details', id: 'reset-preview' },
      h('summary', {}, 'See the schedule after this change'),
      renderTimeline({
        scheduleResult: selected.test.typical,
        days: state.days,
        sleep: state.sleep,
        dayIndices: week.dayIndices,
        tasks: selected.updated,
        title: selected.needsApproval ? 'Schedule if approved (preview only)' : 'Schedule after this change (preview only)',
        kicker: 'PREVIEW',
        isPreview: true
      })
    )
  );
  if (history) parts.push(history);
  parts.push(
    h('div', { className: 'reset-foot' },
      h('p', { className: 'voice-line' }, "We'll take it step by step."),
      h('button', {
        type: 'button', id: 'reset-later', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'home' })
      }, "I'll come back to this"))
  );
  container.replaceChildren(...parts);
}
