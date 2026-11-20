#!/usr/bin/env node
// Summarise a two-week pilot of The 25th Hour (SPEC.txt section 14). Descriptive only:
// counts and medians per participant. No significance tests, no p-values, no pooling claims.
//
// Usage:
//   node scripts/analyze-pilot.mjs --start 2026-11-23 [--diary diary.csv] P01.csv P02.csv ...
//
// - Each positional file is one participant's "Export feedback CSV" from Settings. The participant
//   code is the file name without extension (P01.csv -> P01); the app stores no names.
// - --start is the first morning of week 1 (baseline). Week 2 (intervention) starts 7 days later.
// - --diary is the transcribed morning diary (docs/PILOT.md), one row per participant per morning:
//   participant,date,hours_slept,stress,minutes_in_app,fixes_seen,requests_sent,requests_approved,
//   accept_anyway,conflicts_flagged,conflicts_resolved_without_sleep
//   Sleep and stress come from the diary first; app sleep reports fill mornings with no diary entry.
// No dependencies; Node 20+.
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** RFC 4180 CSV -> array of objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter(r => r.some(cell => cell.trim() !== ''));
  const keys = header.map(h => h.trim());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const num = value => (value === '' || value === undefined || value === null ? NaN : Number(value));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Campus-local (Asia/Kolkata) calendar date of an ISO timestamp; local timestamps keep their date. */
export function campusDay(timestamp) {
  if (!timestamp) return '';
  if (/(Z|[+-]\d\d:?\d\d)$/.test(timestamp)) {
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 10) : '';
  }
  return timestamp.slice(0, 10);
}

/** Which pilot week a morning belongs to: 1, 2 or null (outside the pilot). */
export function weekOf(date, start) {
  if (!date) return null;
  if (date >= start && date <= addDays(start, 6)) return 1;
  if (date >= addDays(start, 7) && date <= addDays(start, 13)) return 2;
  return null;
}

/** Per-participant summary from that participant's app export rows and diary rows. */
export function summariseParticipant(id, exportRows, diaryRows, start) {
  const nights = new Map(); // date -> {hours, stress, source}
  for (const row of exportRows.filter(r => r.record_type === 'sleep_report')) {
    nights.set(row.id_or_date, { hours: num(row.actual_or_slept_hours), stress: num(row.stress), source: 'app' });
  }
  for (const row of diaryRows) {
    if (row.hours_slept === '' && row.stress === '') continue;
    nights.set(row.date, { hours: num(row.hours_slept), stress: num(row.stress), source: 'diary' });
  }
  const byWeek = week => [...nights].filter(([date]) => weekOf(date, start) === week).map(([, v]) => v);
  const sleepWeek = week => byWeek(week).map(v => v.hours).filter(Number.isFinite);
  const stressWeek = week => byWeek(week).map(v => v.stress).filter(Number.isFinite);

  const tasks = exportRows.filter(r => r.record_type === 'task_feedback');
  const pilotTasks = tasks.filter(r => weekOf(campusDay(r.recorded_at), start) !== null);
  const done = pilotTasks.map(r => ({ day: campusDay(r.recorded_at), target: r.target_date, hard: r.hard_date }));
  const withTarget = done.filter(t => t.target);
  const withHard = done.filter(t => t.hard || t.target);
  const errorsByType = {};
  for (const r of pilotTasks) {
    const est = num(r.estimated_or_planned_hours), actual = num(r.actual_or_slept_hours);
    if (est > 0 && Number.isFinite(actual)) (errorsByType[r.task_type || 'other'] ??= []).push(actual / est);
  }

  const changes = exportRows.filter(r => r.record_type === 'applied_change' && weekOf(campusDay(r.recorded_at), start) === 2);
  const week2Diary = diaryRows.filter(r => weekOf(r.date, start) === 2);
  const sum = key => week2Diary.reduce((total, r) => total + (Number.isFinite(num(r[key])) ? num(r[key]) : 0), 0);
  const reported = key => week2Diary.some(r => r[key] !== '' && r[key] !== undefined);
  const selfServe = changes.filter(r => r.change_kind === 'self_serve').length;
  const approvedApplied = changes.filter(r => r.change_kind === 'approved').length;

  return {
    id,
    sleep: { week1: median(sleepWeek(1)), n1: sleepWeek(1).length, week2: median(sleepWeek(2)), n2: sleepWeek(2).length },
    stress: { week1: median(stressWeek(1)), n1: stressWeek(1).length, week2: median(stressWeek(2)), n2: stressWeek(2).length },
    deadlines: {
      targetMet: withTarget.filter(t => t.day <= t.target).length, targetTotal: withTarget.length,
      hardMet: withHard.filter(t => t.day <= (t.hard || t.target)).length, hardTotal: withHard.length
    },
    estimateError: Object.fromEntries(Object.entries(errorsByType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([type, ratios]) => [type, { median: median(ratios), n: ratios.length }])),
    process: {
      repairsApplied: changes.length, selfServe, approvedApplied,
      fixesSeen: reported('fixes_seen') ? sum('fixes_seen') : null,
      requestsSent: reported('requests_sent') ? sum('requests_sent') : null,
      requestsApproved: reported('requests_approved') ? sum('requests_approved') : null,
      acceptAnyway: reported('accept_anyway') ? sum('accept_anyway') : null,
      conflictsFlagged: reported('conflicts_flagged') ? sum('conflicts_flagged') : null,
      conflictsResolved: reported('conflicts_resolved_without_sleep') ? sum('conflicts_resolved_without_sleep') : null,
      minutesInApp: median(week2Diary.map(r => num(r.minutes_in_app)))
    }
  };
}

const h = value => (value === null || value === undefined ? 'n/a' : `${Number(value.toFixed(2))}h`);
const plain = value => (value === null || value === undefined ? 'n/a' : String(Number(value.toFixed(2))));
const ratio = (a, b) => (a === null || b === null ? 'n/a (not in diary)' : b === 0 ? 'none recorded' : `${a} of ${b} (${Math.round((100 * a) / b)}%)`);
const nights = n => `${n} ${n === 1 ? 'night' : 'nights'}`;
const signed = value => (value === null ? 'n/a' : `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}h`);

export function formatReport(summaries, start) {
  const lines = [
    `The 25th Hour pilot summary. Week 1 (baseline) ${start} to ${addDays(start, 6)}; week 2 (app) ${addDays(start, 7)} to ${addDays(start, 13)}.`,
    `Participants: ${summaries.length}. Descriptive counts and medians only; no statistical significance is claimed.`,
    ''
  ];
  for (const s of summaries) {
    const change = s.sleep.week1 !== null && s.sleep.week2 !== null ? s.sleep.week2 - s.sleep.week1 : null;
    const p = s.process;
    const adoption = p.fixesSeen === null ? null : p.repairsApplied + (p.requestsSent ?? 0);
    lines.push(
      `Participant ${s.id}`,
      `  Sleep, median per night (primary outcome): week 1 ${h(s.sleep.week1)} (${nights(s.sleep.n1)}) -> week 2 ${h(s.sleep.week2)} (${nights(s.sleep.n2)}); change ${signed(change)}`,
      `  Stress, median 1-5:                        week 1 ${plain(s.stress.week1)} (${s.stress.n1}) -> week 2 ${plain(s.stress.week2)} (${s.stress.n2})`,
      `  Deadlines met (tasks completed in pilot):  target ${ratio(s.deadlines.targetMet, s.deadlines.targetTotal)}; hard ${ratio(s.deadlines.hardMet, s.deadlines.hardTotal)}`,
      `  Estimate error, actual/estimated median:   ${Object.entries(s.estimateError).map(([type, e]) => `${type} ${plain(e.median)}x (n=${e.n})`).join(', ') || 'n/a'}`,
      `  Repairs applied in week 2 (app export):    ${p.repairsApplied} (${p.selfServe} self-serve, ${p.approvedApplied} after approval)`,
      `  Repair adoption (applied + requested / seen): ${ratio(adoption, p.fixesSeen)}`,
      `  Approval success (approved / sent):        ${ratio(p.requestsApproved, p.requestsSent)}`,
      `  Infeasible accepts ("Accept anyway"):      ${p.acceptAnyway === null ? 'n/a (not in diary)' : p.acceptAnyway}`,
      `  Conflicts resolved without using sleep:    ${ratio(p.conflictsResolved, p.conflictsFlagged)}`,
      `  Minutes in app per day, median (week 2):   ${p.minutesInApp === null ? 'n/a' : plain(p.minutesInApp)}`,
      ''
    );
  }
  const changes = summaries.map(s => (s.sleep.week1 !== null && s.sleep.week2 !== null ? s.sleep.week2 - s.sleep.week1 : null)).filter(v => v !== null);
  lines.push(
    `Across participants: ${changes.filter(v => v > 0).length} slept more (median), ${changes.filter(v => v < 0).length} slept less, ${changes.filter(v => v === 0).length} no change, ${summaries.length - changes.length} without both weeks. Median of per-participant changes: ${signed(median(changes))}.`,
    '',
    'Reporting rules (SPEC.txt section 14):',
    '- Report these counts and medians per participant. Do not claim statistical significance with this sample size.',
    '- There is no control group; week 2 may differ for reasons unrelated to the app (exam timing, for example).',
    '- "Conflicts resolved" is a process metric and is not evidence that sleep improved. Sleep change is a separate result.',
    '- A feasible schedule creates an opportunity to sleep; it does not guarantee sleep.'
  );
  return lines.join('\n');
}

async function main(argv) {
  let start = null, diaryPath = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--start') start = argv[++i];
    else if (argv[i] === '--diary') diaryPath = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') { files.length = 0; start = null; break; }
    else files.push(argv[i]);
  }
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start) || (!files.length && !diaryPath)) {
    console.error('Usage: node scripts/analyze-pilot.mjs --start YYYY-MM-DD [--diary diary.csv] P01.csv [P02.csv ...]');
    process.exitCode = 2;
    return;
  }
  const diary = diaryPath ? parseCsv(await readFile(diaryPath, 'utf8')) : [];
  const exports = new Map();
  for (const file of files) exports.set(basename(file, extname(file)), parseCsv(await readFile(file, 'utf8')));
  const ids = [...new Set([...exports.keys(), ...diary.map(r => r.participant).filter(Boolean)])].sort();
  const summaries = ids.map(id => summariseParticipant(id, exports.get(id) ?? [], diary.filter(r => r.participant === id), start));
  console.log(formatReport(summaries, start));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2));
