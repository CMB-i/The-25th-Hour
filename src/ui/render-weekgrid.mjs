// The week as a time grid: days across, hours down. The same markup serves both screens. On a desktop all
// seven day columns show side by side; on a phone CSS shows only the selected day as a vertical timeline.
// Everything drawn comes from the loaded days, the engine's schedule and the student's own sleep window.
import { h } from './dom.mjs';
import { clock12, hoursText, sleepRangesOf } from './week-model.mjs';

const clockOfMinutes = minutes => {
  if (minutes >= 1440) return '12:00 am';
  return clock12(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
};

/** "7:00 to 10:30 pm", saying am/pm once when both ends share it. */
export function rangeText(from, to) {
  const a = clockOfMinutes(from);
  const b = clockOfMinutes(to);
  const [ta, pa] = a.split(' ');
  const [tb, pb] = b.split(' ');
  return pa === pb ? `${ta} to ${tb} ${pb}` : `${a} to ${b}`;
}

/** Hours shown on the left. Starts at 8 am, earlier only when something in the week starts earlier. */
export function axisStart(agenda) {
  let first = 480;
  for (const day of agenda) {
    for (const entry of day.entries) first = Math.min(first, entry.from ?? first);
    for (const band of day.free.bands) first = Math.min(first, band.start);
  }
  return Math.floor(first / 60) * 60;
}

/**
 * Back-to-back blocks (one ends exactly when the next starts) are drawn as one joined strip:
 * each keeps its own name, but they share edges and corners.
 */
export function chainBusy(entries) {
  const busy = entries.filter(entry => entry.kind === 'busy').sort((a, b) => a.from - b.from);
  return busy.map((entry, i) => {
    const joinsBefore = i > 0 && busy[i - 1].to === entry.from;
    const joinsAfter = i < busy.length - 1 && busy[i + 1].from === entry.to;
    return { entry, joinsBefore, joinsAfter };
  });
}

const rows = (minutes, base) => `calc(var(--hour) * ${(minutes - base) / 60})`;
const place = (from, to, base) => `top:${rows(from, base)};height:calc(var(--hour) * ${(to - from) / 60})`;

function renderFreeBand(band, day, base) {
  const long = band.end - band.start >= 60;
  const hours = hoursText(band.end - band.start);
  const text = `Free to work ${rangeText(band.start, band.end)}, ${hours}`;
  return h('div', {
    className: `wg-free${long ? '' : ' is-short'}`, style: place(band.start, band.end, base),
    role: 'img', 'aria-label': `${day.weekday}: ${text}`, title: text
  },
    long
      ? [h('span', { className: 'wg-free-title' }, 'Free to work'), h('span', { className: 'wg-free-time' }, `${rangeText(band.start, band.end)}, ${hours}`)]
      : h('span', { className: 'wg-free-title' }, `Free ${hours}`));
}

function renderBusyBlock({ entry, joinsBefore, joinsAfter }, day, base, state) {
  const key = `${day.date}|${entry.start}|${entry.end}`;
  const selected = state.selectedBlock === key;
  const classes = ['wg-busy'];
  if (joinsBefore) classes.push('joins-before');
  if (joinsAfter) classes.push('joins-after');
  if (selected) classes.push('is-selected');
  return h('button', {
    type: 'button', className: classes.join(' '), style: place(entry.from, entry.to, base),
    'aria-pressed': String(selected),
    'aria-label': `${entry.label}${entry.room ? `, ${entry.room}` : ''}, ${day.weekday} ${entry.time}. Busy. Press for details.`,
    title: `${entry.label}${entry.room ? `, ${entry.room}` : ''}, ${entry.time}`,
    onClick: () => state.onSelectBlock(selected ? null : { key, dayIndex: day.index, entry, day })
  },
    h('span', { className: 'wg-name' }, entry.label),
    entry.room ? h('span', { className: 'wg-room' }, entry.room) : null,
    h('span', { className: 'wg-time' }, rangeText(entry.shownFrom ?? entry.from, entry.shownTo ?? entry.to)));
}

function renderWork(entry, day, base) {
  return h('div', {
    className: `wg-work${entry.late ? ' is-late' : ''}`, style: place(entry.from, entry.to, base),
    role: 'img', 'aria-label': `${day.weekday}: deadline work, ${entry.label}, ${entry.time}`, title: `${entry.label}, ${entry.time}`
  },
    h('span', { className: 'wg-name' }, entry.label),
    h('span', { className: 'wg-meta' }, `Deadline work · ${entry.time}`));
}

/**
 * The shortfall, drawn once, at the end of the deadline day, above the sleep band (it ends where sleep starts,
 * so it never overlaps sleep). It stands in for work that does not fit; nothing is planned after the deadline.
 */
function renderShortMarker(day, base, sleep) {
  if (!day.shortHours) return null;
  const sleepStart = sleepRangesOf(sleep).map(([a]) => a).find(a => a > base) ?? 1440;
  const bottom = Math.min(1440, sleepStart);
  const height = Math.min(Math.max(day.shortHours, 0.5), 3) * 60;
  const top = Math.max(base, bottom - height);
  const text = `Short by ${hoursText(day.shortHours * 60)}`;
  return h('div', {
    className: 'wg-short', style: place(top, bottom, base), role: 'img',
    'aria-label': `${day.weekday}: ${text}. This much of the work does not fit before its deadline.`, title: text
  }, h('span', {}, text));
}

/** Time that has already gone by: hatched and labelled, never drawn as a Busy block. */
function renderPast(day, base) {
  const until = Math.min(1440, day.elapsedUntil || 0);
  if (!day.elapsed || until <= base) return null;
  const label = day.elapsed === 'past' ? 'Past' : 'Past, until now';
  return h('div', {
    className: `wg-past${day.elapsed === 'past' ? ' is-whole-day' : ''}`, style: place(base, until, base),
    role: 'img', 'aria-label': `${day.weekday}: ${day.elapsed === 'past' ? 'this day has passed' : 'the part of today that has passed'}. Not counted as free time.`
  }, h('span', {}, label));
}

function renderSleep(range, base, sleep) {
  return h('div', {
    className: 'wg-sleep', style: place(range[0], range[1], base), role: 'img',
    'aria-label': `Protected sleep ${clock12(sleep.start)} to ${clock12(sleep.end)}`
  }, range[1] - range[0] >= 60 ? h('span', {}, `Sleep from ${clock12(sleep.start)}`) : null);
}

/**
 * @param {object} args
 * @param {Array} args.agenda  buildAgenda() rows for the shown week
 * @param {number} args.picked  selected day index (phone shows only this one)
 * @param {number} args.today   today's index in the loaded days, or -1
 * @param {object} args.sleep   { start, end }
 * @param {string|null} args.selectedBlock  key of the busy block whose details are open
 * @param {(sel:object|null)=>void} args.onSelectBlock
 */
export function renderWeekGrid({ agenda, picked, today, sleep, selectedBlock, onSelectBlock, onEmptyClick = null }) {
  const base = axisStart(agenda);
  const hoursShown = (1440 - base) / 60;
  const sleepRanges = sleepRangesOf(sleep)
    .map(([a, b]) => [Math.max(a, base), b])
    .filter(([a, b]) => b > a);
  const ctx = { selectedBlock, onSelectBlock };

  const heads = agenda.map(day =>
    h('div', {
      className: `wg-head${day.index === picked ? ' is-selected' : ''}${day.index === today ? ' is-today' : ''}`
    },
      h('span', { className: 'wg-dayname' }, day.weekday.slice(0, 3)),
      h('span', { className: 'wg-daynum' }, day.date.slice(8).replace(/^0/, '')),
      h('span', { className: `wg-dayfree${day.shortHours ? ' is-short' : ''}` }, day.elapsed === 'past' ? 'Past' : day.shortHours ? `${hoursText(day.shortHours * 60)} short` : day.hasWindows ? `${hoursText(day.free.freeMinutes)} free` : 'No work hours'),
      day.due.length ? h('span', { className: 'wg-daydue' }, `${day.due.length} due`) : null));

  const columns = agenda.map(day =>
    h('div', {
      className: `wg-col${day.index === picked ? ' is-selected' : ''}${day.index === today ? ' is-today' : ''}`,
      role: 'group', 'aria-label': `${day.weekday} ${day.label.split(' ').slice(1).join(' ')}`,
      onClick: ev => {
        // An empty spot: the column itself, a free band or the sleep band, never a block.
        if (!onEmptyClick || ev.target.closest('.wg-busy, .wg-work')) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        const minutes = base + ((ev.clientY - rect.top) / rect.height) * hoursShown * 60;
        onEmptyClick(day.index, minutes);
      }
    },
      renderPast(day, base),
      renderShortMarker(day, base, sleep),
      sleepRanges.map(range => renderSleep(range, base, sleep)),
      day.free.bands.map(band => renderFreeBand(band, day, base)),
      chainBusy(day.entries).map(item => renderBusyBlock(item, day, base, ctx)),
      day.entries.filter(entry => entry.kind === 'work').map(entry => renderWork(entry, day, base)),
      day.hasWindows ? null : h('p', { className: 'wg-nohours' }, 'No work hours set for this day.')));

  const axis = h('div', { className: 'wg-axis', 'aria-hidden': 'true' },
    Array.from({ length: hoursShown }, (_, i) => {
      const minutes = base + i * 60;
      const label = clockOfMinutes(minutes).replace(':00', '');
      return h('span', { style: `top:calc(var(--hour) * ${i})` }, label);
    }));

  return h('div', { className: 'wgrid', id: 'week-grid', style: `--rows:${hoursShown}` },
    h('div', { className: 'wg-headrow' }, h('div', { className: 'wg-corner' }), heads),
    h('div', { className: 'wg-body' }, axis, columns));
}

/** The arithmetic behind each day's free hours, as a small table. */
export function renderFreeTable(agenda) {
  return h('table', { className: 'free-table' },
    h('caption', { className: 'sr-only' }, 'How each day\'s free hours are worked out'),
    h('thead', {}, h('tr', {},
      ['Day', 'Work hours', 'Past', 'Busy', 'Sleep', 'Planned', 'Free'].map(text => h('th', { scope: 'col' }, text)))),
    h('tbody', {}, agenda.map(day =>
      h('tr', {},
        h('th', { scope: 'row' }, day.weekday.slice(0, 3)),
        h('td', {}, hoursText(day.free.windowMinutes)),
        h('td', {}, `−${hoursText(day.free.elapsedMinutes)}`),
        h('td', {}, `−${hoursText(day.free.busyMinutes)}`),
        h('td', {}, `−${hoursText(day.free.sleepMinutes)}`),
        h('td', {}, `−${hoursText(day.free.plannedMinutes)}`),
        h('td', { className: 'is-total' }, hoursText(day.free.freeMinutes))))));
}
