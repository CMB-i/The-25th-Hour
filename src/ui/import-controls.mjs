import { fmtTimestamp, h } from './dom.mjs';
import { MAX_ICS_BYTES } from './state.mjs';

/** One visible message box for calendar and pasted-deadline imports. */
export function createImportMessage(state) {
  const box = h('div', { id: 'import-message', className: 'import-message', role: 'status', 'aria-live': 'polite' });
  function show(report, errorText = '') {
    if (errorText) {
      box.replaceChildren(h('p', { className: 'form-error-banner', role: 'alert' }, errorText));
    } else if (report) {
      // The summary already ends with any warnings, so the list is only for pasted deadlines. Never pass
      // null to replaceChildren: the DOM turns it into the text "null".
      const children = [
        h('p', { className: 'import-summary' }, h('strong', {}, report.kind === 'ics' ? 'Calendar import: ' : 'Deadline import: '), report.summary)
      ];
      if (report.warnings?.length && report.kind !== 'ics') {
        children.push(h('ul', { className: 'import-warnings-list' }, report.warnings.map(warning => h('li', {}, warning))));
      }
      box.replaceChildren(...children);
    } else {
      box.replaceChildren();
    }
  }
  show(state.lastImportReport);
  return { box, show };
}

/** The hidden file input behind "Import timetable". Reads locally; nothing is uploaded. */
export function makeCalendarInput({ dispatch, message, id = 'calendar-file', className = '' }) {
  return h('input', {
    id,
    name: 'calendarFile',
    type: 'file',
    accept: '.ics,text/calendar',
    className,
    onChange: async ev => {
      const file = ev.currentTarget.files?.[0];
      if (!file) return;
      try {
        if (file.size > MAX_ICS_BYTES) throw Error('Calendar file exceeds the 1 MB size limit.');
        const text = await file.text();
        dispatch({ type: 'IMPORT_ICS', text, fileSize: file.size, fileName: file.name }, { rethrow: true });
      } catch (error) {
        message.show(null, error?.message || 'Could not import that calendar file.');
      }
    }
  });
}

export function renderCalendarImport({ state, dispatch, message }) {
  return h('div', { className: 'form-field' },
    h('label', { for: 'calendar-file' }, state.calendarImportedAt ? 'Import a newer calendar (.ics)' : 'Import a calendar (.ics)'),
    makeCalendarInput({ dispatch, message }),
    h('small', { className: 'field-hint' }, 'Read in this browser only, up to 1 MB. Nothing is uploaded.')
  );
}

export function renderPasteImport({ dispatch, message }) {
  const textarea = h('textarea', {
    id: 'paste-tasks-input',
    name: 'tasks',
    rows: '4',
    required: true,
    placeholder: 'Quiz revision | 2h | 2026-11-19 | must-keep\nClub report | 3h | 2026-11-18 | flexible | 2026-11-19'
  });
  return h('form', {
    id: 'paste-form',
    novalidate: true,
    onSubmit: ev => {
      ev.preventDefault();
      try {
        dispatch({ type: 'IMPORT_PASTED_TASKS', text: textarea.value }, { rethrow: true });
      } catch (error) {
        message.show(null, error?.message || 'Could not import those deadlines.');
      }
    }
  },
    h('div', { className: 'form-field' },
      h('label', { for: 'paste-tasks-input' }, 'Paste several deadlines at once'),
      textarea,
      h('small', { className: 'field-hint' }, 'One per line: Title | 3h | YYYY-MM-DD | must-keep, flexible or droppable | optional latest date')
    ),
    h('button', { type: 'submit', className: 'button button-secondary' }, 'Import deadlines')
  );
}

/** Add a fixed block (class, shift, appointment) to one day. */
export function renderBusyForm({ days, dispatch, idPrefix = 'busy', onAdded }) {
  const errorBox = h('p', { id: `${idPrefix}-error`, className: 'field-error', role: 'alert', hidden: true });
  const daySelect = h('select', { id: `${idPrefix}-day`, name: 'day' },
    days.map(row => h('option', { value: String(row.index) }, row.label)));
  const startInput = h('input', { id: `${idPrefix}-start`, name: 'start', type: 'time', value: '09:00', step: '1800' });
  const endInput = h('input', { id: `${idPrefix}-end`, name: 'end', type: 'time', value: '10:00', step: '1800' });
  return h('form', {
    id: `${idPrefix}-form`,
    className: 'inline-form',
    novalidate: true,
    onSubmit: ev => {
      ev.preventDefault();
      errorBox.hidden = true;
      try {
        onAdded?.();
        dispatch({
          type: 'ADD_BUSY_BLOCK',
          dayIndex: Number(daySelect.value),
          start: startInput.value,
          end: endInput.value
        }, { rethrow: true });
      } catch (failure) {
        errorBox.textContent = failure?.message || 'Could not add that block.';
        errorBox.hidden = false;
      }
    }
  },
    h('div', { className: 'form-grid-three' },
      h('div', { className: 'form-field' }, h('label', { for: `${idPrefix}-day` }, 'Day'), daySelect),
      h('div', { className: 'form-field' }, h('label', { for: `${idPrefix}-start` }, 'From'), startInput),
      h('div', { className: 'form-field' }, h('label', { for: `${idPrefix}-end` }, 'To'), endInput)
    ),
    errorBox,
    h('button', { type: 'submit', className: 'button button-secondary' }, 'Add busy block')
  );
}

export function calendarStatusText(state) {
  return state.calendarImportedAt
    ? `Calendar imported ${fmtTimestamp(state.calendarImportedAt)}.`
    : '';
}
