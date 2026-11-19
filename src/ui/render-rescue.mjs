import { deadlineCost } from '../engine/evaluate.mjs';
import { draftApprovalRequest, emptyRepairMessage } from '../engine/repairs.mjs';
import { weekView } from '../engine/weeks.mjs';
import {
  buildVerdictCopy,
  copyToClipboard,
  fmtShortDate,
  fmtShortWeekday,
  fmtSignedHours,
  fmtTimestamp,
  h,
  verdictClass,
  verdictIcon,
  verdictLabel
} from './dom.mjs';
import { getApprovalRecord } from './state.mjs';
import { renderTimeline } from './render-timeline.mjs';

function formatMarginLine(label, cost) {
  if (!cost) return `${label}: No deadlines`;
  return `${label}: ${fmtShortWeekday(cost.date)} (${fmtShortDate(cost.date)}) ${fmtSignedHours(cost.marginHours)}`;
}

function previewWeekIndex(repair, state, derived) {
  const firstAction = repair.actions[0];
  const targetDay = firstAction?.toDay
    ?? repair.updated.find(task => task.id === firstAction?.taskId)?.targetDay;
  if (Number.isInteger(targetDay)) {
    return Math.min(derived.maxWeekIndex, Math.max(0, Math.floor(targetDay / 7)));
  }
  return derived.weekIndex;
}

function approvalBadgeText(repair, status) {
  if (!repair.needsApproval) return 'Self-serve';
  if (status === 'approved') return 'Needs approval · Approved (ready to apply)';
  if (status === 'declined') return 'Needs approval · Declined';
  return 'Needs approval (pending)';
}

function renderHistoryPanel(state, dispatch) {
  const changes = state.appliedChanges;
  return h('section', { className: 'panel history-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'APPLIED CHANGES & UNDO'),
        h('h3', {}, 'Adjustment log')
      ),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        disabled: changes.length === 0,
        onClick: () => dispatch({ type: 'UNDO_LAST_REPAIR' })
      }, changes.length ? `Undo last change (${changes.length})` : 'Nothing to undo')
    ),
    changes.length
      ? h('ul', { className: 'history-list' },
          [...changes].reverse().map(change =>
            h('li', { className: 'history-row' },
              h('div', {},
                h('strong', {}, (change.labels ?? []).join(' + ') || 'Applied adjustment'),
                change.recordedAt ? h('small', {}, `Applied ${fmtTimestamp(change.recordedAt)}`) : null
              ),
              h('span', { className: `task-pill ${change.approved ? 'flexible' : 'droppable'}` },
                change.approved ? 'Approved' : 'Self-serve'
              )
            )
          )
        )
      : h('p', { className: 'helper' }, 'No repairs have been applied to your plan yet.')
  );
}

function renderPreviewPanel(selected, state, derived, dispatch) {
  const approvalRecord = selected.needsApproval
    ? getApprovalRecord(state, selected.id, derived.fingerprint)
    : null;
  const approvalStatus = approvalRecord?.status ?? 'pending';
  const typAfter = deadlineCost(selected.test.typical, state.days);
  const consAfter = deadlineCost(selected.test.conservative, state.days);
  const targetWeek = previewWeekIndex(selected, state, derived);
  const previewWeek = weekView(state.days, targetWeek);
  const previewResultClass = verdictClass(selected.test.verdict);
  const requestDraft = selected.needsApproval
    ? draftApprovalRequest(selected, state.days, { includeWorkload: state.draftIncludeWorkload })
    : '';

  const controls = !selected.needsApproval
    ? h('div', { className: 'preview-actions' },
        h('button', {
          type: 'button',
          className: 'button button-primary',
          onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: selected.id })
        }, 'Apply verified change'),
        h('p', { className: 'tiny-note' },
          'Self-serve adjustment. Re-checked against all deadlines and protected sleep slots.'
        )
      )
    : h('div', { className: 'approval-workflow' },
        h('div', { className: 'banner banner-warn' },
          h('div', { className: 'banner-body' },
            h('strong', {}, 'If approved (hypothetical preview): '),
            'Your real plan, deadlines, and verdict do not change until you mark this request approved and apply it.'
          )
        ),
        h('div', { className: 'request-draft-block' },
          h('div', { className: 'draft-header' },
            h('strong', {}, 'Request message draft (copy & send yourself — never sent automatically)'),
            h('label', { className: 'inline-check' },
              h('input', {
                type: 'checkbox',
                checked: state.draftIncludeWorkload,
                onChange: ev => dispatch({
                  type: 'SET_DRAFT_WORKLOAD',
                  include: ev.currentTarget.checked
                })
              }),
              h('span', {}, 'Include my workload summary')
            )
          ),
          h('pre', { className: 'draft-box', tabindex: '0', 'aria-label': 'Draft approval request message' }, requestDraft),
          h('button', {
            type: 'button',
            className: 'button button-outline',
            onClick: async () => {
              const copied = await copyToClipboard(requestDraft);
              dispatch({
                type: 'SET_NOTICE',
                notice: copied
                  ? 'Approval request copied to clipboard. It has NOT been sent.'
                  : 'Could not access clipboard automatically; select and copy the draft text above.'
              });
            }
          }, 'Copy approval request')
        ),
        h('div', { className: 'approval-decision-row' },
          h('button', {
            type: 'button',
            className: `button ${approvalStatus === 'approved' ? 'button-primary' : 'button-secondary'}`,
            'aria-pressed': String(approvalStatus === 'approved'),
            onClick: () => dispatch({ type: 'SET_APPROVAL_STATUS', repairId: selected.id, status: 'approved' })
          }, 'Mark approved'),
          h('button', {
            type: 'button',
            className: `button ${approvalStatus === 'declined' ? 'button-danger-outline' : 'button-quiet'}`,
            'aria-pressed': String(approvalStatus === 'declined'),
            onClick: () => dispatch({ type: 'SET_APPROVAL_STATUS', repairId: selected.id, status: 'declined' })
          }, 'Mark declined'),
          h('button', {
            type: 'button',
            className: 'button button-primary',
            disabled: approvalStatus !== 'approved',
            onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: selected.id })
          }, 'Apply approved change')
        ),
        h('p', { className: 'tiny-note' },
          approvalStatus === 'approved'
            ? 'Explicit approval recorded. Click "Apply approved change" to commit this change to your real plan.'
            : approvalStatus === 'declined'
              ? 'Request marked declined. Your real plan remains unchanged.'
              : 'Waiting on confirmation. Real tasks and deadlines remain unchanged.'
        )
      );

  return h('div', { className: 'strategy-preview panel' },
    h('span', { className: 'preview-kicker' },
      selected.needsApproval ? 'IF APPROVED · HYPOTHETICAL PREVIEW' : 'VERIFIED SELF-SERVE PREVIEW'
    ),
    h('h4', {}, selected.actions.map(action => action.label).join(' + ')),
    h('p', { className: 'helper' }, selected.actions.map(action => action.description).join(' ')),
    h('div', { className: 'preview-facts' },
      h('div', { className: 'preview-fact' },
        h('span', {}, selected.needsApproval ? 'Verdict if approved' : 'Verdict after change'),
        h('strong', { className: `verdict-inline ${previewResultClass}` },
          `${verdictIcon(selected.test.verdict)} ${verdictLabel(selected.test.verdict)}`
        )
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, 'Typical tightest margin'),
        h('strong', {}, typAfter ? `${fmtShortWeekday(typAfter.date)} ${fmtSignedHours(typAfter.marginHours)}` : 'n/a')
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, 'Conservative tightest margin'),
        h('strong', {}, consAfter ? `${fmtShortWeekday(consAfter.date)} ${fmtSignedHours(consAfter.marginHours)}` : 'n/a')
      ),
      h('div', { className: 'preview-fact' },
        h('span', {}, 'Changes required'),
        h('strong', {}, `${selected.actions.length} change${selected.actions.length === 1 ? '' : 's'}`)
      )
    ),
    controls,
    renderTimeline({
      scheduleResult: selected.test.typical,
      days: state.days,
      sleep: state.sleep,
      dayIndices: previewWeek.dayIndices,
      tasks: selected.updated,
      title: selected.needsApproval
        ? `Week ${targetWeek + 1} schedule (If approved — preview only)`
        : `Week ${targetWeek + 1} repaired schedule (preview only)`,
      kicker: selected.needsApproval ? 'IF APPROVED TIMELINE' : 'REPAIRED TIMELINE PREVIEW',
      isPreview: true
    })
  );
}

/**
 * Renders Screen 3: Make It Work (Rescue Engine).
 */
export function renderRescueScreen(container, { state, derived, dispatch }) {
  const { evaluation, repairs } = derived;
  const copy = buildVerdictCopy(evaluation, state.days);
  const verdictCls = verdictClass(evaluation.verdict);
  const titleByVerdict = {
    infeasible: 'Smallest verified changes.',
    'at-risk': 'Protect your buffer.',
    feasible: 'No intervention needed.'
  }[evaluation.verdict] ?? 'Rescue Engine';

  const headerBar = h('section', { className: 'panel rescue-header' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('div', { className: 'panel-label' },
          h('span', { className: 'panel-index' }, '03'),
          'RESCUE ENGINE · MAKE IT WORK'
        ),
        h('h2', {}, titleByVerdict),
        h('p', { className: 'helper' },
          'Every candidate fix is re-run through the deadline-aware scheduler with your protected sleep window untouched.'
        )
      ),
      h('span', { className: `verdict-badge ${verdictCls}` },
        `${verdictIcon(evaluation.verdict)} ${verdictLabel(evaluation.verdict).toUpperCase()}`
      )
    ),
    h('div', { className: 'rescue-summary-line' },
      h('strong', {}, copy.headline),
      ' ',
      copy.body
    ),
    h('div', { className: 'quick-actions' },
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, '← Back to My Week'),
      h('button', {
        type: 'button',
        className: 'button button-secondary',
        disabled: state.appliedChanges.length === 0,
        onClick: () => dispatch({ type: 'UNDO_LAST_REPAIR' })
      }, state.appliedChanges.length
        ? `Undo last change (${state.appliedChanges.length})`
        : 'Undo last change'),
      state.demo
        ? h('button', {
            type: 'button',
            className: `button ${!state.fixed ? 'button-outline' : 'button-quiet'}`,
            onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
          }, 'Scenario A (Flexible)')
        : null,
      state.demo
        ? h('button', {
            type: 'button',
            className: `button ${state.fixed ? 'button-outline' : 'button-quiet'}`,
            onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: true })
          }, 'Scenario B (Fixed)')
        : null
    )
  );

  if (!repairs.length) {
    const emptyMsg = emptyRepairMessage(evaluation.verdict);
    const emptyPanel = h('section', { className: `panel empty-rescue ${verdictCls}` },
      h('h3', {}, emptyMsg),
      evaluation.verdict === 'infeasible'
        ? h('p', { className: 'helper' },
            'Mark a task flexible or droppable to give the Rescue Engine options, or coordinate an extension on a hard deadline.'
          )
        : evaluation.verdict === 'at-risk'
          ? h('p', { className: 'helper' },
              'Your typical estimates fit, and no single or pair adjustment improves the verdict further.'
            )
          : h('p', { className: 'helper' },
              'Every deadline is already met with at least 1h of conservative slack. Protected sleep remains untouched.'
            ),
      h('button', {
        type: 'button',
        className: 'button button-outline',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, 'Return to My Week')
    );
    container.replaceChildren(headerBar, emptyPanel, renderHistoryPanel(state, dispatch));
    return;
  }

  const visibleRepairs = repairs.slice(0, 5);
  const selected = visibleRepairs.find(item => item.id === state.selectedRepairId) ?? visibleRepairs[0];

  const cards = visibleRepairs.map((repair, index) => {
    const isSelected = repair.id === selected.id;
    const record = repair.needsApproval
      ? getApprovalRecord(state, repair.id, derived.fingerprint)
      : null;
    const approvalStatus = record?.status ?? 'pending';
    const typAfter = deadlineCost(repair.test.typical, state.days);
    const consAfter = deadlineCost(repair.test.conservative, state.days);
    const changeCount = `${repair.actions.length} change${repair.actions.length === 1 ? '' : 's'}`;
    const resultCls = verdictClass(repair.test.verdict);

    return h('article', { className: `repair-card panel${isSelected ? ' selected' : ''}` },
      h('div', { className: 'repair-card-head' },
        h('span', { className: 'repair-num' }, String(index + 1).padStart(2, '0')),
        h('div', { className: 'repair-card-title' },
          h('h3', {}, repair.actions.map(action => action.label).join(' + ')),
          h('p', { className: 'repair-desc' },
            repair.actions.map(action => action.description).join(' ')
          )
        )
      ),
      h('div', { className: 'repair-badges' },
        h('span', { className: `repair-status ${repair.needsApproval ? 'pending' : 'self-serve'}` },
          approvalBadgeText(repair, approvalStatus)
        ),
        h('span', { className: 'pill' }, changeCount),
        h('span', { className: `verdict-pill ${resultCls}` },
          `${repair.needsApproval ? 'If approved: ' : 'After: '}${verdictIcon(repair.test.verdict)} ${verdictLabel(repair.test.verdict)}`
        )
      ),
      h('div', { className: 'repair-margins' },
        h('span', {}, formatMarginLine('Typical margin', typAfter)),
        h('span', {}, formatMarginLine('Conservative margin', consAfter))
      ),
      h('div', { className: 'repair-card-actions' },
        h('button', {
          type: 'button',
          className: `button ${isSelected ? 'button-secondary' : 'button-outline'}`,
          'aria-pressed': String(isSelected),
          onClick: () => dispatch({ type: 'SELECT_REPAIR', repairId: repair.id })
        }, isSelected ? 'Previewing' : 'Preview'),
        !repair.needsApproval
          ? h('button', {
              type: 'button',
              className: 'button button-primary',
              onClick: () => dispatch({ type: 'APPLY_REPAIR', repairId: repair.id })
            }, 'Apply')
          : null
      )
    );
  });

  container.replaceChildren(
    headerBar,
    h('div', { className: 'strategy-layout' },
      h('div', { className: 'strategy-list', 'aria-label': 'Verified repair options' },
        cards,
        repairs.length > 5
          ? h('p', { className: 'helper' }, `Showing top 5 of ${repairs.length} verified options.`)
          : null
      ),
      renderPreviewPanel(selected, state, derived, dispatch)
    ),
    renderHistoryPanel(state, dispatch)
  );
}
