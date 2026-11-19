import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { campusDate, getEstimateSuggestion, sevenDayReview } from '../engine/feedback.mjs';
import { TASK_TYPES } from '../engine/scheduler.mjs';
import {
  fmtHours,
  fmtMinutes,
  fmtSignedHours,
  fmtTimestamp,
  h
} from './dom.mjs';

const TYPE_LABELS = {
  problem_set: { label: 'Problem set', plural: 'problem sets' },
  lab: { label: 'Lab', plural: 'labs' },
  report: { label: 'Report', plural: 'reports' },
  reading: { label: 'Reading', plural: 'readings' },
  project: { label: 'Project', plural: 'projects' },
  club: { label: 'Club', plural: 'club tasks' },
  other: { label: 'Other', plural: 'other tasks' }
};

/**
 * Finds open tasks whose target date has arrived or passed relative to currentCampusDate.
 */
export function findEligibleTasksForFeedback(state, currentCampusDate) {
  const completedIds = new Set(state.feedback.tasks.map(entry => entry.taskId));
  return state.tasks.filter(task => {
    if (task.removed || completedIds.has(task.id)) return false;
    const targetDate = state.days[task.targetDay]?.date;
    return Boolean(targetDate && currentCampusDate && targetDate <= currentCampusDate);
  });
}

/**
 * Lists open tasks and pending proposals that have an available >=3-sample learned estimate suggestion
 * different from their current typical hours (never applied automatically).
 */
export function findOpenTasksWithLearnedSuggestions(state, profiles = []) {
  const completedIds = new Set(state.feedback.tasks.map(entry => entry.taskId));
  const candidates = [
    ...state.tasks.filter(task => !task.removed && !completedIds.has(task.id)),
    ...state.proposals
  ];
  const results = [];
  for (const task of candidates) {
    const type = task.type ?? 'other';
    const profile = profiles.find(item => item.type === type);
    if (!profile || profile.samples < 3) continue;
    const suggestedHours = getEstimateSuggestion(profile, task.likely);
    if (suggestedHours !== null && suggestedHours !== task.likely) {
      results.push({ task, profile, suggestedHours });
    }
  }
  return results;
}

/**
 * Renders Screen 4: Did It Work? (F3 Reality Feedback & 7-Day Review).
 */
export function renderFeedbackScreen(container, { state, derived, dispatch }) {
  const profiles = derived.estimateProfiles ?? [];
  const currentDay = state.demo
    ? (state.days[3]?.date ?? '2026-11-19')
    : (campusDate(new Date().toISOString()) ?? state.days[0]?.date ?? '2026-11-19');
  const eligibleTasks = findEligibleTasksForFeedback(state, currentDay);
  const completedIds = new Set(state.feedback.tasks.map(entry => entry.taskId));
  const selectableTasks = state.tasks.filter(task => !task.removed);
  const openTasks = selectableTasks.filter(task => !completedIds.has(task.id));
  const defaultTask = eligibleTasks[0] ?? openTasks[0] ?? selectableTasks[0] ?? null;

  const headerBar = h('section', { className: 'panel feedback-header' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('div', { className: 'panel-label' },
          h('span', { className: 'panel-index' }, '04'),
          'REALITY FEEDBACK · DID IT WORK?'
        ),
        h('h2', {}, 'Close the loop on estimates & protected sleep.'),
        h('p', { className: 'helper' },
          'Log actual hours once a task finishes, optionally record morning sleep and stress, and review the last 7 days. No scores, streaks, or guilt mechanics.'
        )
      ),
      h('span', { className: 'pill' }, `${state.feedback.tasks.length} completed · ${state.feedback.sleepReports.length} night(s) logged`)
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
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      }, 'Check a commitment (Should I Say Yes?)'),
      h('button', {
        type: 'button',
        className: 'button button-quiet',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
      }, 'Imports & Settings')
    )
  );

  // 1. Task Completion & Actual-Hours Prompt Form
  const promptBanner = h('div', {
    id: 'feedback-prompt',
    className: 'banner banner-warn',
    hidden: eligibleTasks.length === 0
  },
    eligibleTasks.length
      ? h('div', { className: 'banner-body' },
          h('strong', {}, 'How long did it actually take? '),
          `Target day reached for ${eligibleTasks.map(task => task.title).join(', ')}. Confirm with one tap on "As planned" or adjust the hours below.`
        )
      : ''
  );

  const feedbackError = h('p', {
    id: 'feedback-error',
    className: 'form-error-banner',
    role: 'alert',
    hidden: true
  });
  const clearFeedbackError = () => {
    feedbackError.textContent = '';
    feedbackError.hidden = true;
  };

  const taskSelect = h('select', {
    id: 'feedback-task-id',
    name: 'taskId',
    required: true,
    disabled: selectableTasks.length === 0
  },
    selectableTasks.length
      ? selectableTasks.map(task => {
          const existing = state.feedback.tasks.find(item => item.taskId === task.id);
          const date = state.days[task.targetDay]?.date ?? '';
          const status = existing ? ` (completed: ${fmtHours(existing.actualHours)} actual)` : '';
          return h('option', {
            value: task.id,
            selected: defaultTask?.id === task.id
          }, `${task.title} — ${fmtHours(task.likely)} est · due ${date}${status}`);
        })
      : [h('option', { value: '' }, 'No tasks available in plan')]
  );

  const typeSelect = h('select', {
    id: 'feedback-task-type',
    name: 'taskType'
  },
    TASK_TYPES.map(typeKey =>
      h('option', { value: typeKey }, `${typeKey} — ${(TYPE_LABELS[typeKey] ?? TYPE_LABELS.other).label}`)
    )
  );

  const actualHoursInput = h('input', {
    id: 'feedback-actual-hours',
    name: 'actualHours',
    type: 'number',
    min: '0',
    max: '60',
    step: '0.5',
    required: true
  });

  const recordedAtInput = h('input', {
    id: 'feedback-recorded-at',
    name: 'recordedAt',
    type: 'datetime-local',
    required: true
  });

  const asPlannedBtn = h('button', {
    id: 'as-planned',
    type: 'button',
    className: 'button button-secondary',
    disabled: !defaultTask
  }, 'As planned');

  function syncTaskDefaults() {
    clearFeedbackError();
    const task = selectableTasks.find(item => item.id === taskSelect.value) ?? defaultTask;
    if (!task) {
      actualHoursInput.value = '';
      recordedAtInput.value = '';
      asPlannedBtn.textContent = 'As planned';
      asPlannedBtn.disabled = true;
      return;
    }
    const previous = state.feedback.tasks.find(item => item.taskId === task.id);
    const estHours = previous?.estimatedLikely ?? task.likely;
    const resolvedType = previous?.type ?? task.type ?? 'other';
    typeSelect.value = TASK_TYPES.includes(resolvedType) ? resolvedType : 'other';
    actualHoursInput.value = String(previous?.actualHours ?? estHours);
    const defaultDate = state.days[task.targetDay]?.date ?? currentDay;
    const rawTime = previous?.recordedAt ?? `${defaultDate}T18:00`;
    recordedAtInput.value = rawTime.slice(0, 16);
    asPlannedBtn.textContent = `As planned (${fmtHours(estHours)})`;
    asPlannedBtn.disabled = false;
  }

  taskSelect.addEventListener('change', syncTaskDefaults);
  actualHoursInput.addEventListener('input', clearFeedbackError);
  recordedAtInput.addEventListener('input', clearFeedbackError);
  syncTaskDefaults();

  function submitTaskCompletion(asPlanned) {
    clearFeedbackError();
    try {
      dispatch({
        type: 'RECORD_FEEDBACK',
        taskId: taskSelect.value,
        taskType: typeSelect.value,
        actualHours: actualHoursInput.value,
        recordedAt: recordedAtInput.value,
        asPlanned
      }, { rethrow: true });
    } catch (error) {
      feedbackError.textContent = error?.message || 'Unable to save task feedback.';
      feedbackError.hidden = false;
    }
  }

  asPlannedBtn.addEventListener('click', () => submitTaskCompletion(true));

  const openSuggestions = findOpenTasksWithLearnedSuggestions(state, profiles);

  const taskFeedbackPanel = h('section', { className: 'panel task-feedback-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, '1 · ACTUAL HOURS PER TASK'),
        h('h3', {}, 'How long did it actually take?')
      ),
      h('span', { className: 'pill' }, 'Half-hour steps · 1-tap confirm')
    ),
    promptBanner,
    h('form', {
      id: 'completion-form',
      className: 'commitment-form',
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        submitTaskCompletion(false);
      }
    },
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-task-id' }, 'Task *'),
          taskSelect
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-task-type' }, 'Task type (for estimate learning)'),
          typeSelect
        )
      ),
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-actual-hours' }, 'Actual hours taken (0.5h steps) *'),
          actualHoursInput,
          h('small', { className: 'field-hint' }, 'Preset to typical estimate. Edit or tap "As planned".')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-recorded-at' }, 'Completion time (campus time) *'),
          recordedAtInput,
          h('small', { className: 'field-hint' }, 'Used to check whether target and hard deadlines were met.')
        )
      ),
      feedbackError,
      h('div', { className: 'form-submit-row' },
        h('button', {
          type: 'submit',
          className: 'button button-primary',
          disabled: selectableTasks.length === 0
        }, 'Mark completed and save'),
        asPlannedBtn
      )
    ),
    openSuggestions.length
      ? h('div', { className: 'open-suggestions-stack' },
          h('span', { className: 'field-eyebrow' }, 'OPTIONAL LEARNED ESTIMATE SUGGESTIONS FOR OPEN TASKS'),
          openSuggestions.map(({ task, profile, suggestedHours }) => {
            const labels = TYPE_LABELS[profile.type] ?? TYPE_LABELS.other;
            return h('div', { className: 'estimate-suggestion-banner', role: 'status' },
              h('span', {},
                `For "${task.title}": You said ${fmtHours(task.likely)}. Your last ${profile.samples} ${labels.plural} took ${Number(profile.ratio.toFixed(1))}× (${Number(profile.ratio.toFixed(3))}×) your estimate. Use ${fmtHours(suggestedHours)}?`
              ),
              h('button', {
                type: 'button',
                className: 'button button-secondary button-sm',
                onClick: () => dispatch({ type: 'APPLY_ESTIMATE_SUGGESTION', taskId: task.id })
              }, `Use ${fmtHours(suggestedHours)}`)
            );
          })
        )
      : null
  );

  // 2. Optional Morning Sleep & Stress Report
  const plannedSleepHrs = plannedSleepMinutes(state.sleep) / 60;
  const alreadySkippedToday = state.skippedSleepPromptDate === currentDay;
  const existingSleepToday = state.feedback.sleepReports.find(item => item.date === currentDay);

  const sleepDateInput = h('input', {
    id: 'sleep-date',
    name: 'date',
    type: 'date',
    required: true,
    value: currentDay
  });
  const sleepHoursInput = h('input', {
    id: 'sleep-hours',
    name: 'hours',
    type: 'number',
    min: '0',
    max: '24',
    step: '0.5',
    required: true,
    value: String(existingSleepToday?.hoursSlept ?? plannedSleepHrs)
  });
  const sleepStressInput = h('input', {
    id: 'sleep-stress',
    name: 'stress',
    type: 'number',
    min: '1',
    max: '5',
    step: '1',
    placeholder: 'Optional (1–5)',
    value: existingSleepToday?.stress !== undefined ? String(existingSleepToday.stress) : ''
  });
  const sleepError = h('p', {
    id: 'sleep-error',
    className: 'form-error-banner',
    role: 'alert',
    hidden: true
  });
  const clearSleepError = () => {
    sleepError.textContent = '';
    sleepError.hidden = true;
  };
  sleepDateInput.addEventListener('input', clearSleepError);
  sleepHoursInput.addEventListener('input', clearSleepError);
  sleepStressInput.addEventListener('input', clearSleepError);

  const sleepPanel = h('section', { className: 'panel sleep-feedback-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, '2 · OPTIONAL MORNING SLEEP & STRESS CHECK-IN'),
        h('h3', {}, 'Sleep & stress report (optional)')
      ),
      h('span', { className: 'pill' }, `Protected opportunity: ${fmtHours(plannedSleepHrs)}/night`)
    ),
    h('p', { className: 'helper' },
      "Completely optional and skippable without consequence. A feasible plan makes room to sleep; it can't guarantee sleep."
    ),
    alreadySkippedToday
      ? h('p', { className: 'field-hint learning-note' },
          `Morning prompt skipped for ${currentDay}. You can still log a night manually below if you wish.`
        )
      : null,
    h('form', {
      id: 'sleep-form',
      className: 'commitment-form',
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        clearSleepError();
        try {
          dispatch({
            type: 'RECORD_SLEEP_REPORT',
            date: sleepDateInput.value,
            hoursSlept: sleepHoursInput.value,
            stress: sleepStressInput.value
          }, { rethrow: true });
        } catch (error) {
          sleepError.textContent = error?.message || 'Unable to save sleep report.';
          sleepError.hidden = false;
        }
      }
    },
      h('div', { className: 'form-grid-three' },
        h('div', { className: 'form-field' },
          h('label', { for: 'sleep-date' }, 'Night ending on *'),
          sleepDateInput
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'sleep-hours' }, 'Hours slept (0.5h steps) *'),
          sleepHoursInput
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'sleep-stress' }, 'Stress (optional, 1 to 5)'),
          sleepStressInput
        )
      ),
      sleepError,
      h('div', { className: 'form-submit-row' },
        h('button', { type: 'submit', className: 'button button-primary' }, 'Save sleep report'),
        h('button', {
          type: 'button',
          className: 'button button-quiet',
          onClick: () => dispatch({ type: 'SKIP_SLEEP_PROMPT', date: sleepDateInput.value })
        }, 'Skip for today')
      )
    )
  );

  // 3. Seven-Day "Did it work?" Review Section
  const review = derived.review ?? sevenDayReview({
    feedback: state.feedback.tasks,
    sleepReports: state.feedback.sleepReports,
    appliedChanges: state.appliedChanges,
    tasks: state.tasks,
    days: state.days,
    throughDate: derived.reviewThroughDate ?? '2026-11-20'
  });

  const profileBadges = review.profiles.map(profile => {
    const label = (TYPE_LABELS[profile.type] ?? TYPE_LABELS.other).label;
    const example4h = getEstimateSuggestion(profile, 4);
    const detail = profile.samples === 0
      ? `${profile.type}: 1× (0 samples)`
      : profile.samples < 3
        ? `${profile.type}: ${Number(profile.ratio.toFixed(3))}× — learning (${profile.samples} of 3)`
        : `${profile.type}: ${Number(profile.ratio.toFixed(3))}× (${profile.samples} samples${example4h ? `, e.g. 4h → ${fmtHours(example4h)}` : ''})`;
    return h('li', { className: 'task-row' },
      h('div', { className: 'task-row-title' },
        h('strong', {}, `${label} (${profile.type})`),
        h('small', {}, detail)
      ),
      h('span', { className: `task-pill ${profile.samples >= 3 ? 'droppable' : ''}` },
        profile.samples >= 3 ? `${Number(profile.ratio.toFixed(2))}× learned` : `Learning (${profile.samples}/3)`
      )
    );
  });

  const estimateItems = review.estimates.length
    ? review.estimates.map(entry => {
        const targetBadge = entry.metTarget === null
          ? 'No target date'
          : entry.metTarget ? '✓ Target met' : '✕ Target missed';
        const hardBadge = entry.metHardDeadline === null
          ? ''
          : entry.metHardDeadline ? '✓ Hard deadline met' : '✕ Hard deadline missed';
        return h('li', { className: 'task-row' },
          h('div', { className: 'task-row-title' },
            h('strong', {}, `${entry.title} (${entry.type})`),
            h('small', {},
              `Estimated ${fmtHours(entry.estimatedLikely)} vs Actual ${fmtHours(entry.actualHours)} · Completed ${entry.date}${
                entry.targetDate ? ` (target ${entry.targetDate}${entry.hardDate && entry.hardDate !== entry.targetDate ? `, hard ${entry.hardDate}` : ''})` : ''
              } · Learned type ratio: ${Number(entry.ratio.toFixed(3))}×`
            )
          ),
          h('div', { className: 'repair-badges' },
            h('span', { className: `verdict-pill ${entry.metTarget ? 'good' : 'risk'}` }, targetBadge),
            hardBadge
              ? h('span', { className: `verdict-pill ${entry.metHardDeadline ? 'good' : 'alert'}` }, hardBadge)
              : null
          )
        );
      })
    : [h('p', { className: 'helper' }, 'No completed tasks recorded in this 7-day window yet.')];

  const adjustmentItems = review.adjustments.length
    ? review.adjustments.map(change =>
        h('li', { className: 'task-row' },
          h('div', { className: 'task-row-title' },
            h('strong', {}, (change.labels ?? []).join(' + ') || 'Schedule adjustment'),
            h('small', {}, `Applied ${fmtTimestamp(change.recordedAt)}`)
          ),
          h('span', { className: `task-pill ${change.approved ? 'flexible' : 'droppable'}` },
            change.approved ? 'Approved' : 'Self-serve'
          )
        )
      )
    : [h('p', { className: 'helper' }, 'No schedule adjustments applied in this 7-day window.')];

  const sleepItems = review.reports.length
    ? review.reports.map(report =>
        h('li', { className: 'task-row' },
          h('div', { className: 'task-row-title' },
            h('strong', {}, `Night ending ${report.date}`),
            h('small', {},
              `Reported ${fmtHours(report.hoursSlept)} vs ${fmtHours(report.plannedHours)} protected sleep opportunity (${fmtSignedHours(report.differenceHours)})${
                report.stress !== undefined ? ` · Stress: ${report.stress}/5` : ''
              }`
            )
          ),
          h('span', { className: 'task-pill droppable' }, `${fmtHours(report.hoursSlept)} slept`)
        )
      )
    : [h('p', { className: 'helper' }, 'No sleep reports logged in this 7-day window (reporting is always optional).')];

  const reviewPanel = h('section', { id: 'review', className: 'panel review-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, '3 · SEVEN-DAY REVIEW'),
        h('h3', {}, `Did it work? (${review.fromDate} to ${review.throughDate})`)
      ),
      h('span', { className: 'pill' }, `${review.plannedDays} planned day(s) in window`)
    ),
    h('div', { className: 'cost-statement-box' },
      h('span', { className: 'field-eyebrow' }, 'SEVEN-DAY SUMMARY'),
      h('p', {}, review.summary)
    ),
    h('div', { className: 'form-grid-two' },
      h('div', { className: 'review-subcard' },
        h('h4', {}, 'Deadlines & estimate vs. actual'),
        h('ul', { className: 'task-list' }, estimateItems)
      ),
      h('div', { className: 'review-subcard' },
        h('h4', {}, 'Adjustments applied'),
        h('ul', { className: 'task-list' }, adjustmentItems)
      )
    ),
    h('div', { className: 'form-grid-two' },
      h('div', { className: 'review-subcard' },
        h('h4', {}, 'Reported sleep vs. planned sleep opportunity'),
        h('ul', { className: 'task-list' }, sleepItems)
      ),
      h('div', { className: 'review-subcard' },
        h('h4', {}, 'Learned estimate profiles by task type'),
        h('ul', { className: 'task-list' }, profileBadges)
      )
    )
  );

  container.replaceChildren(headerBar, taskFeedbackPanel, sleepPanel, reviewPanel);
}
