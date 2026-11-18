# Engine ↔ UI contract

Agree on this at the start of M0 and use it for both branches. It follows specification sections 5–9 and preserves the legacy engine function names wherever possible.

## Architecture

- **Engine:** `src/engine/*.mjs`, pure named exports, independent of browser globals and UI.
- **UI:** `index.html` + `src/ui/*.mjs`, owns DOM, interactions, application state, persistence, clipboard, import file reads, error messages and the user's acceptance/approval decisions.
- **Boundary:** plain arrays and JSON-serialisable objects; use plain integer minutes inside the engine, 0.5-hour increments at inputs. Engine functions never mutate caller-provided tasks or days.
- **Paths:** UI imports using `./src/engine/evaluate.mjs`, etc., from `index.html` only if the importing file is at root; modules in `src/ui/` use `../engine/evaluate.mjs`. No absolute `/src/` imports, because Pages can publish under a repository subpath.

## Required engine exports

| Module | Export and signature | Return |
| --- | --- | --- |
| `capacity.mjs` | `makeSlots(days, sleep = {start:'23:00',end:'07:00'})` | Chronologically sorted free 30-minute slots |
| `scheduler.mjs` | `schedule(tasks, days, options = {})` | `ScheduleResult`, section 5 |
| `evaluate.mjs` | `evaluate(tasks, days, options = {})` | `Evaluation`, section 5 |
| `evaluate.mjs` | `weeklyCheck(tasks, days, options = {})` | `{ feasible, requiredMinutes, capacityMinutes }` |
| `repairs.mjs` | `actionIdeas(tasks, days)` | `Action[]` |
| `repairs.mjs` | `applyAction(tasks, action)` | **New task array** |
| `repairs.mjs` | `findRepairs(tasks, days, options = {})` | Up to 10 verified `Repair` objects |
| `repairs.mjs` | `draftApprovalRequest(repair, days, options = {})` | Plain text only, not sent |
| `importers.mjs` | `parsePastedTasks(text, days)` | `{ data: Task[], warnings: string[] }` |
| `importers.mjs` | `parseIcs(text, days)` | `{ data: BusyEvent[], warnings: string[] }` |
| `feedback.mjs` | `updateEstimateProfile(profile, feedback)` | New `EstimateProfile`, section 7.3 |
| `feedback.mjs` | `getEstimateSuggestion(profile, typicalHours)` | `null` if <3 samples, else a proposed rounded value |

The two F3 export names above are an explicit interface convention for this repository. Their formula, clamping and display semantics are defined by the specification, not this note.

`options` for `schedule`: `{sleep, estimate: 'optimistic'|'typical'|'conservative', deadline: 'target'|'hard'}`.
`options` for `evaluate` and `findRepairs`: `{sleep, deadline, minimumCushionMinutes}`; defaults in spec section 6.

The implementation should also expose `demoData(fixed = false)` from **`src/engine/demo-data.mjs`** so tests and the demo share one fixture, with no DOM dependency. This file is backend-owned.

## Importer compatibility choice

The old prototype uses `{tasks, errors}` and `{events, warnings}`, but section 9 explicitly requires the pure parser shape `{data, warnings}`. **Use the spec shape** in the new exports and update UI consumers during M0/M2. A `BusyEvent` is `{index, date, start, end}` where start/end are aligned `HH:MM`; imported titles need not be retained. The UI merges these with `days[index].busyWindows` immutably. The browser alone calls `File.text()` and applies the 1 MB limit.

## State shape owned by frontend

```js
{
  schemaVersion: 1,
  screen: 'week', // 'week' | 'check' | 'rescue' | 'feedback' | 'settings'
  days: [], tasks: [], sleep: { start: '23:00', end: '07:00' },
  settings: { weeklyWorkWindows: [] },
  proposals: [], // zero or more draft tasks, not committed
  selectedRepairId: null,
  pendingApprovals: [], // preview/request state, never applied automatically
  appliedChanges: [], // history for undo and feedback
  feedback: { tasks: [], sleepReports: [] },
  estimateProfiles: [],
  calendarImportedAt: null, lastEditedAt: null,
  unresolvedConflict: false
}
```

This is a **suggested app-state skeleton**, not the persisted schema design. Frontend may refine field details in M3, but must announce changes that affect engine inputs. The UI should have one `dispatch(action)` / `setState` entry point that recalculates and re-renders.

## Example call from a UI module

```js
import { evaluate } from '../engine/evaluate.mjs';
import { findRepairs } from '../engine/repairs.mjs';

const options = { sleep: state.sleep };
const verdict = evaluate(state.tasks, state.days, options);
const repairs = findRepairs(state.tasks, state.days, options);
```

For draft proposals, the UI evaluates each one **without** and **with** its draft task; if two are pending, it also evaluates them together and labels the outcomes. Do not commit them to the plan until the user explicitly accepts. Do not apply repairs marked `needsApproval` before a recorded approval.

## Integration checkpoints

- **M0:** both scenarios and slider still work; `index.html` imports `src/ui/app.mjs` and there are no duplicate engine implementations.
- **M1:** the engine's `verdict` and `deadlineMargins` directly produce UI wording; no guessed or hard-coded Thursday numbers.
- **M2:** form produces a spec-compliant `Task`, two evaluations and repair preview. Coordinate any validation error names before merging.
- **M3:** browser storage wrapper only; engine remains pure.
- **M4:** estimate learning only suggests, never silently changes a student's estimate.

If an exported name or return shape must change, update **this document first**, notify the other person and land a small contract PR before dependent code.
