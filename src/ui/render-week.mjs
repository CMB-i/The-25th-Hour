import { plannedSleepMinutes } from '../engine/capacity.mjs';
import { deadlineCost } from '../engine/evaluate.mjs';
import { campusDate } from '../engine/feedback.mjs';
import { LOADED_WEEKS } from '../engine/weeks.mjs';
import { hoursPhrase } from './check-model.mjs';
import {
  buildVerdictCopy,
  fmtHours,
  fmtMinutes,
  fmtShortDate,
  fmtShortWeekday,
  fmtSignedHours,
  h,
  taskTag,
  taskTagLabel,
  verdictClass,
  verdictLabel
} from './dom.mjs';
import {
  calendarStatusText,
  createImportMessage,
  renderBusyForm,
  renderCalendarImport,
  renderPasteImport
} from './import-controls.mjs';
import { renderTimeline } from './render-timeline.mjs';
import { isSetUp } from './state.mjs';
import { buildAgenda, calendarStatus } from './week-model.mjs';

// Which day the phone-width agenda is showing. UI-only.
let selectedDay = null;
let pendingFocus = null;

function pickSelectedDay(state, derived) {
  const indices = derived.week.dayIndices;
  if (selectedDay !== null && indices.includes(selectedDay)) return selectedDay;
  const today = state.demo ? null : campusDate(new Date().toISOString());
  const todayIndex = today ? state.days.findIndex(day => day.date === today) : -1;
  selectedDay = indices.includes(todayIndex) ? todayIndex : indices[0];
  return selectedDay;
}

function renderSummary(state, derived, dispatch) {
  const { evaluation, weekly, repairs } = derived;
  const copy = buildVerdictCopy(evaluation, state.days);
  const cls = verdictClass(evaluation.verdict);
  const tone = cls === 'alert' ? 'short' : cls === 'risk' ? 'tight' : 'fits';
  const atRisk = evaluation.verdict !== 'feasible';

  if (!derived.activeTasks.length) {
    return h('section', { id: 'week-verdict', className: 'verdict-block verdict-fits', 'aria-live': 'polite' },
      h('p', { className: 'verdict-word verdict-word-fits' }, 'Nothing due'),
      h('h2', { className: 'verdict-headline week-headline' }, 'No deadlines in the weeks loaded.'),
      h('p', { className: 'verdict-detail' }, 'Check a request to see what it would cost, or add deadlines below.')
    );
  }

  return h('section', { id: 'week-verdict', className: `verdict-block verdict-${tone}`, 'aria-live': 'polite' },
    h('p', { className: `verdict-word verdict-word-${tone}` }, verdictLabel(evaluation.verdict)),
    h('h2', { className: 'verdict-headline week-headline' }, copy.headline),
    h('p', { className: 'verdict-detail' }, copy.body),
    copy.contributingText ? h('p', { className: 'verdict-note' }, copy.contributingText) : null,
    copy.releaseNote ? h('p', { className: 'verdict-note' }, copy.releaseNote) : null,
    h('p', { className: 'verdict-note' },
      `This week: ${fmtMinutes(weekly.requiredMinutes)} of work, ${fmtMinutes(weekly.capacityMinutes)} free after busy blocks and sleep.`),
    atRisk
      ? h('div', { className: 'section-actions' },
          h('button', {
            type: 'button',
            id: 'week-reset',
            className: 'button button-primary',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
          }, repairs.length ? 'See what can move' : 'See your options'))
      : null
  );
}

function renderStrip(agenda, picked, rerender) {
  return h('div', { className: 'date-strip', role: 'group', 'aria-label': 'Days this week' },
    agenda.map(day =>
      h('button', {
        type: 'button',
        className: `strip-day${day.index === picked ? ' is-selected' : ''}`,
        'aria-pressed': String(day.index === picked),
        onClick: () => { selectedDay = day.index; rerender(); }
      },
        h('span', { className: 'strip-weekday' }, day.weekday.slice(0, 3)),
        h('span', { className: 'strip-date' }, fmtShortDate(day.date).split(' ')[0]),
        day.due.length ? h('span', { className: 'strip-due' }, `${day.due.length} due`) : null
      ))
  );
}

function renderAgenda(agenda, picked) {
  return h('div', { className: 'agenda', id: 'agenda' },
    agenda.map(day =>
      h('article', {
        className: `agenda-day${day.index === picked ? ' is-selected' : ''}`,
        'aria-label': day.label
      },
        h('h3', {}, day.label),
        day.due.length
          ? h('ul', { className: 'agenda-due' },
              day.due.map(item =>
                h('li', {}, h('strong', {}, 'Due: '), `${item.title}, ${hoursPhrase(item.hours)}${item.isProposal ? ' (proposed)' : ''}`)))
          : null,
        day.entries.length
          ? h('ul', { className: 'agenda-entries' },
              day.entries.map(entry =>
                h('li', { className: `agenda-entry agenda-${entry.kind}` },
                  h('span', { className: 'agenda-time' }, entry.time),
                  h('span', { className: 'agenda-label' }, entry.label))))
          : h('p', { className: 'agenda-empty' },
              day.hasWindows ? `Nothing planned. ${hoursPhrase(day.freeHours)} free.` : 'No work hours set for this day.')
      ))
  );
}

function renderBusyPanel(state, agenda, dispatch, message) {
  const cal = calendarStatus(state);
  const blocks = agenda.filter(day => state.days[day.index].busyWindows.length);
  return h('section', { id: 'busy-panel', className: 'week-section' },
    h('h3', {}, 'When are you busy?'),
    h('p', { className: 'section-help' },
      'Fixed blocks like classes, shifts and appointments. They come off your free time before any work is planned.'),
    cal.kind === 'none'
      ? h('p', { className: 'status-line' },
          'No calendar has been imported. The check is using only the busy blocks you add here, your work hours and your sleep.')
      : h('p', { className: `status-line${cal.stale ? ' is-warning' : ''}` },
          cal.stale
            ? `${calendarStatusText(state)} That was over a day ago, so import it again before relying on this.`
            : calendarStatusText(state)),
    blocks.length
      ? h('ul', { className: 'plain-list' },
          blocks.map(day =>
            h('li', {},
              h('strong', {}, day.label),
              ': ',
              state.days[day.index].busyWindows.map(([start, end]) => `${start}–${end}`).join(', '))))
      : h('p', { className: 'agenda-empty' }, 'No busy blocks this week.'),
    h('details', { className: 'quiet-details', id: 'busy-edit' },
      h('summary', {}, 'Add or import busy time'),
      renderBusyForm({ days: agenda, dispatch, idPrefix: 'week-busy' }),
      renderCalendarImport({ state, dispatch, message })
    )
  );
}

function renderTodoPanel(state, derived, dispatch, message) {
  const inWeek = derived.activeTasks.filter(task => derived.week.dayIndices.includes(task.targetDay));
  const elsewhere = derived.activeTasks.length - inWeek.length;
  return h('section', { id: 'todo-panel', className: 'week-section' },
    h('h3', {}, 'What still needs doing?'),
    h('p', { className: 'section-help' },
      'Deadline work. It is planned into the free time left after busy blocks and sleep.'),
    inWeek.length
      ? h('ul', { className: 'plain-list' },
          inWeek.map(task => {
            const targetDate = state.days[task.targetDay]?.date;
            const hardDate = state.days[task.hardDay]?.date;
            return h('li', {},
              h('strong', {}, task.title),
              task.isProposal ? ' (proposed)' : '',
              `, ${hoursPhrase(task.likely)}, due ${fmtShortWeekday(targetDate)} ${fmtShortDate(targetDate)}`,
              task.hardDay !== task.targetDay && hardDate ? `, can slip to ${fmtShortWeekday(hardDate)}` : '',
              ` · ${taskTagLabel(taskTag(task))}`);
          }))
      : h('p', { className: 'agenda-empty' }, 'No deadline work due this week.'),
    elsewhere > 0
      ? h('p', { className: 'section-help' }, `${elsewhere} more due in other loaded weeks.`)
      : null,
    h('div', { className: 'section-actions' },
      h('button', {
        type: 'button', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      }, 'Check a new request')
    ),
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

function renderExampleView(state, derived, dispatch) {
  const { evaluation, weekly, bindingCost, repairs } = derived;
  const top = repairs[0];
  const schedulerTag = evaluation.typical.feasible
    ? 'Meets entered targets'
    : bindingCost
      ? `${fmtHours(bindingCost.shortfallHours)} short by ${bindingCost.weekday}`
      : `${fmtMinutes(evaluation.typical.lateMinutes)} deadline shortfall`;
  const rescueStatus = top
    ? (top.needsApproval ? 'Approval request needed' : 'Self-serve repair found')
    : (evaluation.verdict === 'feasible' ? 'No change needed' : evaluation.verdict === 'at-risk' ? 'Monitor narrow buffer' : 'No verified fix');
  return h('details', { className: 'quiet-details example-view', id: 'example-view' },
    h('summary', {}, 'Example view: three ways to check one week'),
    h('p', { className: 'section-help' }, 'Example data only. The same week, judged three ways.'),
    h('ul', { className: 'compare-list' },
      h('li', {},
        h('strong', {}, 'Weekly hours only (simulated baseline)'),
        h('span', {}, `${weekly.feasible ? 'Fits' : 'Over'}: ${fmtMinutes(weekly.requiredMinutes)} of ${fmtMinutes(weekly.capacityMinutes)} available this week. Ignores which hours fall before each deadline.`)),
      h('li', {},
        h('strong', {}, 'Deadline-aware scheduler (same allocation, no repair step)'),
        h('span', {}, `${evaluation.typical.feasible ? 'Fits' : 'Misses'}: ${schedulerTag}.`)),
      h('li', {},
        h('strong', {}, 'The 25th Hour'),
        h('span', {}, `${rescueStatus}. Tests changes against every deadline with sleep protected.`))
    ),
    h('div', { className: 'section-actions' },
      h('button', {
        type: 'button', className: `scenario-button button ${!state.fixed ? 'button-secondary' : 'button-quiet'}`,
        'aria-pressed': String(!state.fixed),
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: false })
      }, 'Flexible target (Scenario A)'),
      h('button', {
        type: 'button', className: `scenario-button button ${state.fixed ? 'button-secondary' : 'button-quiet'}`,
        'aria-pressed': String(state.fixed),
        onClick: () => dispatch({ type: 'LOAD_DEMO', fixed: true })
      }, 'All deadlines fixed (Scenario B)')
    ),
    h('div', { className: 'research-box' },
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
        h('span', {}, 'Include the sample research project')
      ),
      h('label', { for: 'demo-research-range' }, `Sample research project: ${fmtHours(state.researchHours)}`),
      h('input', {
        id: 'demo-research-range', className: 'hour-range', type: 'range', min: '4', max: '6', step: '0.5',
        value: String(state.researchHours), disabled: !state.includeResearch,
        'aria-label': 'Sample research project typical hours',
        onChange: ev => dispatch({
          type: 'UPDATE_DEMO_RESEARCH', includeResearch: state.includeResearch,
          researchHours: Number(ev.currentTarget.value)
        })
      })
    )
  );
}

/**
 * Renders My week: summary, a date strip with an agenda, the two kinds of input, and details.
 */
export function renderWeekScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const rerender = () => renderWeekScreen(container, ctx);
  const picked = pickSelectedDay(state, derived);
  const agenda = buildAgenda({ state, derived });
  const totalWeeks = Math.max(1, derived.maxWeekIndex + 1);
  const message = createImportMessage(state);
  const sleepMinutes = plannedSleepMinutes(state.sleep);
  const noWindows = !state.days.some(day => (day.workWindows ?? []).length);
  const pending = state.proposals[0];

  const banner = (text, label, screen, id) =>
    h('div', { className: 'return-banner' },
      h('span', {}, text),
      h('button', {
        type: 'button', id, className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen })
      }, label));

  const parts = [];
  parts.push(
    h('header', { className: 'week-head' },
      h('div', {},
        h('h1', { className: 'screen-title' }, 'My week'),
        h('p', { className: 'screen-lede' },
          `Week ${derived.weekIndex + 1} of ${totalWeeks}, ${fmtShortDate(derived.week.startDate)} to ${fmtShortDate(derived.week.endDate)}`)
      ),
      h('div', { className: 'week-pager' },
        h('button', {
          type: 'button', className: 'link-button',
          disabled: derived.weekIndex <= 0,
          onClick: () => { selectedDay = null; dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex - 1 }); }
        }, 'Previous week'),
        h('button', {
          type: 'button', className: 'link-button',
          disabled: derived.weekIndex >= Math.min(LOADED_WEEKS - 1, derived.maxWeekIndex),
          onClick: () => { selectedDay = null; dispatch({ type: 'SET_WEEK', weekIndex: derived.weekIndex + 1 }); }
        }, 'Next week')
      )
    )
  );

  if (pending) {
    parts.push(banner(`You're checking "${pending.title}".`, 'Back to your request', 'check', 'back-to-request'));
  }
  if (!state.demo && !isSetUp(state)) {
    parts.push(banner('Nothing is set up yet, so there is nothing to count.', 'Set up my week', 'settings', 'setup-week'));
  } else if (noWindows) {
    parts.push(banner('No work hours are set, so no work can be planned.', 'Set work hours', 'settings', 'set-hours'));
  }
  if (state.unresolvedConflict && !derived.evaluation.typical.feasible) {
    parts.push(h('p', { className: 'status-line is-warning' },
      'You added something that did not fit, so the gap below is still open.'));
  }

  parts.push(renderSummary(state, derived, dispatch));
  parts.push(message.box);

  parts.push(
    h('section', { className: 'week-agenda', 'aria-label': 'Agenda' },
      renderStrip(agenda, picked, rerender),
      renderAgenda(agenda, picked)
    )
  );

  parts.push(
    h('div', { className: 'week-inputs' },
      renderBusyPanel(state, agenda, dispatch, message),
      renderTodoPanel(state, derived, dispatch, message)
    )
  );

  parts.push(
    h('details', { className: 'quiet-details', id: 'schedule-details' },
      h('summary', {}, 'Schedule details'),
      h('p', { className: 'section-help' },
        `Protected sleep ${state.sleep.start}–${state.sleep.end} (${fmtMinutes(sleepMinutes)} a night) is taken out first.`),
      renderEstimateTable(state, derived),
      renderTimeline({
        scheduleResult: derived.evaluation.typical,
        days: state.days,
        sleep: state.sleep,
        dayIndices: derived.week.dayIndices,
        tasks: derived.activeTasks,
        title: `Week ${derived.weekIndex + 1} in 30-minute slots`,
        kicker: 'SCHEDULE DETAILS',
        isPreview: false
      })
    )
  );

  if (state.demo) parts.push(renderExampleView(state, derived, dispatch));

  parts.push(
    h('nav', { className: 'week-links', 'aria-label': 'More from My week' },
      h('button', {
        type: 'button', id: 'link-review', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'feedback' })
      }, 'Review how estimates went'),
      h('button', {
        type: 'button', id: 'link-settings', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'settings' })
      }, 'Settings'),
      derived.evaluation.verdict !== 'feasible'
        ? h('button', {
            type: 'button', id: 'link-reset', className: 'link-button',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
          }, 'See what can move')
        : null
    )
  );

  container.replaceChildren(...parts);
  if (pendingFocus) {
    container.querySelector(pendingFocus)?.focus();
    pendingFocus = null;
  }
}

/** Lets other screens open My week with a control focused. */
export function focusWeekSection(selector) {
  pendingFocus = selector;
}
