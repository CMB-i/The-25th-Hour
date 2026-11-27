import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { deadlineCost } from '../engine/evaluate.mjs';
import { campusDate } from '../engine/feedback.mjs';
import { LOADED_WEEKS } from '../engine/weeks.mjs';
import { hoursPhrase } from './check-model.mjs';
import {
  buildVerdictCopy,
  fmtMinutes,
  fmtShortDate,
  fmtShortWeekday,
  fmtSignedHours,
  h,
  setBlobTone,
  svg,
  verdictClass,
  verdictLabel
} from './dom.mjs';
import { hasWorkWindows, renderWorkSentence, saveHoursFor } from './hours-editor.mjs';
import { createImportMessage, makeCalendarInput, renderPasteImport } from './import-controls.mjs';
import { renderTimeline } from './render-timeline.mjs';
import { renderFreeTable, renderWeekGrid } from './render-weekgrid.mjs';
import { buildAgenda, calendarStatus, clock12, hoursText, weekFreeTotal } from './week-model.mjs';

// UI-only state for this screen.
let selectedDay = null;
let selectedBlock = null;
let formDay = null; // day chosen in the add-a-block form; null follows the selected day
let pendingFocus = null;
let addOpen = false;
let blockStart = 1080; // minutes
let blockEnd = 1140;

/** Opens the add-a-busy-block controls the next time My week is shown (used by links from Home and Check). */
export function openWeekBusy() {
  pendingFocus = '#add-busy';
}

/** Lets other screens open My week with a control focused. */
export function focusWeekSection(selector) {
  pendingFocus = selector;
}

/** Opens the add-a-block form for a day and time (used by a click on an empty spot of the grid). */
function openBusyForm(day, minutes) {
  const start = Math.max(360, Math.min(1350, Math.round(minutes / 30) * 30));
  formDay = day;
  blockStart = start;
  blockEnd = Math.min(1380, start + 60);
  addOpen = true;
  pendingFocus = '#week-busy-title';
}

const toTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const clockMinutes = minutes => clock12(toTime(minutes));

function pickSelectedDay(state, derived) {
  const indices = derived.week.dayIndices;
  if (selectedDay !== null && indices.includes(selectedDay)) return selectedDay;
  const today = campusDate(new Date().toISOString());
  const todayIndex = today ? state.days.findIndex(day => day.date === today) : -1;
  selectedDay = indices.includes(todayIndex) ? todayIndex : indices[0];
  return selectedDay;
}

function rangeLabel(derived) {
  const [startDay, startMonth] = fmtShortDate(derived.week.startDate).split(' ');
  const [endDay, endMonth] = fmtShortDate(derived.week.endDate).split(' ');
  return startMonth === endMonth ? `${startDay} to ${endDay} ${endMonth}` : `${startDay} ${startMonth} to ${endDay} ${endMonth}`;
}

function renderSummary(state, derived, dispatch) {
  const { evaluation, weekly, repairs } = derived;
  const copy = buildVerdictCopy(evaluation, state.days);
  const cls = verdictClass(evaluation.verdict);
  const tone = cls === 'alert' ? 'short' : cls === 'risk' ? 'tight' : 'fits';
  const atRisk = evaluation.verdict !== 'feasible';

  if (!derived.activeTasks.length) {
    return h('section', { id: 'week-verdict', className: 'week-status status-fits', 'aria-live': 'polite' },
      h('p', { className: 'status-word' }, 'Nothing due'),
      h('h2', { className: 'status-title' }, 'No deadlines in the weeks loaded.'),
      h('p', { className: 'status-body' }, 'See if something fits, or add deadlines below.')
    );
  }
  return h('section', { id: 'week-verdict', className: `week-status status-${tone}`, 'aria-live': 'polite' },
    h('p', { className: 'status-word' }, verdictLabel(evaluation.verdict)),
    h('h2', { className: 'status-title' }, copy.headline),
    h('p', { className: 'status-body' }, copy.body),
    copy.contributingText ? h('p', { className: 'status-note' }, copy.contributingText) : null,
    copy.releaseNote ? h('p', { className: 'status-note' }, copy.releaseNote) : null,
    h('p', { className: 'status-note' },
      `This week: ${fmtMinutes(weekly.requiredMinutes)} of work, ${fmtMinutes(weekly.capacityMinutes)} free after busy blocks and sleep.`),
    atRisk
      ? h('button', {
          type: 'button', id: 'week-reset', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
        }, repairs.length ? 'See what can move' : 'See your options')
      : null
  );
}

function renderStrip(agenda, picked, today, rerender) {
  return h('div', { className: 'daystrip', role: 'group', 'aria-label': 'Pick a day' },
    agenda.map(day =>
      h('button', {
        type: 'button',
        className: `daystrip-day${day.index === picked ? ' is-selected' : ''}`,
        'aria-pressed': String(day.index === picked),
        'aria-label': `${day.weekday} ${fmtShortDate(day.date)}${day.due.length ? `, ${day.due.length} due` : ''}`,
        onClick: () => { selectedDay = day.index; formDay = null; rerender(); }
      },
        h('span', { className: 'daystrip-label' }, day.weekday.slice(0, 3)),
        h('span', { className: 'daystrip-num' }, fmtShortDate(day.date).split(' ')[0]),
        h('span', { className: `daystrip-dot${day.index === today ? ' is-today' : ''}`, 'aria-hidden': 'true' })
      ))
  );
}

/** Details for the busy block the student pressed in the grid, with the only way to remove it. */
function renderBlockDetail(selected, dispatch, clear) {
  const { entry, day, dayIndex } = selected;
  return h('div', { className: 'block-detail', id: 'block-detail', role: 'group', 'aria-label': 'Selected busy block' },
    h('div', { className: 'block-detail-text' },
      h('strong', {}, entry.label),
      h('span', {}, [day.weekday, entry.room, entry.time].filter(Boolean).join(' · '))),
    h('div', { className: 'block-detail-actions' },
      h('button', {
        type: 'button', className: 'button button-outline', id: 'block-remove',
        'aria-label': `Remove ${entry.label} on ${day.weekday}, ${entry.time}`,
        onClick: () => { clear(); dispatch({ type: 'REMOVE_BUSY_BLOCK', dayIndex, start: entry.start, end: entry.end }); }
      }, 'Remove from my week'),
      h('button', { type: 'button', className: 'link-button', id: 'block-close', onClick: clear }, 'Close')));
}

function renderBusyPanel({ state, agenda, picked, dispatch, message, rerender }) {
  const cal = calendarStatus(state);
  const added = Object.values(state.busyLabels ?? {}).filter(value => typeof value === 'string').length;
  const todayDate = campusDate(new Date().toISOString());
  const dayInfo = agenda.find(day => day.index === (formDay ?? picked)) ?? agenda.find(day => day.index === picked) ?? agenda[0];
  const fileInput = makeCalendarInput({ dispatch, message, className: 'sr-only' });
  const importedOn = state.calendarImportedAt
    ? fmtShortDate(campusDate(state.calendarImportedAt) ?? state.calendarImportedAt.slice(0, 10))
    : '';
  const statusText = cal.kind === 'none'
    ? `No timetable imported yet. I only count ${added ? `the ${added} block${added === 1 ? '' : 's'} you added` : 'blocks you add here'}, your work hours and your sleep.`
    : `Using the timetable you imported on ${importedOn}${added ? `, plus ${added} block${added === 1 ? '' : 's'} you added` : ''}.${cal.stale ? ' That was over a day ago, so import it again before relying on this.' : ''}`;

  const titleInput = h('input', {
    id: 'week-busy-title', name: 'title', type: 'text', maxlength: '60', autocomplete: 'off',
    className: 'text-input', placeholder: 'e.g. Lab, shift, club meeting'
  });
  const startOut = h('span', { className: 'step-value small', id: 'block-start-out', 'aria-live': 'polite' }, clockMinutes(blockStart));
  const endOut = h('span', { className: 'step-value small', id: 'block-end-out', 'aria-live': 'polite' }, clockMinutes(blockEnd));
  const startHidden = h('input', { id: 'week-busy-start', name: 'start', type: 'hidden', value: toTime(blockStart) });
  const endHidden = h('input', { id: 'week-busy-end', name: 'end', type: 'hidden', value: toTime(blockEnd) });
  const dayHidden = h('input', { id: 'week-busy-day', name: 'day', type: 'hidden', value: String(dayInfo.index) });
  const repeat = h('input', { id: 'week-busy-repeat', name: 'repeat', type: 'checkbox' });
  const dayLabelEl = h('label', { for: 'week-busy-title', className: 'field-label' }, `What is it? (${dayInfo.weekday.slice(0, 3)})`);
  const pastNote = h('p', { id: 'week-busy-past', className: 'field-hint', role: 'status' });
  const submitBtn = h('button', { type: 'submit', className: 'button button-primary busy-add' }, `Add to ${dayInfo.weekday.slice(0, 3)}`);
  const chips = [];
  const chosen = () => agenda.find(day => String(day.index) === dayHidden.value) ?? dayInfo;
  const syncDay = () => {
    const day = chosen();
    for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.index === dayHidden.value));
    dayLabelEl.textContent = `What is it? (${day.weekday.slice(0, 3)})`;
    submitBtn.textContent = `Add to ${day.weekday.slice(0, 3)}${repeat.checked ? ', every week' : ''}`;
    // Past days are never blocked: say so in words.
    pastNote.textContent = todayDate && day.date < todayDate
      ? `${day.weekday} ${fmtShortDate(day.date)} has already passed. You can still add a block to it, for example to fix your record of the week.`
      : '';
  };
  for (const day of agenda) {
    chips.push(h('button', {
      type: 'button', className: 'chip busy-day-chip', 'data-index': String(day.index),
      'aria-pressed': String(day.index === dayInfo.index), 'aria-label': `${day.weekday} ${fmtShortDate(day.date)}`,
      onClick: () => { dayHidden.value = String(day.index); formDay = day.index; syncDay(); }
    }, day.weekday.slice(0, 3)));
  }
  const error = h('p', { id: 'week-busy-error', className: 'field-error', role: 'alert', hidden: true });
  const syncOut = () => {
    startOut.textContent = clockMinutes(blockStart);
    endOut.textContent = clockMinutes(blockEnd);
    startHidden.value = toTime(blockStart);
    endHidden.value = toTime(blockEnd);
  };
  const nudge = (which, delta) => {
    if (which === 'start') blockStart = Math.max(360, Math.min(blockEnd - 30, blockStart + delta));
    else blockEnd = Math.max(blockStart + 30, Math.min(1380, blockEnd + delta));
    syncOut();
  };
  const stepper = (label, out, which) =>
    h('div', { className: 'busy-time-row' },
      h('span', { className: 'busy-time-label' }, which === 'start' ? 'From' : 'Until'),
      h('div', { className: 'stepper' },
        h('button', { type: 'button', className: 'step-btn small', 'aria-label': `${label} earlier`, onClick: () => nudge(which, -30) }, '−'),
        out,
        h('button', { type: 'button', className: 'step-btn small', 'aria-label': `${label} later`, onClick: () => nudge(which, 30) }, '+')));

  const form = h('form', {
    id: 'week-busy-form', className: 'card busy-form', novalidate: true, hidden: !addOpen,
    onSubmit: ev => {
      ev.preventDefault();
      error.hidden = true;
      try {
        pendingFocus = '#add-busy';
        addOpen = false;
        dispatch({
          type: 'ADD_BUSY_BLOCK',
          dayIndex: Number(dayHidden.value),
          start: startHidden.value,
          end: endHidden.value,
          label: titleInput.value,
          repeatWeekly: repeat.checked
        }, { rethrow: true });
        formDay = null;
      } catch (failure) {
        addOpen = true;
        pendingFocus = null;
        error.textContent = failure?.message || 'Could not add that block.';
        error.hidden = false;
      }
    }
  },
    h('div', { className: 'field' },
      h('span', { className: 'field-label', id: 'busy-day-label' }, 'Which day?'),
      h('div', { className: 'chip-row', role: 'group', 'aria-labelledby': 'busy-day-label' }, chips),
      pastNote),
    h('div', { className: 'field' }, dayLabelEl, titleInput),
    h('div', { className: 'busy-times' },
      stepper('Start', startOut, 'start'),
      stepper('End', endOut, 'end')),
    h('label', { className: 'check-line', for: 'week-busy-repeat' }, repeat, 'Repeats every week, to the end of the loaded weeks'),
    dayHidden, startHidden, endHidden,
    error,
    submitBtn
  );
  repeat.addEventListener('change', syncDay);
  syncDay();

  return h('section', { id: 'busy-panel', className: 'week-section' },
    h('h2', { className: 'section-title' }, 'When are you busy?'),
    h('p', { className: 'section-help' }, 'Classes, shifts, meetings. These come off your free time first.'),
    h('p', { className: `status-line${cal.stale ? ' is-warning' : ''}` }, statusText),
    h('div', { className: 'section-actions' },
      h('button', {
        type: 'button', id: 'import-timetable', className: 'button button-outline',
        onClick: () => fileInput.click()
      }, 'Import timetable'),
      h('button', {
        type: 'button', id: 'add-busy', className: 'button button-outline', 'aria-expanded': String(addOpen),
        onClick: () => { addOpen = !addOpen; pendingFocus = addOpen ? '#week-busy-title' : '#add-busy'; rerender(); }
      }, 'Add a busy block')),
    fileInput,
    form
  );
}

let confirmRemoveId = null;

function renderTodoPanel(state, derived, dispatch, message, rerender) {
  const inWeek = derived.activeTasks.filter(task => derived.week.dayIndices.includes(task.targetDay));
  const elsewhere = derived.activeTasks.filter(task => !derived.week.dayIndices.includes(task.targetDay));
  const row = (task, withDate) => {
    const targetDate = state.days[task.targetDay]?.date;
    const hardDate = state.days[task.hardDay]?.date;
    const confirming = confirmRemoveId === task.id;
    const remove = () => {
      confirmRemoveId = null;
      dispatch(task.isProposal ? { type: 'DISCARD_PROPOSAL', proposalIds: [task.id] } : { type: 'REMOVE_TASK', taskId: task.id });
    };
    return h('li', { className: 'todo-row', 'data-task': task.id },
      h('div', { className: 'todo-main' },
        h('div', { className: 'todo-title' }, task.title, task.isProposal ? ' (proposed)' : ''),
        h('div', { className: 'todo-meta' },
          `${hoursPhrase(task.likely)} · due ${withDate ? fmtShortDate(targetDate) : weekdayName(targetDate)}`,
          task.hardDay !== task.targetDay && hardDate ? ` · can slip to ${fmtShortWeekday(hardDate)}` : '')),
      confirming
        ? h('div', { className: 'todo-confirm', role: 'group', 'aria-label': `Remove ${task.title}?` },
            h('button', { type: 'button', className: 'button button-danger todo-yes', onClick: remove }, `Yes, remove`),
            h('button', { type: 'button', className: 'link-button todo-keep', onClick: () => { confirmRemoveId = null; rerender(); } }, 'Keep'))
        : h('button', {
            type: 'button', className: 'link-button todo-remove', 'aria-label': `Remove ${task.title}`,
            onClick: () => { confirmRemoveId = task.id; rerender(); }
          }, 'Remove'));
  };
  return h('section', { id: 'todo-panel', className: 'week-section' },
    h('h2', { className: 'section-title' }, 'What still needs doing?'),
    h('p', { className: 'section-help' }, 'Deadline work. I plan it into whatever free time is left, after busy blocks and sleep.'),
    inWeek.length
      ? h('ul', { className: 'todo-list' }, inWeek.map(task => row(task, false)))
      : h('p', { className: 'agenda-empty' }, 'No deadline work due this week.'),
    elsewhere.length
      ? [h('h3', { className: 'todo-subhead' }, `Due in other weeks (${elsewhere.length})`),
         h('ul', { className: 'todo-list' }, elsewhere.map(task => row(task, true)))]
      : null,
    h('button', {
      type: 'button', id: 'check-something-new', className: 'link-button',
      onClick: () => dispatch({ type: 'NAVIGATE', screen: 'home' })
    }, 'Run another yes'),
    h('details', { className: 'quiet-details', id: 'todo-edit' },
      h('summary', {}, 'Add deadlines in bulk'),
      renderPasteImport({ dispatch, message })
    )
  );
}

function renderEstimateTable(state, derived) {
  const levels = [
    ['optimistic', 'If everything goes quickly'],
    ['typical', 'As estimated'],
    ['conservative', 'If everything runs long']
  ];
  return h('div', { className: 'estimate-table' },
    levels.map(([key, label]) => {
      const schedule = derived.evaluation[key];
      const cost = deadlineCost(schedule, state.days);
      const text = cost ? `${fmtShortWeekday(cost.date)} ${fmtSignedHours(cost.marginHours)}` : 'No deadlines';
      return h('div', { className: 'estimate-row' },
        h('strong', {}, label),
        h('span', { className: cost && cost.marginHours < 0 ? 'not-ok' : 'ok' }, text),
        h('span', { className: schedule.feasible ? 'ok' : 'not-ok' }, schedule.feasible ? 'Fits' : "Doesn't fit")
      );
    })
  );
}

/** One-line weekly total: the real free hours in the work windows, from today when today is in this week. */
function renderWeekTotal(state, derived, agenda) {
  const todayDate = campusDate(new Date().toISOString());
  const inWeek = agenda.some(day => day.date === todayDate);
  const total = weekFreeTotal(agenda, inWeek ? todayDate : null);
  const countedDays = agenda.filter(day => day.hasWindows && (!inWeek || day.date >= todayDate)).length;
  return h('div', { className: 'week-total', id: 'week-total' },
    h('p', { className: 'week-total-line' },
      h('strong', {}, `${Math.round(total * 10) / 10} free hours`), ' this week'),
    h('p', { className: 'week-total-sub' },
      countedDays
        ? `Across ${countedDays} work day${countedDays === 1 ? '' : 's'}${inWeek ? ', from today' : ''}. Free = work hours still ahead, minus classes and busy blocks, minus sleep, minus planned work.`
        : 'No work hours in this week yet.'));
}

/**
 * My week: what the check is counting. A time grid; the whole week on a desktop, one day on a phone.
 */
export function renderWeekScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const rerender = () => renderWeekScreen(container, ctx);
  const picked = pickSelectedDay(state, derived);
  const agenda = buildAgenda({ state, derived });
  const totalWeeks = Math.max(1, derived.maxWeekIndex + 1);
  const message = createImportMessage(state);
  const pending = state.proposals[0];
  const today = state.days.findIndex(day => day.date === campusDate(new Date().toISOString()));
  const hasHours = hasWorkWindows(state.days);
  setBlobTone('sage');

  const main = [];
  const side = [];
  if (pending) {
    main.push(
      h('button', {
        type: 'button', id: 'back-to-request', className: 'return-banner',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      },
        h('span', {}, `You were checking ${pending.title}.`),
        h('span', { className: 'return-link' }, 'Back to your request'))
    );
  }

  main.push(
    h('header', { className: 'week-head' },
      h('h1', { className: 'screen-title' }, "What I'm counting."),
      h('p', { className: 'screen-lede' }, 'Check it matches your real week. Fix anything missing and your answer updates.'))
  );

  if (!hasHours) {
    main.push(
      h('section', { id: 'week-setup', className: 'card setup-card', 'aria-labelledby': 'week-setup-title' },
        h('h2', { id: 'week-setup-title', className: 'card-title' }, 'When can you work?'),
        h('p', { className: 'section-help' }, 'Tell me your work hours and I can show your week and check what fits.'),
        renderWorkSentence({
          idPrefix: 'week-hours',
          onSave: (indexes, start, end) => saveHoursFor(state, dispatch, indexes, start, end)
        })
      ),
      message.box
    );
  } else {
    if (state.unresolvedConflict && !derived.evaluation.typical.feasible) {
      main.push(h('p', { className: 'status-line is-warning' }, 'You added something that did not fit, so the gap below is still open.'));
    }
    side.push(renderWeekTotal(state, derived, agenda));
    side.push(renderSummary(state, derived, dispatch));
    main.push(message.box);

    const clearBlock = () => { selectedBlock = null; rerender(); };
    const blockSelection = selectedBlock
      ? (() => {
          for (const day of agenda) {
            const entry = day.entries.find(item => item.kind === 'busy' && `${day.date}|${item.start}|${item.end}` === selectedBlock);
            if (entry) return { key: selectedBlock, entry, day, dayIndex: day.index };
          }
          return null;
        })()
      : null;

    main.push(
      h('section', { className: 'week-agenda', 'aria-label': 'Week timetable' },
        h('div', { className: 'week-range' },
          h('span', { className: 'week-range-label' }, rangeLabel(derived)),
          h('span', { className: 'week-range-count' }, `Week ${derived.weekIndex + 1} of ${totalWeeks}`),
          h('span', { className: 'week-pager' },
            h('button', {
              type: 'button', className: 'link-button', disabled: derived.weekIndex <= 0,
              onClick: () => { selectedDay = null; selectedBlock = null; dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex - 1 }); }
            }, 'Previous week'),
            h('button', {
              type: 'button', className: 'link-button',
              disabled: derived.weekIndex >= Math.min(LOADED_WEEKS - 1, derived.maxWeekIndex),
              onClick: () => { selectedDay = null; selectedBlock = null; dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex + 1 }); }
            }, 'Next week'))),
        renderStrip(agenda, picked, today, () => { selectedBlock = null; rerender(); }),
        blockSelection ? renderBlockDetail(blockSelection, dispatch, clearBlock) : null,
        renderWeekGrid({
          agenda, picked, today, sleep: state.sleep, selectedBlock,
          onEmptyClick: (day, minutes) => { selectedDay = day; selectedBlock = null; openBusyForm(day, minutes); rerender(); document.getElementById('week-busy-form')?.scrollIntoView?.({ block: 'nearest' }); },
          onSelectBlock: selection => { selectedBlock = selection?.key ?? null; pendingFocus = selection ? '#block-remove' : null; rerender(); }
        }),
        h('ul', { className: 'wg-legend', 'aria-hidden': 'true' },
          h('li', {}, h('i', { className: 'swatch busy' }), 'Busy'),
          h('li', {}, h('i', { className: 'swatch sage' }), 'Free to work'),
          h('li', {}, h('i', { className: 'swatch amber' }), 'Planned deadline work'),
          h('li', {}, h('i', { className: 'swatch sleep' }), 'Protected sleep')),
        h('details', { className: 'quiet-details', id: 'free-details' },
          h('summary', {}, 'How free time is counted'),
          h('p', { className: 'section-help' }, 'Each day: work hours, minus time that has already passed, minus classes and busy blocks, minus protected sleep, minus work already planned. Class times are rounded out to the half hour, the way the check counts them.'),
          renderFreeTable(agenda))
      )
    );
  }

  side.push(renderTodoPanel(state, derived, dispatch, message, rerender));
  side.push(renderBusyPanel({ state, agenda, picked, dispatch, message, rerender }));

  if (hasHours) {
    main.push(
      h('details', { className: 'quiet-details', id: 'schedule-details' },
        h('summary', {}, 'Schedule details'),
        h('p', { className: 'section-help' },
          `Protected sleep ${state.sleep.start}–${state.sleep.end} (${fmtMinutes(plannedSleepMinutes(state.sleep))} a night) is taken out first.`),
        renderEstimateTable(state, derived),
        renderTimeline({
          scheduleResult: derived.evaluation.typical,
          days: derived.planDays ?? state.days,
          sleep: state.sleep,
          dayIndices: derived.week.dayIndices,
          tasks: derived.activeTasks,
          title: `Week ${derived.weekIndex + 1} in 30-minute slots`,
          kicker: 'SCHEDULE DETAILS',
          isPreview: false
        })
      )
    );
  }

  side.push(
    h('nav', { className: 'week-links', 'aria-label': 'More from My week' },
      h('button', {
        type: 'button', id: 'link-review', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'feedback' })
      }, 'Past estimates'),
      h('button', {
        type: 'button', id: 'link-settings', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
      }, 'Sleep and work hours'),
      derived.evaluation.verdict !== 'feasible'
        ? h('button', {
            type: 'button', id: 'link-reset', className: 'link-button',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
          }, 'See what can move')
        : null
    )
  );

  container.replaceChildren(
    h('div', { className: 'week-layout' },
      h('div', { className: 'week-main' }, main),
      h('div', { className: 'week-side' }, side)));
  if (pendingFocus) {
    const target = container.querySelector(pendingFocus);
    pendingFocus = null;
    target?.focus();
  }
}
