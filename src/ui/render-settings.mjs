import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { TASK_TYPES } from '../engine/scheduler.mjs';
import { fmtMinutes, h } from './dom.mjs';
import { resetCheckFormDraft } from './render-check.mjs';
import { renderWorkHours } from './hours-editor.mjs';
import { formatWeeklyWindowsText, isSetUp } from './state.mjs';

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
 * Renders Settings: sleep, work hours, preferences, estimates and local data.
 */
export function renderSettingsScreen(container, { state, derived, dispatch }) {
  const firstDate = state.days[0]?.date ?? '';
  const sleepMins = plannedSleepMinutes(state.sleep);
  const needsSetup = !isSetUp(state);

  const settingsError = h('p', { id: 'settings-error', className: 'form-error-banner', role: 'alert', hidden: true });
  const clearError = () => { settingsError.textContent = ''; settingsError.hidden = true; };

  const sleepStartInput = h('input', {
    id: 'settings-sleep-start', name: 'sleepStart', type: 'time', step: '1800', required: true,
    value: state.sleep.start, onInput: clearError
  });
  const sleepEndInput = h('input', {
    id: 'settings-sleep-end', name: 'sleepEnd', type: 'time', step: '1800', required: true,
    value: state.sleep.end, onInput: clearError
  });
  const anchorInput = h('input', {
    id: 'settings-anchor', name: 'anchor', type: 'date', required: true,
    value: state.settings?.anchor ?? firstDate, onInput: clearError
  });
  const initialText = formatWeeklyWindowsText(state.settings?.weeklyWorkWindows);
  const windowsTextarea = h('textarea', {
    id: 'settings-windows', name: 'windows', rows: '5', onInput: clearError
  }, initialText);
  const hours = renderWorkHours({
    initialRows: state.settings?.weeklyWorkWindows ?? [[], [], [], [], [], [], []],
    onChange: clearError
  });

  const settingsForm = h('form', {
    id: 'settings-form',
    novalidate: true,
    onSubmit: ev => {
      ev.preventDefault();
      clearError();
      const usedText = windowsTextarea.value !== initialText;
      try {
        dispatch({
          type: 'SAVE_SETTINGS',
          sleepStart: sleepStartInput.value,
          sleepEnd: sleepEndInput.value,
          anchor: anchorInput.value,
          ...(usedText ? { windowsText: windowsTextarea.value } : { weeklyWorkWindows: hours.getRows() })
        }, { rethrow: true });
      } catch (error) {
        settingsError.textContent = error?.message || 'Unable to save settings.';
        settingsError.hidden = false;
      }
    }
  },
    h('section', { className: 'settings-group', 'aria-labelledby': 'g-sleep' },
      h('h2', { id: 'g-sleep' }, 'Sleep'),
      h('p', { className: 'section-help' },
        `Protected sleep (${fmtMinutes(sleepMins)} a night) comes off your free time before any work is planned. A feasible plan makes room to sleep; it can't guarantee sleep.`),
      h('div', { className: 'form-grid-two' },
        h('div', { className: 'form-field' }, h('label', { for: 'settings-sleep-start' }, 'Sleep starts'), sleepStartInput),
        h('div', { className: 'form-field' }, h('label', { for: 'settings-sleep-end' }, 'Sleep ends'), sleepEndInput)
      )
    ),
    h('section', { className: 'settings-group', 'aria-labelledby': 'g-hours' },
      h('h2', { id: 'g-hours' }, 'When can you work?'),
      h('p', { className: 'section-help' },
        'Add the hours you could do deadline work each week. Busy blocks like classes come off these hours.'),
      hours.node,
      h('details', { className: 'quiet-details', id: 'hours-text' },
        h('summary', {}, 'Edit as text instead'),
        h('p', { className: 'section-help' }, 'One window per line, such as Mon 16:00-20:00. If you change this box, it is used instead of the fields above.'),
        h('label', { for: 'settings-windows' }, 'Work windows as text'),
        windowsTextarea
      ),
      h('details', { className: 'quiet-details', id: 'weeks-shown' },
        h('summary', {}, 'Which weeks are shown'),
        h('div', { className: 'form-field' },
          h('label', { for: 'settings-anchor' }, 'Start from the week of'),
          anchorInput,
          h('small', { className: 'field-hint' }, 'Five weeks are loaded, starting on the Monday of this week.')
        )
      )
    ),
    settingsError,
    h('button', { type: 'submit', className: 'button button-primary' }, needsSetup ? 'Save and set up my week' : 'Save settings')
  );

  const nameInput = h('input', {
    id: 'settings-name', name: 'name', type: 'text', maxlength: '40', autocomplete: 'given-name',
    value: state.displayName ?? ''
  });
  const preferences = h('section', { className: 'settings-group', 'aria-labelledby': 'g-pref' },
    h('h2', { id: 'g-pref' }, 'Preferences'),
    h('form', {
      id: 'name-form',
      onSubmit: ev => { ev.preventDefault(); dispatch({ type: 'SET_NAME', name: nameInput.value }); }
    },
      h('div', { className: 'form-field' },
        h('label', { for: 'settings-name' }, 'What should I call you? (optional)'),
        nameInput,
        h('small', { className: 'field-hint' }, 'Only used for the greeting on Home. It stays in this browser.')
      ),
      h('button', { type: 'submit', className: 'button button-secondary' }, 'Save name')
    ),
    h('p', { className: 'section-help' },
      'Importing a calendar or a list of deadlines lives in My week, next to the things it changes. ',
      h('button', {
        type: 'button', id: 'settings-to-week', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, 'Go to My week'))
  );

  const profileRows = (derived.estimateProfiles ?? []).map(profile => {
    const label = TYPE_NAMES[profile.type] ?? profile.type;
    const statusText = profile.samples === 0
      ? 'Default 1.0× (0 of 3 finished tasks)'
      : profile.samples < 3
        ? `Learning (${profile.samples} of 3 finished tasks · current ${Number(profile.ratio.toFixed(3))}×)`
        : `Active (${Number(profile.ratio.toFixed(3))}× from ${profile.samples} finished tasks)`;
    return h('div', { className: 'estimate-row' },
      h('strong', {}, label),
      h('span', {}, `${Number(profile.ratio.toFixed(3))}×`),
      h('span', { className: profile.samples >= 3 ? 'ok' : '' }, statusText));
  });
  const estimates = h('details', { className: 'quiet-details', id: 'estimate-profiles' },
    h('summary', {}, 'How your estimates are learned'),
    h('p', { className: 'section-help' },
      'After 3 finished tasks of a type, Run the numbers can suggest an adjusted estimate next to yours. It never changes your number silently.'),
    h('div', { className: 'estimate-table' },
      profileRows.length
        ? profileRows
        : TASK_TYPES.map(t => h('div', { className: 'estimate-row' }, h('strong', {}, TYPE_NAMES[t] ?? t), h('span', {}, '1×'), h('span', {}, 'Default (0 of 3 finished tasks)')))
    )
  );

  const csvPreviewBox = h('pre', { id: 'csv-export-preview', className: 'draft-box', hidden: true });
  const data = h('section', { className: 'settings-group', 'aria-labelledby': 'g-data' },
    h('h2', { id: 'g-data' }, 'Your data'),
    h('p', { className: 'section-help' }, 'Everything is stored in this browser under the25thhour.v1. Nothing is uploaded.'),
    csvPreviewBox,
    h('button', {
      type: 'button', className: 'link-button',
      onClick: () => {
        const csv = buildFeedbackCsv(state);
        csvPreviewBox.textContent = csv;
        csvPreviewBox.hidden = false;
        try {
          const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'the-25th-hour-feedback.csv';
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
        } catch {
          // The preview stays visible for manual copy.
        }
        dispatch({ type: 'SET_NOTICE', notice: 'Feedback CSV prepared for local export.' });
      }
    }, 'Export feedback as CSV')
  );

  const danger = h('section', { className: 'settings-group danger-zone', 'aria-labelledby': 'g-danger' },
    h('h2', { id: 'g-danger' }, 'Delete everything'),
    h('p', { className: 'section-help' },
      'Removes your plan, settings, approvals and feedback from this browser. This cannot be undone.'),
    h('button', {
      id: 'clear', type: 'button', className: 'button button-danger-outline',
      onClick: () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('Clear the saved plan, settings, approvals and feedback?')) return;
        }
        resetCheckFormDraft();
        dispatch({ type: 'CLEAR_ALL' });
      }
    }, 'Clear all my data')
  );

  container.replaceChildren(
    h('header', { className: 'screen-intro' },
      h('h1', { className: 'screen-title' }, needsSetup ? 'Set up my week' : 'Settings'),
      h('p', { className: 'screen-lede' },
        needsSetup
          ? 'When you sleep and when you can work. Busy time and deadlines are added in My week.'
          : 'Sleep, work hours and preferences.'),
      h('button', {
        type: 'button', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
      }, 'Back to My week')
    ),
    settingsForm,
    preferences,
    estimates,
    data,
    danger
  );
}
