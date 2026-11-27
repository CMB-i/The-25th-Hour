import { h } from './dom.mjs';

// Display order Monday first; values are the engine's weekday indexes (Sunday = 0).
export const WEEKDAYS = [
  [1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']
];

/** True when any loaded day has a work window. */
export function hasWorkWindows(days) {
  return days.some(day => (day.workWindows ?? []).length > 0);
}

/**
 * One time range applied to the weekdays you tick. `onApply(dayIndexes, start, end)` does the work.
 * Presets: Weekdays and Every day.
 */
export function renderRangePicker({ onApply, idPrefix = 'range', applyLabel = 'Set these hours', initial = ['16:00', '18:00'], error = null }) {
  const start = h('input', { id: `${idPrefix}-start`, name: 'start', type: 'time', step: '1800', value: initial[0] });
  const end = h('input', { id: `${idPrefix}-end`, name: 'end', type: 'time', step: '1800', value: initial[1] });
  const boxes = WEEKDAYS.map(([index, short, long]) =>
    h('label', { className: 'day-check', for: `${idPrefix}-day-${index}` },
      h('input', { id: `${idPrefix}-day-${index}`, type: 'checkbox', value: String(index), 'aria-label': long }),
      h('span', {}, short)));
  const setChecked = indexes => {
    for (const box of boxes) {
      const input = box.querySelector('input');
      input.checked = indexes.includes(Number(input.value));
    }
  };
  const message = error ?? h('p', { id: `${idPrefix}-error`, className: 'field-error', role: 'alert', hidden: true });
  return h('div', { className: 'range-picker', id: `${idPrefix}-picker` },
    h('div', { className: 'form-grid-two' },
      h('div', { className: 'form-field' }, h('label', { for: `${idPrefix}-start` }, 'From'), start),
      h('div', { className: 'form-field' }, h('label', { for: `${idPrefix}-end` }, 'To'), end)
    ),
    h('fieldset', { className: 'day-picks' },
      h('legend', {}, 'On these days'),
      h('div', { className: 'day-check-row' }, boxes),
      h('div', { className: 'section-actions' },
        h('button', { type: 'button', id: `${idPrefix}-preset-weekdays`, className: 'link-button', onClick: () => setChecked([1, 2, 3, 4, 5]) }, 'Weekdays'),
        h('button', { type: 'button', id: `${idPrefix}-preset-everyday`, className: 'link-button', onClick: () => setChecked([0, 1, 2, 3, 4, 5, 6]) }, 'Every day')
      )
    ),
    message,
    h('button', {
      type: 'button', id: `${idPrefix}-apply`, className: 'button button-primary',
      onClick: () => {
        message.hidden = true;
        const picked = boxes.map(box => box.querySelector('input')).filter(input => input.checked).map(input => Number(input.value));
        if (!picked.length) {
          message.textContent = 'Tick at least one day.';
          message.hidden = false;
          return;
        }
        if (!start.value || !end.value || start.value >= end.value) {
          message.textContent = 'The end time must be after the start time.';
          message.hidden = false;
          return;
        }
        try {
          onApply(picked, start.value, end.value);
        } catch (failure) {
          message.textContent = failure?.message || 'Could not use those hours.';
          message.hidden = false;
        }
      }
    }, applyLabel)
  );
}

/**
 * Work hours as a range picker plus a short per-day summary. A single day can be edited as an
 * exception. The rows live in this component until the caller reads them with getRows().
 */
export function renderWorkHours({ initialRows, onChange = () => {} }) {
  const rows = initialRows.map(day => (day ?? []).map(pair => [...pair]));
  while (rows.length < 7) rows.push([]);
  const editing = new Set();
  const summary = h('ul', { className: 'hours-summary', id: 'hours-summary' });

  function draw() {
    summary.replaceChildren(
      ...WEEKDAYS.map(([index, , long]) => {
        const open = editing.has(index);
        const text = rows[index].length ? rows[index].map(pair => `${pair[0]}–${pair[1]}`).join(', ') : 'No work hours';
        return h('li', { className: 'hours-day' },
          h('div', { className: 'hours-day-head' },
            h('strong', {}, long),
            h('span', { className: 'hours-day-text' }, text),
            h('button', {
              type: 'button', id: `day-edit-${index}`, className: 'link-button',
              'aria-expanded': String(open),
              onClick: () => { if (open) editing.delete(index); else editing.add(index); draw(); }
            }, open ? 'Done' : `Change ${long}`)),
          open
            ? h('div', { className: 'hours-edit' },
                rows[index].map((pair, i) =>
                  h('div', { className: 'hours-row' },
                    h('div', { className: 'form-field' },
                      h('label', { for: `hours-${index}-${i}-start` }, `${long} from`),
                      h('input', { id: `hours-${index}-${i}-start`, type: 'time', step: '1800', value: pair[0],
                        onInput: ev => { pair[0] = ev.currentTarget.value; onChange(); } })),
                    h('div', { className: 'form-field' },
                      h('label', { for: `hours-${index}-${i}-end` }, `${long} to`),
                      h('input', { id: `hours-${index}-${i}-end`, type: 'time', step: '1800', value: pair[1],
                        onInput: ev => { pair[1] = ev.currentTarget.value; onChange(); } })),
                    h('button', {
                      type: 'button', className: 'link-button',
                      'aria-label': `Remove ${long} window ${pair[0]} to ${pair[1]}`,
                      onClick: () => { rows[index].splice(i, 1); draw(); onChange(); }
                    }, 'Remove'))),
                h('button', {
                  type: 'button', className: 'link-button',
                  onClick: () => { rows[index].push(['16:00', '18:00']); draw(); onChange(); }
                }, `Add another ${long} window`))
            : null);
      })
    );
  }
  draw();

  const picker = renderRangePicker({
    idPrefix: 'range',
    applyLabel: 'Set hours for these days',
    onApply: (indexes, start, end) => {
      for (const index of indexes) rows[index] = [[start, end]];
      draw();
      onChange();
    }
  });
  return {
    node: h('div', { className: 'hours-editor', id: 'hours-editor' }, picker, summary),
    getRows: () => rows.map(day => day.map(pair => [...pair]))
  };
}

/** Merges one time range into the weekly work windows and saves it quietly (validated by the engine). */
export function saveHoursFor(state, dispatch, indexes, start, end) {
  const rows = (state.settings?.weeklyWorkWindows ?? [[], [], [], [], [], [], []]).map(day => (day ?? []).map(pair => [...pair]));
  while (rows.length < 7) rows.push([]);
  for (const index of indexes) rows[index] = [[start, end]];
  dispatch({
    type: 'SAVE_SETTINGS',
    sleepStart: state.sleep.start,
    sleepEnd: state.sleep.end,
    anchor: state.settings?.anchor ?? state.days[0].date,
    weeklyWorkWindows: rows,
    quiet: true
  }, { rethrow: true });
}

/** "I can work 16:00–20:00 on Mon Tue …" with a Save. Used when no work hours exist yet. */
export function renderWorkSentence({ onSave, idPrefix = 'sentence' }) {
  const start = h('input', { id: `${idPrefix}-start`, type: 'time', step: '1800', value: '16:00', 'aria-label': 'Work from' });
  const end = h('input', { id: `${idPrefix}-end`, type: 'time', step: '1800', value: '20:00', 'aria-label': 'Work until' });
  const boxes = WEEKDAYS.map(([index, short, long]) =>
    h('label', { className: 'day-check', for: `${idPrefix}-day-${index}` },
      h('input', { id: `${idPrefix}-day-${index}`, type: 'checkbox', value: String(index), 'aria-label': long }),
      h('span', {}, short)));
  const setChecked = indexes => {
    for (const box of boxes) {
      const input = box.querySelector('input');
      input.checked = indexes.includes(Number(input.value));
    }
  };
  const error = h('p', { id: `${idPrefix}-error`, className: 'field-error', role: 'alert', hidden: true });
  return h('div', { className: 'work-sentence', id: `${idPrefix}-card` },
    h('p', { className: 'work-sentence-line' },
      'I can work ',
      h('span', { className: 'work-sentence-times' }, start, h('span', { 'aria-hidden': 'true' }, '–'), end),
      ' on'),
    h('div', { className: 'day-check-row' }, boxes),
    h('div', { className: 'section-actions' },
      h('button', { type: 'button', id: `${idPrefix}-weekdays`, className: 'link-button', onClick: () => setChecked([1, 2, 3, 4, 5]) }, 'Weekdays'),
      h('button', { type: 'button', id: `${idPrefix}-everyday`, className: 'link-button', onClick: () => setChecked([0, 1, 2, 3, 4, 5, 6]) }, 'Every day')),
    error,
    h('button', {
      type: 'button', id: `${idPrefix}-save`, className: 'button button-primary',
      onClick: () => {
        error.hidden = true;
        const picked = boxes.map(box => box.querySelector('input')).filter(input => input.checked).map(input => Number(input.value));
        if (!picked.length) { error.textContent = 'Tick at least one day.'; error.hidden = false; return; }
        if (!start.value || !end.value || start.value >= end.value) { error.textContent = 'The end time must be after the start time.'; error.hidden = false; return; }
        try { onSave(picked, start.value, end.value); }
        catch (failure) { error.textContent = failure?.message || 'Could not save those hours.'; error.hidden = false; }
      }
    }, 'Save')
  );
}
