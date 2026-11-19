import { defaultRange, taskDates, uniqueId } from './commitments.mjs';
import { dateAt, dayNumber, weekday } from './dates.mjs';
import { formatTime } from './capacity.mjs';
import { isHalfHour } from './scheduler.mjs';

export function parsePastedTasks(text, days, {existingIds = []} = {}) {
  const data = [];
  const warnings = [];
  if (typeof text !== 'string' || !Array.isArray(days)) return {data, warnings: ['Provide task text and loaded days.']};
  const ids = new Set(existingIds);
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    if (!line.trim()) continue;
    try {
      const [title, rawHours, deadline, tag, latest, ...extra] = line.split('|').map(s => s.trim());
      if (!title || extra.length) throw Error('Use Title | hours | deadline | priority | optional latest date.');
      const likely = Number(rawHours?.replace(/h$/i, ''));
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)\s*h?$/i.test(rawHours ?? '') || !isHalfHour(likely) || likely === 0) {
        throw Error('Hours must be positive and use half-hour increments.');
      }
      const dates = taskDates(days, deadline, tag?.toLowerCase() || 'must-keep', latest);
      const slug = title.toLowerCase().replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'task';
      const id = uniqueId(`import-${index + 1}-${slug}`, ids);
      data.push({id, title, type:'other', likely, ...defaultRange(likely), ...dates, splittable:true, isProposal:false});
    } catch (error) {
      warnings.push(`Line ${index + 1}: ${error.message}`);
    }
  }
  return {data, warnings};
}

const DAY_SECONDS = 86400;
const KOLKATA_SECONDS = 19800;
const EVENT_LIMIT = 2000;

function calendarTime(value, params = '') {
  const zone = /(?:^|;)TZID=([^;]+)/i.exec(params)?.[1]?.replace(/^"|"$/g, '');
  if (zone && zone !== 'Asia/Kolkata') throw Error(`Unsupported time zone ${zone}.`);
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match || /(?:^|;)VALUE=DATE(?:;|$)/i.test(params)) throw Error('All-day or malformed event time is unsupported.');
  const [,year,month,date,hour,minute,second,z] = match;
  const day = dayNumber(`${year}-${month}-${date}`);
  if (!Number.isFinite(day) || +hour > 23 || +minute > 59 || +second > 59 || (z && zone)) throw Error('Invalid event timestamp.');
  const clock = +hour * 3600 + +minute * 60 + +second;
  return {day, clock, offset: z ? KOLKATA_SECONDS : 0, local: day * DAY_SECONDS + clock + (z ? KOLKATA_SECONDS : 0)};
}

function eventFields(text) {
  const events = [];
  let current;
  for (const raw of text.replace(/(?:\r\n|\n|\r)[ \t]/g, '').split(/\r\n|\n|\r/)) {
    if (/^BEGIN:VEVENT$/i.test(raw)) {
      if (current) events.push({...current, incomplete:true});
      current = {exdates:[]};
    } else if (/^END:VEVENT$/i.test(raw) && current) {
      events.push(current);
      current = undefined;
    } else if (current) {
      const colon = raw.indexOf(':');
      if (colon < 0) continue;
      const [name, ...parameters] = raw.slice(0, colon).split(';');
      const property = {value:raw.slice(colon + 1), params:parameters.join(';')};
      switch (name.toUpperCase()) {
        case 'DTSTART': current.start = property; break;
        case 'DTEND': current.end = property; break;
        case 'RRULE': current.rule = property.value; break;
        case 'EXDATE': current.exdates.push(property); break;
        case 'RDATE':
        case 'EXRULE':
        case 'RECURRENCE-ID': current.unsupported = true; break;
      }
    }
    if (events.length > EVENT_LIMIT) break;
  }
  if (current) events.push({...current, incomplete:true});
  return events;
}

const weekdays = ['MO','TU','WE','TH','FR','SA','SU'];
function recurringStarts(event, start, firstDay, lastDay) {
  const rule = new Map();
  for (const entry of event.rule.split(';')) {
    const [key, value, extra] = entry.split('=');
    if (!['FREQ','BYDAY','INTERVAL','COUNT','UNTIL'].includes(key) || !value || extra !== undefined || rule.has(key)) {
      throw Error('Unsupported recurrence pattern.');
    }
    rule.set(key, value);
  }
  if (rule.get('FREQ') !== 'WEEKLY' || (rule.has('COUNT') && rule.has('UNTIL'))) throw Error('Unsupported recurrence pattern. Use weekly recurrence with COUNT or UNTIL.');
  const positive = key => {
    const value = rule.get(key) ?? '1';
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value < 1) throw Error(`Invalid recurrence ${key}.`);
    return +value;
  };
  const interval = positive('INTERVAL');
  const count = rule.has('COUNT') ? positive('COUNT') : Infinity;
  const until = rule.has('UNTIL') ? calendarTime(rule.get('UNTIL')).local : Infinity;
  const startWeekday = (weekday(start.day) + 6) % 7;
  const byDay = rule.has('BYDAY') ? rule.get('BYDAY').split(',').map(day => weekdays.indexOf(day)) : [startWeekday];
  if (byDay.includes(-1) || !byDay.includes(startWeekday)) throw Error('Unsupported BYDAY pattern. DTSTART must match the weekly rule.');
  const offsets = [...new Set(byDay)].sort((a,b) => a-b);
  const firstOffsets = offsets.filter(offset => offset >= startWeekday);
  const monday = start.day - startWeekday;
  const period = interval * 7;
  const exceptions = new Set(event.exdates.flatMap(({value,params}) =>
    value.split(',').map(date => calendarTime(date, params || event.start.params).local)));
  const result = [];
  const firstCycle = Math.max(0, Math.floor((firstDay - 1 - monday) / period));
  const lastCycle = Math.floor((lastDay - monday) / period);
  for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
    const days = cycle === 0 ? firstOffsets : offsets;
    const preceding = cycle === 0 ? 0 : firstOffsets.length + (cycle - 1) * offsets.length;
    for (const [index, offset] of days.entries()) {
      const local = (monday + period * cycle + offset) * DAY_SECONDS + start.clock + start.offset;
      if (preceding + index >= count || local > until) return result;
      if (!exceptions.has(local)) result.push(local);
    }
  }
  return result;
}

export function parseIcs(text, days) {
  const data = [];
  const warnings = [];
  if (typeof text !== 'string' || !Array.isArray(days)) return {data, warnings:['Provide calendar text and loaded days.']};
  const events = eventFields(text);
  const limit = 'Calendar exceeds the 2,000 event limit.';
  if (events.length > EVENT_LIMIT) return {data, warnings:[limit]};
  const indices = new Map(days.map((day, index) => [dayNumber(day?.date), index]).filter(([day]) => Number.isFinite(day)));
  const bounds = [...indices.keys()];
  let outside = 0;
  for (const [index, event] of events.entries()) {
    try {
      if (event.incomplete || !event.start || !event.end) throw Error('Missing event start or end, or incomplete event.');
      if (event.unsupported || (event.exdates.length && !event.rule)) throw Error('Unsupported recurrence pattern.');
      const start = calendarTime(event.start.value, event.start.params);
      const end = calendarTime(event.end.value, event.end.params);
      const duration = end.local - start.local;
      if (duration <= 0) throw Error('Invalid event duration.');
      if (Math.floor(start.local / DAY_SECONDS) !== Math.floor(end.local / DAY_SECONDS)) throw Error('Cross-midnight event is unsupported.');
      const occurrences = event.rule !== undefined ?
        recurringStarts(event,start,Math.min(...bounds),Math.max(...bounds)) : [start.local];
      let matched = false;
      for (const local of occurrences) {
        const day = Math.floor(local / DAY_SECONDS);
        if (!indices.has(day)) continue;
        matched = true;
        if (data.length === EVENT_LIMIT) return {data:[], warnings:[...warnings,limit]};
        const seconds = local - day * DAY_SECONDS;
        data.push({index:indices.get(day),date:dateAt(day),start:formatTime(Math.floor(seconds / 1800) * 30),
          end:formatTime(Math.ceil((seconds + duration) / 1800) * 30)});
      }
      if (!matched) outside++;
    } catch (error) {
      warnings.push(`Event ${index + 1}: ${error.message}`);
    }
  }
  if (outside) warnings.push(`${outside} events outside the loaded weeks were ignored.`);
  return {data, warnings};
}
