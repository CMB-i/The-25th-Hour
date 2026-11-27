import { h, setBlobTone, svg } from './dom.mjs';
import { WEEKDAYS } from './hours-editor.mjs';
import { MAX_ICS_BYTES } from './state.mjs';
import { openWeekBusy } from './render-week.mjs';

// The three first-run cards. UI-only until each step is saved.
const flow = { step: 1, ready: false, sleepStart: 1380, sleepEnd: 420, from: 960, to: 1200, days: [false, true, true, true, true, true, false], error: '', importError: '' };

const toMinutes = time => {
  const [hh, mm] = String(time).split(':').map(Number);
  return hh * 60 + mm;
};
const toTime = minutes => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const clock = minutes => {
  const m = ((minutes % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'pm' : 'am'}`;
};

function seedFrom(state) {
  flow.sleepStart = toMinutes(state.sleep.start);
  flow.sleepEnd = toMinutes(state.sleep.end);
  const rows = state.settings?.weeklyWorkWindows ?? [];
  const firstWindow = rows.flat().find(Boolean);
  if (firstWindow) {
    flow.from = toMinutes(firstWindow[0]);
    flow.to = toMinutes(firstWindow[1]);
    flow.days = [0, 1, 2, 3, 4, 5, 6].map(index => (rows[index] ?? []).length > 0);
  }
  flow.ready = true;
}

/** Back to a fresh first-run next time it opens. */
export function resetStartFlow() {
  flow.step = 1;
  flow.ready = false;
  flow.error = '';
  flow.importError = '';
}

function stepper({ id, label, value, onLess, onMore, lessLabel, moreLabel }) {
  return h('div', { className: 'row-card' },
    h('span', { className: 'row-label', id: `${id}-label` }, label),
    h('div', { className: 'stepper', role: 'group', 'aria-labelledby': `${id}-label` },
      h('button', { type: 'button', id: `${id}-less`, className: 'step-btn small', 'aria-label': lessLabel, onClick: onLess }, '−'),
      h('span', { id: `${id}-value`, className: 'step-value small', 'aria-live': 'polite' }, clock(value)),
      h('button', { type: 'button', id: `${id}-more`, className: 'step-btn small', 'aria-label': moreLabel, onClick: onMore }, '+'))
  );
}

/**
 * First run: sleep, work hours, classes. Optional and skippable; Home never waits on it.
 */
export function renderStartScreen(container, ctx) {
  const { state, dispatch } = ctx;
  if (!flow.ready) seedFrom(state);
  setBlobTone('tan');
  const rerender = () => renderStartScreen(container, ctx);
  const goHome = () => { resetStartFlow(); dispatch({ type: 'NAVIGATE', screen: 'home' }); };
  const nudge = (key, delta) => { flow[key] = ((flow[key] + delta) % 1440 + 1440) % 1440; rerender(); };
  const clampFrom = delta => { flow.from = Math.max(0, Math.min(flow.to - 30, flow.from + delta)); rerender(); };
  const clampTo = delta => { flow.to = Math.max(flow.from + 30, Math.min(1440, flow.to + delta)); rerender(); };

  const sleepMinutes = ((flow.sleepEnd - flow.sleepStart) % 1440 + 1440) % 1440;
  const workDays = flow.days.filter(Boolean).length;
  const weekly = Math.round(workDays * (flow.to - flow.from) / 6) / 10;

  const saveSleep = () => {
    flow.error = '';
    const rows = (state.settings?.weeklyWorkWindows ?? [[], [], [], [], [], [], []]).map(day => (day ?? []).map(pair => [...pair]));
    flow.step = 2;
    try {
      dispatch({
        type: 'SAVE_SETTINGS',
        sleepStart: toTime(flow.sleepStart), sleepEnd: toTime(flow.sleepEnd),
        anchor: state.settings?.anchor ?? state.days[0].date, weeklyWorkWindows: rows, quiet: true
      }, { rethrow: true });
    } catch (failure) {
      flow.step = 1;
      flow.error = failure?.message || 'Could not save those times.';
      rerender();
    }
  };
  const saveHours = () => {
    flow.error = '';
    if (!workDays) { flow.error = 'Pick at least one day.'; rerender(); return; }
    const rows = [0, 1, 2, 3, 4, 5, 6].map(index => (flow.days[index] ? [[toTime(flow.from), toTime(flow.to)]] : []));
    flow.step = 3;
    try {
      dispatch({
        type: 'SAVE_SETTINGS',
        sleepStart: state.sleep.start, sleepEnd: state.sleep.end,
        anchor: state.settings?.anchor ?? state.days[0].date, weeklyWorkWindows: rows, quiet: true
      }, { rethrow: true });
    } catch (failure) {
      flow.step = 2;
      flow.error = failure?.message || 'Could not save those hours.';
      rerender();
    }
  };

  let heading;
  let body;
  if (flow.step === 1) {
    heading = ['STEP 1 OF 3 · SLEEP', 'First, when do you sleep?',
      "I protect this before I plan anything else. A feasible plan makes room to sleep. It can't make you sleep."];
    body = h('div', { className: 'stack-12' },
      stepper({ id: 'sleep-start', label: 'Sleep starts', value: flow.sleepStart, lessLabel: 'Start 30 minutes earlier', moreLabel: 'Start 30 minutes later',
        onLess: () => nudge('sleepStart', -30), onMore: () => nudge('sleepStart', 30) }),
      stepper({ id: 'sleep-end', label: 'Sleep ends', value: flow.sleepEnd, lessLabel: 'End 30 minutes earlier', moreLabel: 'End 30 minutes later',
        onLess: () => nudge('sleepEnd', -30), onMore: () => nudge('sleepEnd', 30) }),
      h('div', { className: 'note-pill', id: 'sleep-summary' },
        svg('svg', { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
          svg('path', { d: 'M14 10.5A6 6 0 1 1 7.5 4a5 5 0 0 0 6.5 6.5z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' })),
        `${Math.round(sleepMinutes / 6) / 10} hours protected every night.`)
    );
  } else if (flow.step === 2) {
    heading = ['STEP 2 OF 3 · WORK HOURS', 'When can you actually work?',
      "Not when you wish you could. The hours you'd really sit down. Classes and clubs come off these."];
    body = h('div', { className: 'stack-14' },
      h('div', { className: 'chip-row even', role: 'group', 'aria-label': 'Days you can work', id: 'start-days' },
        WEEKDAYS.map(([index, short, long]) =>
          h('button', {
            type: 'button', className: 'chip', id: `start-day-${index}`, 'aria-label': long, 'aria-pressed': String(flow.days[index]),
            onClick: () => { flow.days[index] = !flow.days[index]; rerender(); }
          }, short.slice(0, 1)))),
      stepper({ id: 'work-from', label: 'From', value: flow.from, lessLabel: 'From 30 minutes earlier', moreLabel: 'From 30 minutes later',
        onLess: () => clampFrom(-30), onMore: () => clampFrom(30) }),
      stepper({ id: 'work-to', label: 'Until', value: flow.to, lessLabel: 'Until 30 minutes earlier', moreLabel: 'Until 30 minutes later',
        onLess: () => clampTo(-30), onMore: () => clampTo(30) }),
      h('div', { className: 'note-pill', id: 'work-summary' },
        `${workDays} ${workDays === 1 ? 'day' : 'days'}, ${clock(flow.from)} to ${clock(flow.to)}. About ${weekly} hours a week.`),
      h('p', { className: 'fine-left' }, 'Different on Saturdays? You can add exceptions later in Settings.')
    );
  } else {
    heading = ['STEP 3 OF 3 · YOUR CLASSES', 'Now bring your classes.',
      'This is what makes the answer trustworthy. You can do it later. Every check will tell you what it counted.'];
    const imported = Boolean(state.calendarImportedAt);
    body = h('div', { className: 'stack-12' },
      h('label', { className: `option-tile${imported ? ' is-ready' : ''}`, for: 'start-calendar-file' },
        h('span', { className: 'tile-icon', 'aria-hidden': 'true' },
          svg('svg', { width: '22', height: '22', viewBox: '0 0 22 22', fill: 'none' },
            svg('rect', { x: '3.5', y: '5', width: '15', height: '13', rx: '2.5', stroke: 'currentColor', 'stroke-width': '1.7' }),
            svg('path', { d: 'M3.5 9h15M8 3v4M14 3v4', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }))),
        h('span', { className: 'tile-text' },
          h('span', { className: 'tile-title' }, imported ? 'Timetable imported' : 'Import a timetable (.ics)'),
          h('span', { className: 'tile-sub' }, imported ? 'You can check what it counted in My week.' : 'From Google Calendar, Outlook or your university portal.')),
        h('input', {
          id: 'start-calendar-file', type: 'file', accept: '.ics,text/calendar',
          onChange: async ev => {
            const file = ev.currentTarget.files?.[0];
            if (!file) return;
            flow.importError = '';
            try {
              if (file.size > MAX_ICS_BYTES) throw Error('Calendar file exceeds the 1 MB size limit.');
              dispatch({ type: 'IMPORT_ICS', text: await file.text(), fileSize: file.size, fileName: file.name }, { rethrow: true });
            } catch (failure) {
              flow.importError = failure?.message || 'Could not import that calendar file.';
              rerender();
            }
          }
        })),
      flow.importError ? h('p', { className: 'field-error', role: 'alert' }, flow.importError) : null,
      h('button', {
        type: 'button', id: 'start-add-blocks', className: 'option-tile',
        onClick: () => { resetStartFlow(); openWeekBusy(); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
      },
        h('span', { className: 'tile-icon', 'aria-hidden': 'true' },
          svg('svg', { width: '22', height: '22', viewBox: '0 0 22 22', fill: 'none' },
            svg('path', { d: 'M11 5v12M5 11h12', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round' }))),
        h('span', { className: 'tile-text' },
          h('span', { className: 'tile-title' }, 'Add busy blocks by hand'),
          h('span', { className: 'tile-sub' }, 'A lab, a shift, club meetings. Takes a minute.')))
    );
  }

  const actions = h('div', { className: 'start-actions' },
    flow.step < 3
      ? h('button', {
          type: 'button', id: 'start-next', className: 'button button-primary',
          onClick: flow.step === 1 ? saveSleep : saveHours
        }, flow.step === 1 ? 'Next: work hours' : 'Next: my classes')
      : h('button', { type: 'button', id: 'start-home', className: 'button button-primary', onClick: goHome }, 'Take me home'),
    flow.step === 3
      ? h('button', { type: 'button', id: 'start-later', className: 'link-button', onClick: goHome }, "I'll add classes later")
      : h('button', { type: 'button', id: 'start-skip', className: 'link-button', onClick: goHome }, 'Skip for now'),
    flow.step > 1
      ? h('button', { type: 'button', id: 'start-back', className: 'link-button', onClick: () => { flow.step -= 1; flow.error = ''; rerender(); } }, 'Back')
      : null
  );

  container.replaceChildren(...[
    h('div', { className: 'start-head' },
      h('span', { className: 'eyebrow' }, 'First run'),
      h('div', { className: 'progress-dots', role: 'img', 'aria-label': `Step ${flow.step} of 3` },
        [1, 2, 3].map(n => h('span', { className: n <= flow.step ? 'on' : '' })))),
    h('div', {},
      h('div', { className: 'eyebrow' }, heading[0]),
      h('h1', { className: 'start-title', id: 'start-title' }, heading[1]),
      h('p', { className: 'start-lede' }, heading[2])),
    body,
    flow.error ? h('p', { id: 'start-error', className: 'field-error', role: 'alert' }, flow.error) : null,
    actions
  ].filter(Boolean));
}
