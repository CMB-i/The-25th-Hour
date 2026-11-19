import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { deadlineCost } from '../engine/evaluate.mjs';
import { LOADED_WEEKS } from '../engine/weeks.mjs';
import {
  buildVerdictCopy,
  fmtHours,
  fmtMinutes,
  fmtShortDate,
  fmtShortWeekday,
  fmtSignedHours,
  fmtTimestamp,
  h,
  taskTag,
  taskTagLabel,
  verdictClass,
  verdictIcon,
  verdictLabel
} from './dom.mjs';
import { renderTimeline } from './render-timeline.mjs';

const STALE_CALENDAR_MS = 86_400_000;

function renderFreshnessBanner(state, dispatch) {
  const parsedImport = state.calendarImportedAt ? Date.parse(state.calendarImportedAt) : NaN;
  const isStale = !Number.isFinite(parsedImport) || (Date.now() - parsedImport > STALE_CALENDAR_MS);

  const calendarText = state.calendarImportedAt
    ? `Based on your calendar from ${fmtTimestamp(state.calendarImportedAt)}.`
    : 'No calendar imported yet (using weekly availability template).';
  const editText = state.lastEditedAt ? `Last edited ${fmtTimestamp(state.lastEditedAt)}.` : '';

  return h('div', { className: 'freshness-stack' },
    isStale
      ? h('div', { className: 'banner banner-warn', role: 'status' },
          h('div', { className: 'banner-body' },
            h('strong', {}, 'Calendar freshness: '),
            'Your calendar may be out of date. Re-import before relying on this.'
          ),
          h('button', {
            type: 'button',
            className: 'button button-outline button-sm',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
          }, 'Go to Imports')
        )
      : null,
    h('div', { className: 'freshness-meta' },
      h('span', { className: 'status-dot', 'aria-hidden': 'true' }),
      h('span', {}, [calendarText, editText].filter(Boolean).join(' '))
    )
  );
}

function renderDemoPanel(state, dispatch) {
  return h('section', { className: 'panel control-panel', 'aria-label': 'Workspace controls and demo scenarios' },
    h('div', { className: 'panel-label' },
      h('span', { className: 'panel-index' }, '01'),
      'COMMITMENT WORKSPACE'
    ),
    h('h3', {}, 'Weekly workload check'),
    h('p', { className: 'helper' },
      'Switch between the built-in Scenarios A & B, test workload changes, or add a new commitment.'
    ),
    h('div', { className: 'quick-actions' },
      h('button', {
        type: 'button',
        className: 'button button-primary',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      }, '+ Check a new commitment'),
      h('button', {
        type: 'button',
        className: 'button button-secondary',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
      }, 'Open Make It Work'),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
      }, 'Import calendar / tasks')
    ),
    h('div', { className: 'scenario-block' },
      h('span', { className: 'field-eyebrow' }, 'BUILT-IN DEMO SCENARIOS'),
      h('div', { className: 'scenario-choices', role: 'group', 'aria-label': 'Demo scenarios' },
        h('button', {
          type: 'button',
          className: `scenario-button${state.demo && !state.fixed ? ' active' : ''}`,
          'aria-pressed': String(Boolean(state.demo && !state.fixed)),
          onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
        },
          h('b', {}, '01'),
          h('span', {},
            h('strong', {}, 'Flexible target (Scenario A)'),
            h('small', {}, 'Club poster target can move from Thu to Fri')
          )
        ),
        h('button', {
          type: 'button',
          className: `scenario-button${state.demo && state.fixed ? ' active' : ''}`,
          'aria-pressed': String(Boolean(state.demo && state.fixed)),
          onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: true })
        },
          h('b', {}, '02'),
          h('span', {},
            h('strong', {}, 'All deadlines fixed (Scenario B)'),
            h('small', {}, 'Poster extension requires approval')
          )
        )
      )
    ),
    state.demo
      ? h('div', { className: 'research-box' },
          h('label', { className: 'check-line' },
            h('input', {
              type: 'checkbox',
              checked: state.includeResearch,
              onChange: ev => dispatch({
                type: 'UPDATE_DEMO_RESEARCH',
                includeResearch: ev.currentTarget.checked,
                researchHours: state.researchHours
              })
            }),
            h('span', {},
              h('strong', {}, 'Include demo research proposal'),
              h('small', {}, 'Due Thursday · 2026-11-19 (droppable proposal)')
            )
          ),
          h('div', { className: 'range-head' },
            h('label', { for: 'demo-research-range' }, 'Typical hours needed'),
            h('strong', {}, fmtHours(state.researchHours))
          ),
          h('input', {
            id: 'demo-research-range',
            className: 'hour-range',
            type: 'range',
            min: '4',
            max: '6',
            step: '0.5',
            value: String(state.researchHours),
            disabled: !state.includeResearch,
            'aria-label': 'Demo research typical hours',
            onChange: ev => dispatch({
              type: 'UPDATE_DEMO_RESEARCH',
              includeResearch: state.includeResearch,
              researchHours: Number(ev.currentTarget.value)
            })
          }),
          h('div', { className: 'range-ends' },
            h('span', {}, '4h'),
            h('span', {}, '5h'),
            h('span', {}, '6h')
          ),
          h('div', { className: 'estimate-note' },
            state.includeResearch
              ? `Planning range: ${fmtHours(state.researchHours - 1)}–${fmtHours(state.researchHours + 1)} (optimistic to conservative).`
              : 'Research proposal excluded (Scenario D baseline).'
          )
        )
      : null
  );
}

function renderVerdictCard(state, derived, dispatch) {
  const { evaluation, weekly, bindingCost, conservativeCost, repairs } = derived;
  const copy = buildVerdictCopy(evaluation, state.days);
  const cls = verdictClass(evaluation.verdict);
  const icon = verdictIcon(evaluation.verdict);
  const label = verdictLabel(evaluation.verdict);

  const conservativeNote =
    evaluation.verdict === 'infeasible' && conservativeCost && conservativeCost.shortfallHours > 0
      ? `At conservative estimates, ${conservativeCost.weekday} (${conservativeCost.date}) is ${fmtHours(conservativeCost.shortfallHours)} short.`
      : '';

  const tightestMetricValue = bindingCost ? fmtSignedHours(bindingCost.marginHours) : '✓';
  const tightestMetricSub = bindingCost
    ? `${fmtShortWeekday(bindingCost.date)} margin`
    : 'No deadlines';
  const tightestNegative = Boolean(bindingCost && bindingCost.marginHours < 0);

  return h('section', {
    id: 'week-verdict',
    className: `verdict-card ${cls}`,
    'aria-live': 'polite'
  },
    h('div', { className: 'verdict-left' },
      h('div', { className: 'verdict-top' },
        h('span', { className: `verdict-badge ${cls}` }, `${icon} ${label.toUpperCase()}`),
        h('span', {}, 'LIVE SCHEDULE CHECK')
      ),
      h('h2', {}, copy.headline),
      h('p', { className: 'verdict-body' }, copy.body),
      copy.contributingText ? h('p', { className: 'verdict-contrib' }, copy.contributingText) : null,
      copy.releaseNote ? h('p', { className: 'verdict-contrib' }, copy.releaseNote) : null,
      conservativeNote ? h('p', { className: 'verdict-contrib' }, conservativeNote) : null,
      repairs.length > 0
        ? h('div', { className: 'verdict-cta' },
            h('button', {
              type: 'button',
              className: 'button button-primary',
              onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
            }, `See ${Math.min(5, repairs.length)} verified fix${repairs.length === 1 ? '' : 'es'} in Make It Work →`)
          )
        : evaluation.verdict !== 'feasible'
          ? h('div', { className: 'verdict-cta' },
              h('button', {
                type: 'button',
                className: 'button button-outline',
                onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
              }, 'Check options in Make It Work →')
            )
          : null
    ),
    h('div', { className: 'verdict-metrics' },
      h('div', { className: 'metric' },
        h('b', {}, fmtMinutes(weekly.requiredMinutes)),
        h('small', {}, 'Required this week')
      ),
      h('div', { className: 'metric' },
        h('b', {}, fmtMinutes(weekly.capacityMinutes)),
        h('small', {}, 'Available this week')
      ),
      h('div', { className: `metric ${tightestNegative ? 'negative' : 'positive'}` },
        h('b', {}, tightestMetricValue),
        h('small', {}, tightestMetricSub)
      )
    )
  );
}

function renderComparisonCards(derived, dispatch) {
  const { evaluation, weekly, bindingCost, repairs } = derived;
  const top = repairs[0];
  const baselineTag = weekly.feasible ? 'Fits in weekly total' : 'Over weekly total';
  const schedulerTag = evaluation.typical.feasible
    ? 'Meets entered targets'
    : bindingCost
      ? `${fmtHours(bindingCost.shortfallHours)} short by ${bindingCost.weekday}`
      : `${fmtMinutes(evaluation.typical.lateMinutes)} deadline shortfall`;

  const rescueStatus = top
    ? (top.needsApproval ? 'Approval request needed' : 'Self-serve repair found')
    : (evaluation.verdict === 'feasible'
        ? 'No change needed'
        : evaluation.verdict === 'at-risk'
          ? 'Monitor narrow buffer'
          : 'No verified fix');

  return h('section', { className: 'panel comparison', 'aria-label': 'Three-way comparison' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('div', { className: 'panel-label' },
          h('span', { className: 'panel-index' }, '02'),
          'SIDE-BY-SIDE'
        ),
        h('h3', {}, 'Three ways to check one week.')
      ),
      h('span', { className: 'comparison-chip' }, 'Same inputs · simulated comparison')
    ),
    h('div', { className: 'comparison-cards' },
      h('article', { className: 'compare-card' },
        h('div', { className: 'compare-label' }, 'Weekly hours only (simulated baseline)'),
        h('div', { className: 'compare-num' }, weekly.feasible ? '✓ Fits' : '✕ Over'),
        h('div', { className: 'compare-body' },
          `${fmtMinutes(weekly.requiredMinutes)} of ${fmtMinutes(weekly.capacityMinutes)} available this week. Ignores which hours fall before each deadline.`
        ),
        h('div', { className: `compare-tag${weekly.feasible ? ' positive' : ''}` }, baselineTag)
      ),
      h('article', { className: 'compare-card' },
        h('div', { className: 'compare-label' }, 'Deadline-aware scheduler (same allocation, no repair step)'),
        h('div', { className: 'compare-num' }, evaluation.typical.feasible ? '✓ Fits' : '✕ Misses'),
        h('div', { className: 'compare-body' },
          'Runs the same earliest-deadline allocation and flags timing conflicts, without testing verified adjustments.'
        ),
        h('div', { className: `compare-tag${evaluation.typical.feasible ? ' positive' : ''}` }, schedulerTag)
      ),
      h('article', { className: 'compare-card highlight' },
        h('div', { className: 'compare-label' }, 'The 25th Hour'),
        h('div', { className: 'compare-num' },
          top ? '↗ Repair' : evaluation.verdict === 'feasible' ? '✓ Ready' : '▲ Watch'
        ),
        h('div', { className: 'compare-body' },
          'Tests 1–2 candidate changes, re-checks every deadline and protected sleep slot, and separates self-serve fixes from approval requests.'
        ),
        h('div', { className: `compare-tag${top && !top.needsApproval ? ' positive' : ''}` }, rescueStatus),
        top
          ? h('button', {
              type: 'button',
              className: 'button button-outline button-sm compare-btn',
              onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
            }, 'Review in Make It Work')
          : null
      )
    )
  );
}

function renderUncertaintyPanel(state, derived) {
  const levels = [
    ['optimistic', 'Optimistic'],
    ['typical', 'Typical'],
    ['conservative', 'Conservative']
  ];

  const rows = levels.map(([key, label]) => {
    const sched = derived.evaluation[key];
    const cost = deadlineCost(sched, state.days);
    const bindingText = cost
      ? `${fmtShortWeekday(cost.date)} ${fmtSignedHours(cost.marginHours)}`
      : 'No deadlines';
    const isShort = Boolean(cost && cost.marginHours < 0);
    return h('div', { className: 'estimate-row' },
      h('strong', {}, label),
      h('span', { className: isShort ? 'not-ok' : 'ok' }, bindingText),
      h('strong', { className: sched.feasible ? 'ok' : 'not-ok' }, sched.feasible ? '✓ Fit' : '✕ Miss')
    );
  });

  return h('section', { className: 'panel uncertainty-panel' },
    h('span', { className: 'panel-label' }, 'ESTIMATE UNCERTAINTY'),
    h('h3', {}, 'Three-estimate check'),
    h('p', { className: 'helper' },
      'Every schedule is checked at optimistic, typical, and conservative task hours on the tightest deadline.'
    ),
    h('div', { className: 'estimate-table' },
      h('div', { className: 'estimate-row header' },
        h('span', {}, 'ASSUMPTION'),
        h('span', {}, 'TIGHTEST DAY'),
        h('span', {}, 'DEADLINES')
      ),
      rows
    ),
    h('div', { className: 'risk-note' },
      `${derived.evaluation.reason} A feasible plan makes room to sleep; it can't guarantee sleep.`
    )
  );
}

function renderTaskList(state, derived) {
  const inWeek = derived.activeTasks.filter(task => derived.week.dayIndices.includes(task.targetDay));
  const otherWeeksCount = derived.activeTasks.filter(task => !derived.week.dayIndices.includes(task.targetDay)).length;

  const taskRow = task => {
    const tag = taskTag(task);
    const targetDate = state.days[task.targetDay]?.date;
    const hardDate = state.days[task.hardDay]?.date;
    const rangeInfo = task.min !== task.max
      ? `${fmtHours(task.likely)} typical (${fmtHours(task.min)}–${fmtHours(task.max)})`
      : fmtHours(task.likely);
    const deadlineInfo = task.hardDay !== task.targetDay && hardDate
      ? `${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)} target · ${fmtShortWeekday(hardDate)} ${fmtShortDate(hardDate)} hard limit`
      : `${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)} deadline`;

    return h('li', { className: `task-row${task.removed ? ' is-removed' : ''}` },
      h('div', { className: 'task-row-title' },
        h('strong', {},
          task.title,
          task.isProposal ? h('span', { className: 'inline-chip' }, 'Proposal') : null,
          task.removed ? h('span', { className: 'inline-chip removed' }, 'Removed') : null
        ),
        h('small', {}, `${rangeInfo} · ${deadlineInfo}`)
      ),
      h('span', { className: `task-pill ${tag}` }, taskTagLabel(tag))
    );
  };

  return h('section', { className: 'panel commitments-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'COMMITMENTS THIS WEEK'),
        h('h3', {}, 'Scheduled commitments & deadlines')
      ),
      h('span', { className: 'pill' }, `${inWeek.length} in week ${derived.weekIndex + 1}`)
    ),
    inWeek.length
      ? h('ul', { className: 'task-list' }, inWeek.map(taskRow))
      : h('p', { className: 'helper' }, 'No open commitments due in this week.'),
    otherWeeksCount > 0
      ? h('p', { className: 'helper other-weeks-note' },
          `${otherWeeksCount} additional commitment${otherWeeksCount === 1 ? '' : 's'} due in other loaded weeks.`
        )
      : null
  );
}

/**
 * Renders Screen 1: My Week.
 */
export function renderWeekScreen(container, { state, derived, dispatch }) {
  const sleepMinutes = plannedSleepMinutes(state.sleep);
  const totalWeeks = Math.max(1, derived.maxWeekIndex + 1);
  const rangeLabel = `Week ${derived.weekIndex + 1} of ${totalWeeks} · ${fmtShortDate(derived.week.startDate)} – ${fmtShortDate(derived.week.endDate)}, ${derived.week.startDate.slice(0, 4)}`;

  const unresolvedBanner = state.unresolvedConflict && !derived.evaluation.typical.feasible
    ? h('div', { className: 'banner banner-alert', role: 'status' },
        h('div', { className: 'banner-body' },
          h('strong', {}, 'Unresolved deadline conflict: '),
          'You accepted a commitment while the schedule was infeasible. Protected sleep slots remain untouched, and the conflict stays visible until resolved.'
        ),
        h('button', {
          type: 'button',
          className: 'button button-outline button-sm',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
        }, 'Review fixes')
      )
    : null;

  const sleepStrip = h('div', { className: 'sleep-strip' },
    h('div', {},
      h('strong', {}, `Protected sleep time: ${state.sleep.start}–${state.sleep.end} (${fmtMinutes(sleepMinutes)}/night)`),
      h('span', {}, 'Excluded before any work is scheduled.')
    ),
    h('small', {}, "A feasible plan makes room to sleep; it can't guarantee sleep.")
  );

  const weekControls = h('div', { className: 'week-nav-bar panel' },
    h('div', { className: 'week-nav-buttons' },
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        disabled: derived.weekIndex <= 0,
        onClick: () => dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex - 1 })
      }, '← Previous week'),
      h('span', { className: 'week-range-label' }, rangeLabel),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        disabled: derived.weekIndex >= Math.min(LOADED_WEEKS - 1, derived.maxWeekIndex),
        onClick: () => dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex + 1 })
      }, 'Next week →')
    ),
    sleepStrip
  );

  container.replaceChildren(
    renderFreshnessBanner(state, dispatch),
    unresolvedBanner ?? '',
    h('div', { className: 'workspace-grid' },
      renderDemoPanel(state, dispatch),
      h('div', { className: 'results-panel' },
        renderVerdictCard(state, derived, dispatch),
        renderComparisonCards(derived, dispatch)
      )
    ),
    weekControls,
    h('div', { className: 'deep-grid' },
      renderTimeline({
        scheduleResult: derived.evaluation.typical,
        days: state.days,
        sleep: state.sleep,
        dayIndices: derived.week.dayIndices,
        tasks: derived.activeTasks,
        title: `Week ${derived.weekIndex + 1} schedule (${fmtShortDate(derived.week.startDate)}–${fmtShortDate(derived.week.endDate)})`,
        kicker: 'TIME ALLOCATION · 30-MIN SLOTS',
        isPreview: false
      }),
      renderUncertaintyPanel(state, derived)
    ),
    renderTaskList(state, derived)
  );
}
