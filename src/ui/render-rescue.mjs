import { deadlineCost } from '../engine/evaluate.mjs';
import { draftApprovalRequest, emptyRepairMessage } from '../engine/repairs.mjs';
import { weekView } from '../engine/weeks.mjs';
import { conflictClause, dayLabel, hoursPhrase } from './check-model.mjs';
import { fmtTimestamp, h, verdictLabel } from './dom.mjs';
import { makeCopyControls } from './reply-slip.mjs';
import { renderTimeline } from './render-timeline.mjs';
import { getApprovalRecord } from './state.mjs';

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

/**
 * Renders Reset: the first conflict, one verified change and what to do next.
 */
export function renderRescueScreen(container, { state, derived, dispatch }) {
  const { evaluation, repairs } = derived;
  const parts = [];
  parts.push(
    h('header', { className: 'screen-intro' },
      h('h1', { className: 'screen-title' }, 'Reset'),
      h('p', { className: 'screen-lede' }, 'Get an overfilled week back under control.')
    )
  );

  const history = renderHistory(state, dispatch);

  if (evaluation.verdict === 'feasible') {
    parts.push(
      h('section', { id: 'reset-lead', className: 'verdict-block verdict-fits' },
        h('p', { id: 'reset-status', className: 'verdict-word verdict-word-fits' }, 'Fits'),
        h('h2', { className: 'verdict-headline' }, 'Nothing needs to move.'),
        h('p', { className: 'verdict-detail' },
          `${emptyRepairMessage('feasible')}. Every deadline is met with at least an hour to spare, even if things run long.`),
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

  const visible = repairs.slice(0, 5);
  const selected = visible.find(item => item.id === state.selectedRepairId) ?? visible[0] ?? null;

  const lead = h('section', { id: 'reset-lead', className: `verdict-block verdict-${tone}` },
    h('p', { id: 'reset-status', className: `verdict-word verdict-word-${tone}` }, verdictLabel(evaluation.verdict)),
    h('h2', { className: 'verdict-headline reset-headline' }, first)
  );

  if (!selected) {
    lead.append(
      h('p', { className: 'verdict-detail' }, emptyRepairMessage(evaluation.verdict)),
      h('p', { className: 'verdict-note' },
        'Check what the app is counting: a missing busy block or wrong work hours can change this.'),
      h('div', { className: 'section-actions' },
        h('button', {
          type: 'button', id: 'reset-to-week', className: 'button button-secondary',
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
    h('div', { className: 'lead-change' },
      h('p', { className: 'eyebrow' }, 'One verified change'),
      h('h3', {}, repairLabel(selected)),
      h('span', { className: `option-tag ${selected.needsApproval ? 'needs-approval' : 'self-serve'}` },
        selected.needsApproval ? 'If approved' : 'You can do this yourself'),
      h('p', { className: 'option-result' }, effectText(selected, state)),
      h('p', { className: 'option-note' }, 'Checked against every deadline with sleep protected.')
    )
  );
  if (!selected.needsApproval) {
    lead.append(
      h('div', { className: 'section-actions' },
        h('button', {
          type: 'button', id: 'apply-lead', className: 'button button-primary',
          onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: selected.id })
        }, 'Apply this change'))
    );
  }
  parts.push(lead);
  if (selected.needsApproval) parts.push(renderApproval(selected, state, derived, dispatch));

  const others = visible.filter(item => item.id !== selected.id);
  if (others.length) {
    parts.push(
      h('details', { className: 'quiet-details', id: 'reset-alternatives' },
        h('summary', {}, `Other options (${others.length})`),
        h('ul', { className: 'alt-list' },
          others.map(repair =>
            h('li', { className: 'repair-card' },
              h('div', {},
                h('strong', {}, repairLabel(repair)),
                ' ',
                h('span', { className: `option-tag ${repair.needsApproval ? 'needs-approval' : 'self-serve'}` },
                  repair.needsApproval ? 'If approved' : 'You can do this yourself'),
                h('p', { className: 'option-note' }, effectText(repair, state))),
              h('button', {
                type: 'button', className: 'link-button',
                onClick: () => dispatch({ type: 'SELECT_REPAIR', repairId: repair.id })
              }, 'Use this instead'))))
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
  container.replaceChildren(...parts);
}
