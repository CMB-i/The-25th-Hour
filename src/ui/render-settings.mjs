import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { TASK_TYPES } from '../engine/scheduler.mjs';
import {
  fmtHours,
  fmtMinutes,
  fmtShortDate,
  fmtShortWeekday,
  fmtTimestamp,
  h,
  taskTag,
  taskTagLabel
} from './dom.mjs';
import { resetCheckFormDraft } from './render-check.mjs';
import { formatWeeklyWindowsText, MAX_ICS_BYTES } from './state.mjs';

const TYPE_NAMES = {
  problem_set: 'Problem set',
  lab: 'Lab',
  report: 'Report',
  reading: 'Reading',
  project: 'Project',
  club: 'Club',
  other: 'Other'
};

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Generates an RFC-4180 CSV export of task completion feedback and voluntary sleep reports.
 */
export function buildFeedbackCsv(state) {
  const rows = [
    ['record_type', 'id_or_date', 'title_or_night', 'task_type', 'estimated_or_planned_hours', 'actual_or_slept_hours', 'stress', 'target_date', 'hard_date', 'recorded_at']
  ];
  for (const item of state.feedback.tasks) {
    rows.push([
      'task_feedback',
      item.taskId,
      item.title ?? item.taskId,
      item.type ?? 'other',
      item.estimatedLikely,
      item.actualHours,
      '',
      item.targetDate ?? '',
      item.hardDate ?? '',
      item.recordedAt ?? ''
    ]);
  }
  for (const report of state.feedback.sleepReports) {
    rows.push([
      'sleep_report',
      report.date,
      report.date,
      '',
      (report.plannedSleepMinutes ?? 480) / 60,
      report.hoursSlept,
      report.stress ?? '',
      '',
      '',
      report.date
    ]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}

/**
 * Summarizes imported busy windows across loaded days.
 */
export function countBusyWindows(days = []) {
  let totalWindows = 0;
  const activeDays = [];
  for (const day of days) {
    const count = day?.busyWindows?.length ?? 0;
    if (count > 0) {
      totalWindows += count;
      activeDays.push({ date: day.date, windows: day.busyWindows });
    }
  }
  return { totalWindows, daysWithEvents: activeDays.length, activeDays };
}

/**
 * Renders Screen 5: Settings, First-Run Setup, Imports (.ics & Pasted Tasks), and Clear All Data.
 */
export function renderSettingsScreen(container, { state, derived, dispatch }) {
  const firstDate = state.days[0]?.date ?? '';
  const lastDate = state.days[state.days.length - 1]?.date ?? '';
  const sleepMins = plannedSleepMinutes(state.sleep);
  const busySummary = countBusyWindows(state.days);

  const headerBar = h('section', { className: 'panel settings-header' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('div', { className: 'panel-label' },
          h('span', { className: 'panel-index' }, '05'),
          'IMPORTS & SETTINGS · LOCAL DATA'
        ),
        h('h2', {}, 'Availability, calendar imports & privacy'),
        h('p', { className: 'helper' },
          'This is a planning tool, not medical advice, and not a treatment for sleep or anxiety problems.'
        )
      ),
      h('span', { className: 'pill' }, `Protected sleep: ${state.sleep.start}–${state.sleep.end} (${fmtMinutes(sleepMins)})`)
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
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      }, 'Should I Say Yes?'),
      h('button', {
        type: 'button',
        className: 'button button-outline',
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
      }, 'Load Flexible demo (Scenario A)'),
      h('button', {
        type: 'button',
        className: 'button button-outline',
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: true })
      }, 'Load Fixed demo (Scenario B)')
    )
  );

  // 1. Sleep Window & Weekly Work Windows Form
  const sleepStartInput = h('input', {
    id: 'settings-sleep-start',
    name: 'sleepStart',
    type: 'time',
    step: '1800',
    required: true,
    value: state.sleep.start
  });
  const sleepEndInput = h('input', {
    id: 'settings-sleep-end',
    name: 'sleepEnd',
    type: 'time',
    step: '1800',
    required: true,
    value: state.sleep.end
  });
  const anchorInput = h('input', {
    id: 'settings-anchor',
    name: 'anchor',
    type: 'date',
    required: true,
    value: state.settings?.anchor ?? firstDate
  });
  const windowsTextarea = h('textarea', {
    id: 'settings-windows',
    name: 'windows',
    rows: '6',
    required: true
  }, formatWeeklyWindowsText(state.settings?.weeklyWorkWindows));

  const settingsError = h('p', {
    id: 'settings-error',
    className: 'form-error-banner',
    role: 'alert',
    hidden: true
  });

  const clearSettingsError = () => {
    settingsError.textContent = '';
    settingsError.hidden = true;
  };
  sleepStartInput.addEventListener('input', clearSettingsError);
  sleepEndInput.addEventListener('input', clearSettingsError);
  anchorInput.addEventListener('input', clearSettingsError);
  windowsTextarea.addEventListener('input', clearSettingsError);

  const settingsPanel = h('section', { className: 'panel settings-form-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'STEP 1 · SLEEP & WEEKLY WORK WINDOWS'),
        h('h3', {}, 'Protected sleep time & weekly work availability')
      ),
      h('span', { className: 'pill' }, `5 loaded weeks: ${firstDate} to ${lastDate}`)
    ),
    h('p', { className: 'helper' },
      "Your protected sleep window is removed from capacity before any task is scheduled. A feasible plan makes room to sleep; it can't guarantee sleep."
    ),
    h('form', {
      id: 'settings-form',
      className: 'commitment-form',
      novalidate: true,
      onSubmit: ev => {
        ev.preventDefault();
        clearSettingsError();
        try {
          dispatch({
            type: 'SAVE_SETTINGS',
            sleepStart: sleepStartInput.value,
            sleepEnd: sleepEndInput.value,
            anchor: anchorInput.value,
            windowsText: windowsTextarea.value
          }, { rethrow: true });
        } catch (error) {
          settingsError.textContent = error?.message || 'Unable to save settings.';
          settingsError.hidden = false;
        }
      }
    },
      h('div', { className: 'form-grid-three' },
        h('div', { className: 'form-field' },
          h('label', { for: 'settings-sleep-start' }, 'Protected sleep starts *'),
          sleepStartInput,
          h('small', { className: 'field-hint' }, '24h time in 30-min increments (default 23:00).')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'settings-sleep-end' }, 'Protected sleep ends *'),
          sleepEndInput,
          h('small', { className: 'field-hint' }, '24h time in 30-min increments (default 07:00).')
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'settings-anchor' }, 'Anchor date for 5 loaded weeks *'),
          anchorInput,
          h('small', { className: 'field-hint' }, 'Loads 35 days starting on the Monday of this week.')
        )
      ),
      h('div', { className: 'form-field' },
        h('label', { for: 'settings-windows' }, 'Weekly available work windows (one per line, e.g. Mon 16:00-20:00)'),
        windowsTextarea,
        h('small', { className: 'field-hint' },
          'Use Mon, Tue, Wed, Thu, Fri, Sat, Sun with same-day half-hour aligned windows (e.g. Mon 16:00-20:00).'
        )
      ),
      settingsError,
      h('div', { className: 'form-submit-row' },
        h('button', { type: 'submit', className: 'button button-primary' }, 'Save settings')
      )
    )
  );

  // 2. Imports Panel (.ics Calendar & Pasted Tasks)
  const importStatusBox = h('div', {
    id: 'import-message',
    className: 'import-status-box',
    role: 'status',
    'aria-live': 'polite'
  });

  function renderImportReport(report, errorText = '') {
    if (errorText) {
      importStatusBox.replaceChildren(
        h('div', { className: 'form-error-banner', role: 'alert' }, errorText)
      );
      return;
    }
    if (!report) {
      importStatusBox.replaceChildren(
        h('p', { className: 'helper' }, 'No imports run in this session yet.')
      );
      return;
    }
    importStatusBox.replaceChildren(
      h('div', { className: `check-repair-box ${report.skipped > 0 ? 'risk' : 'good'}` },
        h('strong', {}, report.kind === 'ics' ? 'Calendar (.ics) import result' : 'Pasted tasks import result'),
        h('p', {}, report.summary),
        report.warnings?.length
          ? h('ul', { className: 'import-warnings-list' },
              report.warnings.map(warning => h('li', {}, warning))
            )
          : null
      )
    );
  }

  renderImportReport(state.lastImportReport);

  const calendarFileInput = h('input', {
    id: 'calendar-file',
    name: 'calendarFile',
    type: 'file',
    accept: '.ics,text/calendar',
    onChange: async ev => {
      const file = ev.currentTarget.files?.[0];
      if (!file) return;
      try {
        if (file.size > MAX_ICS_BYTES) {
          throw Error('Calendar file exceeds the 1 MB size limit.');
        }
        const text = await file.text();
        dispatch({
          type: 'IMPORT_ICS',
          text,
          fileSize: file.size,
          fileName: file.name
        }, { rethrow: true });
      } catch (error) {
        renderImportReport(null, error?.message || 'Could not import calendar file.');
      }
    }
  });

  const pasteTextarea = h('textarea', {
    id: 'paste-tasks-input',
    name: 'tasks',
    rows: '4',
    required: true,
    placeholder: 'Quiz revision | 2h | 2026-11-19 | must-keep\nClub report | 3h | 2026-11-18 | flexible | 2026-11-19'
  });

  const importsPanel = h('section', { className: 'panel imports-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'STEP 2 · LOCAL IMPORTS'),
        h('h3', {}, 'Import calendar (.ics) or paste deadline list')
      ),
      h('span', { className: 'pill' }, '100% local · never uploaded')
    ),
    h('div', { className: 'form-grid-two' },
      h('div', { className: 'import-card' },
        h('h4', {}, 'Calendar file (.ics)'),
        h('p', { className: 'helper' },
          'Files are read locally in your browser with File.text(); nothing is uploaded. Up to 1 MB / 2,000 events. Supports Asia/Kolkata, UTC (Z), floating times, and weekly RRULE recurrence.'
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'calendar-file' }, 'Choose .ics calendar file (up to 1 MB)'),
          calendarFileInput
        ),
        h('p', { className: 'field-hint' },
          state.calendarImportedAt
            ? `Last imported: ${fmtTimestamp(state.calendarImportedAt)} (${busySummary.totalWindows} busy window(s) across ${busySummary.daysWithEvents} day(s)).`
            : 'No calendar imported yet.'
        )
      ),
      h('form', {
        id: 'paste-form',
        className: 'import-card',
        novalidate: true,
        onSubmit: ev => {
          ev.preventDefault();
          try {
            dispatch({
              type: 'IMPORT_PASTED_TASKS',
              text: pasteTextarea.value
            }, { rethrow: true });
          } catch (error) {
            renderImportReport(null, error?.message || 'Could not import pasted tasks.');
          }
        }
      },
        h('h4', {}, 'Paste tasks & deadlines'),
        h('p', { className: 'helper' },
          'One task per line: Title | 3h | YYYY-MM-DD | must-keep|flexible|droppable | [optional latest date YYYY-MM-DD]'
        ),
        h('div', { className: 'form-field' },
          h('label', { for: 'paste-tasks-input' }, 'Task lines to import'),
          pasteTextarea
        ),
        h('div', { className: 'form-submit-row' },
          h('button', { type: 'submit', className: 'button button-secondary' }, 'Import tasks')
        )
      )
    ),
    importStatusBox,
    state.tasks.length
      ? h('div', { className: 'imported-tasks-preview' },
          h('span', { className: 'field-eyebrow' }, `CURRENT PLAN TASKS (${state.tasks.length})`),
          h('ul', { className: 'task-list' },
            state.tasks.map(task => {
              const tag = taskTag(task);
              const targetDate = state.days[task.targetDay]?.date ?? '';
              return h('li', { className: `task-row${task.removed ? ' is-removed' : ''}` },
                h('div', { className: 'task-row-title' },
                  h('strong', {}, task.title),
                  h('small', {}, `${fmtHours(task.likely)} (${fmtHours(task.min)}–${fmtHours(task.max)}) · Due ${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)} (${targetDate})`)
                ),
                h('span', { className: `task-pill ${tag}` }, taskTagLabel(tag))
              );
            })
          )
        )
      : null
  );

  // 3. Learned Estimate Profiles & Clear All Data
  const profileRows = (derived.estimateProfiles ?? []).map(profile => {
    const label = TYPE_NAMES[profile.type] ?? profile.type;
    const statusText = profile.samples === 0
      ? 'Default 1.0× (0 of 3 samples)'
      : profile.samples < 3
        ? `Learning (${profile.samples} of 3 samples · current ${Number(profile.ratio.toFixed(3))}×)`
        : `Active (${Number(profile.ratio.toFixed(3))}× from ${profile.samples} samples)`;
    return h('div', { className: 'estimate-row' },
      h('strong', {}, `${label} (${profile.type})`),
      h('span', {}, `${Number(profile.ratio.toFixed(3))}×`),
      h('span', { className: profile.samples >= 3 ? 'ok' : '' }, statusText)
    );
  });

  const csvPreviewBox = h('pre', {
    id: 'csv-export-preview',
    className: 'draft-box',
    hidden: true
  });

  const dataPanel = h('section', { className: 'panel data-panel' },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, 'STEP 3 · ESTIMATE TEMPLATES & PRIVACY'),
        h('h3', {}, 'Learned estimate multipliers & local storage')
      ),
      h('span', { className: 'pill' }, `Storage key: the25thhour.v1`)
    ),
    h('p', { className: 'helper' },
      'After 3 completed tasks of a type, Should I Say Yes? displays an optional adjusted estimate alongside your entered hours. Your entered estimate is never changed silently.'
    ),
    h('div', { className: 'estimate-table' },
      h('div', { className: 'estimate-row header' },
        h('span', {}, 'TASK TYPE'),
        h('span', {}, 'RATIO'),
        h('span', {}, 'STATUS')
      ),
      profileRows.length
        ? profileRows
        : TASK_TYPES.map(t =>
            h('div', { className: 'estimate-row' },
              h('strong', {}, `${TYPE_NAMES[t] ?? t} (${t})`),
              h('span', {}, '1×'),
              h('span', {}, 'Default (0 of 3 samples)')
            )
          )
    ),
    csvPreviewBox,
    h('div', { className: 'quick-actions' },
      h('button', {
        type: 'button',
        className: 'button button-outline',
        onClick: () => {
          const csv = buildFeedbackCsv(state);
          csvPreviewBox.textContent = csv;
          csvPreviewBox.hidden = false;
          try {
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'the-25th-hour-feedback.csv';
            document.body.append(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
          } catch {
            // Preview box remains visible for manual copy.
          }
          dispatch({ type: 'SET_NOTICE', notice: 'Feedback CSV prepared for local export.' });
        }
      }, 'Export feedback CSV'),
      h('button', {
        id: 'clear',
        type: 'button',
        className: 'button button-danger-outline',
        onClick: () => {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm('Clear the saved plan, settings, approvals and feedback?')) return;
          }
          resetCheckFormDraft();
          dispatch({ type: 'CLEAR_ALL' });
        }
      }, 'Clear all my data')
    )
  );

  container.replaceChildren(headerBar, settingsPanel, importsPanel, dataPanel);
}
