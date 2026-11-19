import { makeSlots, SLOT_MINUTES } from '../engine/capacity.mjs';
import { weekdayName } from '../engine/dates.mjs';
import { fmtMinutes, fmtShortDate, fmtShortWeekday, h } from './dom.mjs';

function slotCategory(task) {
  if (!task) return 'academic';
  if (task.isProposal || task.allowDrop) return 'proposal';
  if (task.flexible) return 'flexible';
  return 'academic';
}

function summarizeDayIntervals(daySlots, assignedByStart) {
  const groups = [];
  for (const slot of daySlots) {
    const alloc = assignedByStart.get(slot.start);
    const label = alloc ? `${alloc.taskTitle}${alloc.late ? ' (after target)' : ''}` : 'Free';
    const prev = groups[groups.length - 1];
    if (prev && prev.label === label && prev.endMinutes === slot.start) {
      prev.endMinutes = slot.end;
      prev.endLabel = slot.label.split('–')[1];
    } else {
      const [startLabel, endLabel] = slot.label.split('–');
      groups.push({ startLabel, endLabel, endMinutes: slot.end, label });
    }
  }
  return groups.map(g => `${g.startLabel}–${g.endLabel}: ${g.label}`);
}

/**
 * Renders the 30-minute timeline with color + text alternatives (title/aria-label + collapsible breakdown).
 */
export function renderTimeline({
  scheduleResult,
  days,
  sleep,
  dayIndices,
  tasks = [],
  title = 'Current week schedule',
  kicker = 'TIME ALLOCATION',
  isPreview = false
}) {
  const allSlots = makeSlots(days, sleep);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const slotsByDay = new Map();
  for (const slot of allSlots) {
    if (!slotsByDay.has(slot.dayIndex)) slotsByDay.set(slot.dayIndex, []);
    slotsByDay.get(slot.dayIndex).push(slot);
  }

  const rows = [];
  const summaryRows = [];

  for (const dayIndex of dayIndices) {
    const day = days[dayIndex];
    if (!day) continue;
    const daySlots = slotsByDay.get(dayIndex) ?? [];
    const byDayEntry = scheduleResult.byDay[dayIndex] ?? { assigned: [], capacity: 0 };
    const assignedByStart = new Map(byDayEntry.assigned.map(item => [item.start, item]));
    const bookedMinutes = byDayEntry.assigned.reduce((sum, item) => sum + item.minutes, 0);
    const capacityMinutes = daySlots.length * SLOT_MINUTES;
    const shortDay = fmtShortWeekday(day.date);
    const fullDay = weekdayName(day.date);

    const slotNodes = daySlots.map(slot => {
      const alloc = assignedByStart.get(slot.start);
      const task = alloc ? taskById.get(alloc.taskId) : null;
      const cls = ['slot'];
      if (alloc) {
        cls.push(slotCategory(task));
        if (alloc.late) cls.push('late');
      }
      const statusText = alloc
        ? `${alloc.taskTitle}${alloc.late ? ' (after deadline)' : ' (on time)'}`
        : 'Free capacity';
      const aria = `${fullDay} ${day.date} ${slot.label}: ${statusText}`;
      return h('div', {
        className: cls.join(' '),
        role: 'listitem',
        tabindex: '0',
        title: aria,
        'aria-label': aria
      });
    });

    const rowLabel = `${fullDay} ${day.date}: ${fmtMinutes(bookedMinutes)} scheduled of ${fmtMinutes(capacityMinutes)} available`;
    rows.push(
      h('div', { className: 'day-row' },
        h('div', { className: 'day-label' },
          h('strong', {}, shortDay),
          h('span', {}, fmtShortDate(day.date))
        ),
        daySlots.length
          ? h('div', { className: 'slot-line', role: 'list', 'aria-label': rowLabel }, slotNodes)
          : h('div', { className: 'slot-line empty-day' }, h('span', { className: 'slot-empty-text' }, 'No available work slots')),
        h('div', { className: 'day-cap', title: `${fmtMinutes(bookedMinutes)} booked / ${fmtMinutes(capacityMinutes)} available` },
          `${fmtMinutes(bookedMinutes)}/${fmtMinutes(capacityMinutes)}`
        )
      )
    );

    const intervals = daySlots.length ? summarizeDayIntervals(daySlots, assignedByStart) : ['No available work slots'];
    summaryRows.push(
      h('li', {},
        h('strong', {}, `${fullDay} (${fmtShortDate(day.date)}): `),
        intervals.join('; ')
      )
    );
  }

  return h('section', { className: `panel schedule-panel${isPreview ? ' is-preview' : ''}` },
    h('div', { className: 'panel-title-line' },
      h('div', {},
        h('span', { className: 'panel-label' }, kicker),
        h('h3', {}, title)
      ),
      h('span', { className: 'pill' }, isPreview ? 'Preview · 30-min slots' : '30-minute slots')
    ),
    h('div', { className: 'timeline-rows' }, rows),
    h('div', { className: 'legend', 'aria-label': 'Timeline legend' },
      h('span', {}, h('i', { className: 'key-color academic', 'aria-hidden': 'true' }), 'Must-keep'),
      h('span', {}, h('i', { className: 'key-color flexible', 'aria-hidden': 'true' }), 'Flexible'),
      h('span', {}, h('i', { className: 'key-color proposal', 'aria-hidden': 'true' }), 'Proposal / Optional'),
      h('span', {}, h('i', { className: 'key-color empty', 'aria-hidden': 'true' }), 'Free'),
      h('span', {}, h('i', { className: 'key-color late', 'aria-hidden': 'true' }), 'After deadline')
    ),
    h('details', { className: 'slot-details' },
      h('summary', {}, 'Text breakdown of 30-minute slots'),
      h('ul', { className: 'slot-summary-list' }, summaryRows)
    )
  );
}
