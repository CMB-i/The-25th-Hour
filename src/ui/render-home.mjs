import { h, setBlobTone } from './dom.mjs';
import { buildHero, buildRecents, buildWeekStrip, observeWeek } from './home-model.mjs';
import { hasWorkWindows } from './hours-editor.mjs';
import { renderRequestForm } from './request-form.mjs';
import { focusWeekSection, openWeekBusy } from './render-week.mjs';

export { observeWeek };

/** No timetable evidence: nothing imported and no busy blocks entered. */
function lacksTimetable(state) {
  return !state.calendarImportedAt && !state.days.some(day => (day.busyWindows ?? []).length);
}

function renderStrip(strip) {
  return h('div', { className: 'weekstrip', role: 'img', 'aria-label': strip.label, id: 'week-strip' },
    h('div', { className: 'weekstrip-bars' },
      strip.cols.map(col =>
        h('div', { className: 'wk-col' },
          h('div', { className: 'wk-cap', style: `height:${Math.max(4, Math.round((col.cap / strip.maxCap) * 100))}%` },
            h('div', {
              className: `wk-used${col.over ? ' is-over' : ''}`,
              style: `height:${col.over || !col.cap ? 100 : Math.round((col.used / col.cap) * 100)}%`
            })))),
    ),
    h('div', { className: 'weekstrip-labels', 'aria-hidden': 'true' },
      strip.cols.map(col => h('span', { className: col.isToday ? 'is-today' : '' }, col.label))),
    h('div', { className: 'weekstrip-hours', 'aria-hidden': 'true' },
      strip.cols.map(col => h('span', { className: col.over ? 'is-over' : '' }, col.past ? 'Past' : col.cap > 0 ? `${Math.round(col.freeHours * 10) / 10}h` : '–'))),
    h('p', { className: 'weekstrip-note', 'aria-hidden': 'true' }, 'Free hours left each day, after classes, sleep and planned work.'),
    h('div', { className: 'legend-row', 'aria-hidden': 'true' },
      h('span', {}, h('i', { className: 'swatch sage' }), 'Planned'),
      h('span', {}, h('i', { className: 'swatch line' }), 'Room to work'),
      h('span', {}, h('i', { className: 'swatch coral' }), 'Over'))
  );
}

function renderRecents(state, dispatch) {
  const recents = buildRecents(state);
  return h('section', { className: 'recents', id: 'recent-checks', 'aria-labelledby': 'recent-title' },
    h('div', { className: 'recent-head' },
      h('h2', { id: 'recent-title', className: 'section-title' }, 'Recent checks'),
      h('button', {
        type: 'button', id: 'home-yeses', className: 'link-button',
        onClick: () => dispatch({ type: 'NAVIGATE', screen: 'feedback' })
      }, 'What my yeses cost')
    ),
    recents.length
      ? h('ul', { className: 'recent-list' },
          recents.map(item =>
            h('li', { className: 'recent-row' },
              h('div', { className: 'recent-main' },
                h('div', { className: 'recent-title' }, item.title),
                h('div', { className: 'recent-meta' }, item.meta)),
              h('span', { className: `pill ${item.status}` }, item.label))))
      : h('p', { className: 'voice-line' }, 'Nothing checked yet. When someone asks for something, start above.')
  );
}

/**
 * Home: a one-line read on the week, the week at a glance, and the form for the next yes.
 */
export function renderHomeScreen(container, ctx) {
  const { state, derived, dispatch } = ctx;
  const rerender = () => renderHomeScreen(container, ctx);
  const now = new Date();
  const hero = buildHero({ state, derived, now });
  const strip = buildWeekStrip({ state, derived, now });
  const pending = state.proposals[0] ?? null;
  setBlobTone(hero.kind === 'short' ? 'coral' : 'coral');

  const left = [];
  const right = [];
  const parts = left;
  if (!hasWorkWindows(state.days)) {
    parts.push(
      h('div', { className: 'firstrun-card', id: 'firstrun-card' },
        h('p', {}, 'Set up your sleep, work hours and classes in a minute, so every check is trustworthy.'),
        h('button', {
          type: 'button', id: 'firstrun-start', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'start' })
        }, 'Set up'))
    );
  }

  parts.push(
    h('div', { className: 'hero' },
      h('div', { className: 'eyebrow', id: 'home-eyebrow' }, hero.eyebrow),
      h('h1', { id: 'home-observation', className: 'hero-title' }, hero.title),
      h('p', { className: 'hero-sub' }, hero.sub),
      hero.link
        ? h('button', {
            type: 'button', id: 'home-set-hours', className: 'link-button',
            onClick: () => { focusWeekSection('#week-hours-start'); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
          }, hero.link)
        : hero.observation?.atRisk
        ? h('button', {
            type: 'button', id: 'home-reset', className: 'link-button',
            onClick: () => dispatch({ type: 'NAVIGATE', screen: 'rescue' })
          }, 'See what can move')
        : hero.kind === 'slack'
          ? h('button', {
              type: 'button', id: 'home-adds-up', className: 'link-button',
              onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
            }, 'See how it adds up')
          : null
    )
  );

  if (strip.hasData) right.push(renderStrip(strip));

  if (pending) {
    parts.push(
      h('div', { className: 'return-banner' },
        h('span', {}, `You're checking "${pending.title}".`),
        h('button', {
          type: 'button', id: 'back-to-request', className: 'link-button',
          onClick: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
        }, 'Back to your request'))
    );
  } else {
    parts.push(
      renderRequestForm({
        state, derived, dispatch, pending: null, rerender,
        onSubmitted: () => dispatch({ type: 'NAVIGATE', screen: 'check' })
      })
    );
  }

  right.push(renderRecents(state, dispatch));

  const quiet = [];
  if (lacksTimetable(state)) {
    quiet.push(
      h('p', { id: 'home-timetable', className: 'quiet-line' },
        'Add your timetable for a more accurate check. ',
        h('button', {
          type: 'button', id: 'home-timetable-link', className: 'link-button',
          onClick: () => { openWeekBusy(); dispatch({ type: 'NAVIGATE', screen: 'week' }); }
        }, 'Add it in My week'))
    );
  }
  quiet.push(
    h('button', {
      type: 'button', id: 'home-week', className: 'link-button',
      onClick: () => dispatch({ type: 'NAVIGATE', screen: 'week' })
    }, 'View my week')
  );
  left.push(h('div', { className: 'home-quiet' }, quiet));
  container.replaceChildren(h('div', { className: 'home-layout' },
    h('div', { className: 'home-left' }, left),
    h('div', { className: 'home-right' }, right)));
}
