import { weekdayName } from '../engine/dates.mjs';
import { deadlineCost, verdictText } from '../engine/evaluate.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Safely creates a DOM element without innerHTML. Strings and numbers become text nodes.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'className') {
        el.className = String(value);
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [dataKey, dataVal] of Object.entries(value)) {
          if (dataVal !== undefined && dataVal !== null) el.dataset[dataKey] = String(dataVal);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'disabled' || key === 'checked' || key === 'hidden' || key === 'required') {
        el[key] = Boolean(value);
      } else if (key === 'value') {
        el.value = String(value);
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  const append = item => {
    if (item === undefined || item === null || item === false) return;
    if (Array.isArray(item)) {
      item.forEach(append);
    } else if (typeof item === 'string' || typeof item === 'number') {
      el.append(document.createTextNode(String(item)));
    } else {
      el.append(item);
    }
  };
  append(children);
  return el;
}

export function fmtHours(hours) {
  if (!Number.isFinite(hours)) return '0h';
  const rounded = Math.round(hours * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${text}h`;
}

export function fmtMinutes(minutes) {
  return fmtHours(minutes / 60);
}

export function fmtSignedHours(hours) {
  if (!Number.isFinite(hours) || hours === 0) return '0h';
  return hours < 0 ? `−${fmtHours(-hours)}` : `+${fmtHours(hours)}`;
}

export function fmtShortWeekday(date) {
  return weekdayName(date).slice(0, 3);
}

export function fmtShortDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return String(date ?? '');
  const monthIndex = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  return `${day} ${MONTHS[monthIndex] ?? date.slice(5, 7)}`;
}

export function fmtTimestamp(iso) {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return String(iso);
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(parsed)) + ' IST';
  } catch {
    return String(iso);
  }
}

export function taskTag(task) {
  if (task?.allowDrop) return 'droppable';
  if (task?.flexible) return 'flexible';
  return 'must-keep';
}

export function taskTagLabel(tag) {
  return {
    'must-keep': 'Must-keep',
    flexible: 'Flexible',
    droppable: 'Droppable'
  }[tag] ?? 'Must-keep';
}

export function verdictLabel(verdict) {
  return {
    feasible: 'Fits',
    'at-risk': 'Tight',
    infeasible: "Doesn't fit"
  }[verdict] ?? String(verdict ?? '');
}

export function verdictIcon(verdict) {
  return {
    feasible: '✓',
    'at-risk': '▲',
    infeasible: '✕'
  }[verdict] ?? '•';
}

export function verdictClass(verdict) {
  return {
    feasible: 'good',
    'at-risk': 'risk',
    infeasible: 'alert'
  }[verdict] ?? 'good';
}

/**
 * Builds truthful SPEC section 8 verdict copy directly from engine numbers,
 * never hard-coding Thursday and never saying "fits" unless typical.feasible.
 */
export function buildVerdictCopy(evaluation, days) {
  const headline = verdictText(evaluation, days);

  if (evaluation.verdict === 'feasible') {
    return {
      headline,
      body: 'Every deadline is met even if tasks run long, with at least 1h to spare.',
      contributingText: '',
      releaseNote: ''
    };
  }

  if (evaluation.verdict === 'at-risk') {
    const cons = deadlineCost(evaluation.conservative, days);
    let body = 'Your estimates fit, with little room if things run long.';
    if (cons && cons.shortfallHours > 0) {
      body = `Your estimates fit. If tasks run long, ${cons.weekday} (${cons.date}) could be ${fmtHours(cons.shortfallHours)} short.`;
    } else if (cons) {
      body = `Your estimates fit. If tasks run long, ${cons.weekday} (${cons.date}) has only ${fmtHours(cons.marginHours)} to spare.`;
    }
    return {
      headline,
      body,
      contributingText: '',
      releaseNote: ''
    };
  }

  const typ = deadlineCost(evaluation.typical, days);
  if (!typ) {
    return {
      headline: "This plan can't meet its deadlines.",
      body: evaluation.reason || 'A deadline cannot be met with the available schedule.',
      contributingText: '',
      releaseNote: ''
    };
  }

  const body = `${typ.weekday} (${typ.date}): ${fmtHours(typ.requiredHours)} of work due, ${fmtHours(typ.availableHours)} available. Short by ${fmtHours(typ.shortfallHours)}.`;
  const contributingText = typ.tasks.length
    ? `Tasks due by ${typ.weekday}: ${typ.tasks.map(t => `${t.title} (${fmtHours(t.hours)})`).join(', ')}.`
    : '';
  const actualMissHours = evaluation.typical.lateMinutes / 60;
  const releaseNote = actualMissHours > typ.shortfallHours
    ? `After accounting for earliest start dates, ${fmtHours(actualMissHours)} falls after deadlines.`
    : '';

  return {
    headline: "This plan can't meet its deadlines.",
    body,
    contributingText,
    releaseNote
  };
}

export async function copyToClipboard(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below when clipboard permission is restricted.
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
