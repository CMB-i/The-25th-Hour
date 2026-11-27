// Class names for imported calendar blocks, kept on the UI side. The engine's parseIcs only returns times,
// so each VEVENT is parsed on its own with that same function and its SUMMARY/LOCATION are attached to
// the busy windows it produced. The stored busy-window shape the engine reads is never changed.
import { parseIcs } from '../engine/importers.mjs';

const MAX_LABEL = 80;

function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\[nN]/g, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "20261123T114000" -> "11:40". Only used to show the real class time, never to schedule. */
function clockOf(value) {
  const match = /T(\d{2})(\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1]}:${match[2]}` : '';
}

/** Splits unfolded ICS text into [{summary, location, from, to, text}] one entry per VEVENT. */
export function splitEvents(icsText) {
  const lines = String(icsText ?? '').replace(/(?:\r\n|\n|\r)[ \t]/g, '').split(/\r\n|\n|\r/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = { lines: [line], summary: '', location: '', from: '', to: '' };
    } else if (/^END:VEVENT$/i.test(line) && current) {
      current.lines.push(line);
      events.push(current);
      current = null;
    } else if (current) {
      current.lines.push(line);
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).split(';')[0].toUpperCase();
      const value = line.slice(colon + 1);
      if (name === 'SUMMARY') current.summary = unescapeText(value);
      else if (name === 'LOCATION') current.location = unescapeText(value);
      else if (name === 'DTSTART') current.from = clockOf(value);
      else if (name === 'DTEND') current.to = clockOf(value);
    }
  }
  return events;
}

/**
 * Map of `date|start|end` -> {title, room, from, to} for every busy window the calendar produced.
 * `start`/`end` are the engine's half-hour-rounded times; `from`/`to` are the real class times.
 */
export function extractBusyLabels(icsText, days) {
  const labels = {};
  for (const event of splitEvents(icsText)) {
    const title = event.summary.slice(0, MAX_LABEL);
    if (!title && !event.location) continue;
    const mini = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${event.lines.join('\r\n')}\r\nEND:VCALENDAR\r\n`;
    let parsed;
    try { parsed = parseIcs(mini, days); } catch { continue; }
    for (const entry of parsed.data) {
      const key = `${entry.date}|${entry.start}|${entry.end}`;
      if (labels[key]) continue;
      labels[key] = {
        title: title || 'Busy',
        room: event.location.slice(0, 40),
        from: event.from,
        to: event.to
      };
    }
  }
  return labels;
}

/** Old labels were plain strings; new ones are objects. Both read the same. */
export function labelInfo(value) {
  if (!value) return { title: 'Busy', room: '', from: '', to: '' };
  if (typeof value === 'string') return { title: value, room: '', from: '', to: '' };
  return { title: String(value.title || 'Busy'), room: String(value.room || ''), from: String(value.from || ''), to: String(value.to || '') };
}
