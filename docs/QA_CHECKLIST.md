# QA checklist: safety and privacy rules (SPEC.txt section 13)

The definition of done (section 16) requires each section 13 rule to have an automated test or a documented manual check. Each rule below names its automated test, its manual check, or both, with the latest result.

- **Automated, engine and state:** `tests/safety.test.mjs` (run by `node --test`). Test names start with the rule ID used here.
- **Automated, browser:** `tests/ui/browser-smoke.mjs` (T21–T24, `npm run test:ui`).
- **Manual:** run in Chrome against `python3 -m http.server 8000`, following the steps given.

Last run: 20 Nov 2026, branch `claude/25th-hour-qa-demo-7x0a2o`. Results: `node --test` 39/39 pass; `npm run test:ui` T21–T24 pass.

## Safety rules

| ID | Rule (section 13) | How it is checked | Result |
| --- | --- | --- | --- |
| S1a | Sleep is never used for work; the scheduler removes the window before allocating | T10 (golden scenario E values and 200 random sleep/work configurations, including windows that wrap midnight). `S1 no verified repair places work…`: no allocation at any estimate, for the plan or for any repair in scenarios A and B, falls inside three different sleep windows | Pass |
| S1b | No repair may shrink the sleep window | `S1 no verified repair…` asserts that every action is `move`/`drop`/`reduce`/`extend`; the engine has no action that touches `sleep` | Pass |
| S1c | The window changes only when the student edits it in Settings | `S1 the sleep window changes only through Settings`: applying a repair, undo, adding a proposal, accept anyway and a sleep report all leave `state.sleep` unchanged. In the reducer, only `SAVE_SETTINGS` writes `sleep` | Pass |
| S2a | An approval-dependent change never affects the evaluated plan until approval is recorded | T9; T20 (scope reduction); `S2 approval-dependent changes…` (engine rejects the action, including with a falsified `needsApproval: false`; the reducer rejects apply while pending or declined; recording approval alone leaves `hardDay = 3`; only an explicit apply sets `hardDay = 4`). Browser T21 walks the same path through the UI buttons | Pass |
| S2b | The app never sends messages; it only drafts text to copy | `P1 no network APIs…` (no `fetch`, XHR, beacon, WebSocket or `mailto:` in shipped code). T21 checks that **Copy approval request** fills the clipboard only. T23 asserts 0 external requests | Pass |
| S3a | The interface says "fits" only if the typical estimate fits | T15 (engine wording) and T21 (`#week-verdict` lacks "fits"/"almost no room" when infeasible) | Pass |
| S3b | Never states or implies a feasible plan guarantees sleep or lower stress | `S3 no copy claims…`: every "guarantee" in `src/` and `index.html` is negated ("can't guarantee"). Manual: read verdict, review and footer copy on all five screens; the only stress copy is the optional 1–5 rating | Pass |
| S4a | No streaks, scores, badges, countdown pressure or guilt wording about sleep | `S4 no streaks…` scans every UI string for banned wording. Manual: on all five screens in both scenarios there is no counter, timer, points or reward UI. Status pills ("Self-serve", "Learning (0 of 3)") are labels, not rewards | Pass |
| S4b | At most one optional in-app prompt per day (morning sleep report) | `S4 at most one sleep report per morning…` (a second entry for the same date replaces the first; skip stores nothing). Manual: the sleep form appears only on **Did It Work?**; it is not visible on the other four screens. The UI has no `Notification`, `setInterval` or reminder code (grep of `src/ui`). **Skip for today** records the skip and shows "Morning prompt skipped" without penalty | Pass |
| S5 | Override is always allowed; the conflict stays visible | `S5 Accept anyway…` (reducer accepts with `mode: 'override'`, sets `unresolvedConflict`, verdict stays infeasible). T22 uses **Accept anyway** three times. Manual: with a 6h proposal on Scenario A, **Accept anyway** is enabled; My Week then shows "Unresolved deadline conflict: You accepted a commitment while the schedule was infeasible." | Pass |

## Privacy rules

| ID | Rule (section 13) | How it is checked | Result |
| --- | --- | --- | --- |
| P1a | All data stays on the device under a versioned key | `P1/E2 saved data uses a versioned key…` (`the25thhour.v1`). T22 reload persistence | Pass |
| P1b | No network requests after load; no analytics or third-party scripts, fonts or images | T23 records every request: 0 external. `P1 no network APIs or external URLs…` scans `index.html` and `src/` for network APIs and `//host` references. Manual: a Playwright session through all screens made 22 requests, all to `127.0.0.1:8000` | Pass |
| P2a | "Clear all my data" in Settings | T22 (clears everything including feedback, survives reload). `P2 Clear all my data…` at reducer level | Pass |
| P2b | CSV export is manual and initiated by the student | Manual: export runs only from the **Export feedback CSV** button in Settings; no code path exports on a timer or on load (grep `buildFeedbackCsv`) | Pass |
| P3 | Store the minimum; no imported event titles beyond what the screen needs | `P3 imported calendar events keep times only…`: `parseIcs` output keys are exactly `index, date, start, end`, and a "Private therapy session" summary never appears in state | Pass |
| P4 | Professors/teammates see nothing unless the student copies it; copy only numbers the student ticks | `S2/P4 request drafts…`: without **Include my workload summary** the draft contains no workload numbers or other task names; with it, a single "Plan after the proposed change" line is added | Pass |
| P5 | First-run notice: "This is a planning tool, not medical advice, and not a treatment for sleep or anxiety problems." | `P5 the first-run notice…`: the exact sentence is in the page footer (visible on every screen from first load) and in the Settings header | Pass (fixed in this branch: before it, the footer showed only "not medical advice") |

## Engineering rules from section 13 (checked because they protect the claims above)

| ID | Rule | How it is checked | Result |
| --- | --- | --- | --- |
| E1 | Engine determinism: no `Date.now()`, argument-less `new Date()`, `Math.random()`, `localeCompare` or locale APIs; no DOM, storage or network | `E1 engine stays pure…` scans `src/engine/*.mjs`. T13 deep-equality and repeat-run checks | Pass |
| E2 | Versioned storage; a mismatch never crashes and the student is told | `P1/E2…`: malformed JSON, `schemaVersion` 0 or 2, a non-object and a throwing storage all give `state: null` plus "A fresh plan is open." | Pass |
| E3 | Engine errors are shown beside the field; a thrown error never blanks the screen | T18 (engine messages) and T23 (inline field errors in the browser) | Pass |

## Known gaps (not failures)

- **Sleep "opportunity" wording:** S3b is checked by keyword scan plus reading. A scan cannot prove the absence of every possible implication, so re-read new copy before a demo.
- **Time inputs:** Settings uses native `<input type="time">`, which some browsers display in 12-hour format ("11:00 PM") while the helper text says "24h time". The stored value is still `23:00`. Listed in the PR as an unfixed cosmetic defect.
- **D8 (campus-support link for very low reported sleep):** not built, by design (section 15: decide with a professional first).
