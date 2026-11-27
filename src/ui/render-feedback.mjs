import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { campusDate, getEstimateSuggestion, sevenDayReview } from '../engine/feedback.mjs';
import { TASK_TYPES } from '../engine/scheduler.mjs';
import {
  fmtHours,
  fmtMinutes,
  fmtSignedHours,
  fmtTimestamp,
  h,
  setBlobTone,
  svg
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

// Which task was just logged on this screen (UI-only), so the card can say how it went.
let justLogged = null;

const hoursShort = value => `${Math.round(value * 10) / 10}h`;

/**
 * One insight, only when the estimate-learning data has at least three finished tasks of a type.
 * Every number comes from the logged entries and the existing suggestion function.
 */
export function buildInsight(state, profiles) {
  const ready = profiles.filter(profile => profile.samples >= 3);
  if (!ready.length) return null;
  const best = [...ready].sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1))[0];
  const entries = state.feedback.tasks.filter(entry => entry.type === best.type).slice(-best.samples);
  if (entries.length < 3) return null;
  const labels = TYPE_LABELS[best.type] ?? TYPE_LABELS.other;
  const avgEst = entries.reduce((sum, entry) => sum + entry.estimatedLikely, 0) / entries.length;
  const avgAct = entries.reduce((sum, entry) => sum + entry.actualHours, 0) / entries.length;
  const minutes = Math.round(Math.abs(avgAct - avgEst) * 60);
  const guess = Math.round(avgEst * 2) / 2;
  const suggestion = getEstimateSuggestion(best, guess);
  const direction = avgAct >= avgEst ? 'long' : 'short';
  return {
    type: best.type,
    title: minutes === 0
      ? `Your ${labels.plural} come out right on your guess.`
      : `Your ${labels.plural} run about ${minutes} minutes ${direction}.`,
    sub: `You guess ${hoursShort(avgEst)}, and the last ${entries.length} took ${hoursShort(avgAct)} on average.${suggestion !== null && suggestion !== guess ? ` I'll offer "Use ${hoursShort(suggestion)}?" when you check a ${labels.label.toLowerCase()}. Your call every time.` : ''}`
  };
}

/** The ledger: guessed versus took, newest first. */
export function buildLedger(state, limit = 8) {
  const entries = [...state.feedback.tasks].reverse().slice(0, limit);
  const max = Math.max(1, ...entries.map(entry => Math.max(entry.estimatedLikely, entry.actualHours)));
  return entries.map(entry => {
    const delta = Math.round((entry.actualHours - entry.estimatedLikely) * 10) / 10;
    return {
      title: entry.title ?? entry.taskId,
      est: entry.estimatedLikely,
      act: entry.actualHours,
      delta: delta > 0 ? `${delta}h over` : delta < 0 ? `${Math.abs(delta)}h under` : 'On the nose',
      tone: delta > 0 ? 'over' : 'ok',
      estPct: Math.round((entry.estimatedLikely / max) * 1000) / 10,
      actPct: Math.round((entry.actualHours / max) * 1000) / 10
    };
  });
}

/**
 * Renders Screen: Review (F3 Reality Feedback & 7-Day Review).
 */
export function renderFeedbackScreen(container, { state, derived, dispatch }) {
  const profiles = derived.estimateProfiles ?? [];
  const currentDay = campusDate(new Date().toISOString()) ?? state.days[0]?.date ?? '2026-11-19';
  const eligibleTasks = findEligibleTasksForFeedback(state, currentDay);
  const completedIds = new Set(state.feedback.tasks.map(entry => entry.taskId));
  const selectableTasks = state.tasks.filter(task => !task.removed);
  const openTasks = selectableTasks.filter(task => !completedIds.has(task.id));
  const defaultTask = eligibleTasks[0] ?? openTasks[0] ?? selectableTasks[0] ?? null;

  setBlobTone('tan');
  const headerBar = h('div', { className: 'review-head' },
    h('button', {
      type: 'button', id: 'review-back', className: 'back-link',
      onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
    },
      svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
        svg('path', { d: 'M11 3L5 9l6 6', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
      'My week'),
    h('div', { className: 'eyebrow' }, 'PAST ESTIMATES'),
    h('h1', { className: 'screen-title review-title' }, 'What my yeses cost.')
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

  const actualHoursInput = h('input', { id: 'feedback-actual-hours', name: 'actualHours', type: 'hidden' });
  const hoursOut = h('span', { id: 'log-hours-out', className: 'step-value', 'aria-live': 'polite' }, '—');
  const guessLine = h('p', { id: 'log-guess', className: 'log-guess' }, '');
  const logTitle = h('h2', { id: 'log-title', className: 'card-title' }, 'How long did it take?');
  const syncHoursOut = () => { hoursOut.textContent = actualHoursInput.value === '' ? '—' : fmtHours(Number(actualHoursInput.value)); };
  const bumpHours = delta => {
    const current = Number(actualHoursInput.value);
    const next = Math.min(60, Math.max(0, Math.round(((Number.isFinite(current) ? current : 0) + delta) * 2) / 2));
    actualHoursInput.value = String(next);
    syncHoursOut();
  };
  actualHoursInput.addEventListener('input', syncHoursOut);

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
      syncHoursOut();
      recordedAtInput.value = '';
      asPlannedBtn.textContent = 'As planned';
      asPlannedBtn.disabled = true;
      logTitle.textContent = 'Nothing to log yet.';
      guessLine.textContent = '';
      return;
    }
    const previous = state.feedback.tasks.find(item => item.taskId === task.id);
    const estHours = previous?.estimatedLikely ?? task.likely;
    const resolvedType = previous?.type ?? task.type ?? 'other';
    typeSelect.value = TASK_TYPES.includes(resolvedType) ? resolvedType : 'other';
    actualHoursInput.value = String(previous?.actualHours ?? estHours);
    syncHoursOut();
    logTitle.textContent = `How long did ${task.title} take?`;
    guessLine.textContent = `You guessed ${fmtHours(estHours)}.`;
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
      justLogged = taskSelect.value;
      dispatch({
        type: 'RECORD_FEEDBACK',
        taskId: taskSelect.value,
        taskType: typeSelect.value,
        actualHours: actualHoursInput.value,
        recordedAt: recordedAtInput.value,
        asPlanned
      }, { rethrow: true });
    } catch (error) {
      justLogged = null;
      feedbackError.textContent = error?.message || 'Unable to save task feedback.';
      feedbackError.hidden = false;
    }
  }

  asPlannedBtn.addEventListener('click', () => submitTaskCompletion(true));

  const openSuggestions = findOpenTasksWithLearnedSuggestions(state, profiles);

  const logged = justLogged ? state.feedback.tasks.find(entry => entry.taskId === justLogged) : null;
  const diff = logged ? Math.round((logged.actualHours - logged.estimatedLikely) * 10) / 10 : 0;
  const loggedCard = logged
    ? h('section', { id: 'logged-card', className: 'card log-card' },
        h('div', { className: 'eyebrow log-eyebrow' }, 'LOGGED'),
        h('h2', { className: 'card-title' },
          diff > 0 ? `About ${fmtHours(diff)} longer than you guessed.` : diff < 0 ? 'Quicker than you guessed. Nice.' : 'Right on your guess.'),
        h('p', { className: 'step-text' }, 'Saved on this device. Next time I suggest an estimate for something like it, this counts.'),
        h('button', {
          type: 'button', id: 'log-change', className: 'link-button',
          onClick: () => { justLogged = null; dispatch({ type: 'SET_NOTICE', notice: '' }); }
        }, 'Change it'))
    : null;

  const taskFeedbackPanel = h('div', { className: 'log-block' },
    loggedCard,
    h('form', {
      id: 'completion-form',
      className: 'card log-card',
      hidden: Boolean(logged),
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        submitTaskCompletion(false);
      }
    },
      h('div', { className: 'eyebrow log-eyebrow' }, eligibleTasks.length ? 'JUST FINISHED?' : 'LOG A FINISHED TASK'),
      logTitle,
      guessLine,
      h('div', { className: 'stepper', role: 'group', 'aria-label': 'Hours it took' },
        h('button', { type: 'button', id: 'log-less', className: 'step-btn', 'aria-label': 'Less time', onClick: () => bumpHours(-0.5) }, '−'),
        hoursOut,
        h('button', { type: 'button', id: 'log-more', className: 'step-btn', 'aria-label': 'More time', onClick: () => bumpHours(0.5) }, '+')),
      actualHoursInput,
      feedbackError,
      h('button', {
        type: 'submit', id: 'log-it', className: 'button button-primary',
        disabled: selectableTasks.length === 0
      }, 'Log it'),
      asPlannedBtn,
      h('details', { className: 'quiet-details', id: 'log-other' },
        h('summary', {}, 'Log a different task'),
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-task-id' }, 'Which task?'),
          taskSelect),
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-task-type' }, 'What kind of task is it?'),
          typeSelect,
          h('small', { className: 'field-hint' }, 'Helps the app learn how long your tasks really take.')),
        h('div', { className: 'form-field' },
          h('label', { for: 'feedback-recorded-at' }, 'When did you finish?'),
          recordedAtInput,
          h('small', { className: 'field-hint' }, 'Used to check whether target and hard deadlines were met.'))
      ),
      promptBanner
    ),
    openSuggestions.length
      ? h('div', { className: 'open-suggestions-stack' },
          openSuggestions.map(({ task, profile, suggestedHours }) => {
            const labels = TYPE_LABELS[profile.type] ?? TYPE_LABELS.other;
            return h('div', { className: 'learned-line', role: 'status' },
              h('span', {},
                `For "${task.title}": You said ${fmtHours(task.likely)}. Your last ${profile.samples} ${labels.plural} took ${Number(profile.ratio.toFixed(1))}× (${Number(profile.ratio.toFixed(3))}×) your estimate. Use ${fmtHours(suggestedHours)}?`
              ),
              h('button', {
                type: 'button',
                className: 'learned-btn',
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
        h('h3', {}, 'Sleep and stress report')
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
      ? `${profile.type}: 1× (no finished tasks yet)`
      : profile.samples < 3
        ? `${profile.type}: ${Number(profile.ratio.toFixed(3))}× — learning (${profile.samples} of 3)`
        : `${profile.type}: ${Number(profile.ratio.toFixed(3))}× (${profile.samples} finished tasks${example4h ? `, so a 4h estimate becomes ${fmtHours(example4h)}` : ''})`;
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
        h('h3', {}, `Seven-day report (${review.fromDate} to ${review.throughDate})`)
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

  const insight = buildInsight(state, profiles);
  const insightCard = insight
    ? h('section', { id: 'insight-card', className: 'insight-card' },
        h('div', { className: 'eyebrow insight-eyebrow' }, "WHAT I'VE NOTICED"),
        h('p', { className: 'insight-title' }, insight.title),
        h('p', { className: 'insight-sub' }, insight.sub))
    : null;
  const ledger = buildLedger(state);
  const ledgerCard = ledger.length
    ? h('section', { id: 'ledger', className: 'ledger' },
        h('h2', { className: 'section-title' }, 'The ledger'),
        ledger.map(row =>
          h('div', { className: 'ledger-row' },
            h('div', { className: 'ledger-head' },
              h('span', { className: 'ledger-title' }, row.title),
              h('span', { className: `ledger-delta ${row.tone}` }, row.delta)),
            h('div', { className: 'ledger-bars', role: 'img', 'aria-label': `${row.title}: guessed ${fmtHours(row.est)}, took ${fmtHours(row.act)}.` },
              h('div', { className: 'ledger-bar-row' },
                h('span', { className: 'ledger-bar-label' }, 'Guessed'),
                h('div', { className: 'ledger-bar est', style: `width:${row.estPct}%` }),
                h('span', { className: 'ledger-bar-value' }, fmtHours(row.est))),
              h('div', { className: 'ledger-bar-row' },
                h('span', { className: 'ledger-bar-label' }, 'Took'),
                h('div', { className: `ledger-bar act ${row.tone}`, style: `width:${row.actPct}%` }),
                h('span', { className: 'ledger-bar-value strong' }, fmtHours(row.act)))))))
    : null;

  const sleepDetails = h('details', { className: 'quiet-details', id: 'sleep-details' },
    h('summary', {}, 'Sleep and stress (optional)'),
    h('p', { className: 'section-help' }, 'Only if you want it. Logging how you slept next to what you said yes to is the clearest way to see what a week really cost.'),
    sleepPanel
  );
  const historyDetails = h('details', { className: 'quiet-details', id: 'history-details' },
    h('summary', {}, `Seven-day report (${state.feedback.tasks.length} logged)`),
    reviewPanel
  );

  container.replaceChildren(...[headerBar, taskFeedbackPanel, insightCard, ledgerCard, sleepDetails, historyDetails].filter(Boolean));
}
