# The 25th Hour

Know what your next yes will cost.

A local-first university workload prototype. It checks deadlines across three estimates, verifies repairs, and protects sleep before allocating any work. The application runs as static HTML, CSS, and ES modules, with browser storage for local data.

## Run locally

Use Python 3 from the repository root and open the URL in your browser.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. GitHub Pages can serve the same root files over HTTPS. Keep `index.html` at the repository root and use relative module and asset paths.

1. Open **My Week** and choose **Flexible demo** or **Fixed demo**. The flexible plan has 15h due by Thursday with 13h available. The weekly comparison counts 18h due that week against 20h available.
2. Open **Rescue Engine**. Preview the flexible poster move and apply it to see the at-risk verdict. In the fixed demo, preview the extension and record explicit approval before applying it. Use **Undo last applied repair** to restore the previous task values.
3. In **Commitment Check**, submit one or more drafts. Compare the draft outcomes, then choose an acceptance option or discard them.
4. Enter task completion and optional sleep feedback in **Reality Feedback**. Three samples of a task type unlock an optional estimate suggestion.
5. Paste deadlines or import an `.ics` calendar in **Imports and Settings**. Adjust the sleep window and weekly work template there. **Clear all my data** removes the saved data. A fresh visit can show the built-in sample again.

The initial sample covers 16–20 November 2026 and is evaluated against its historical demo dates. For a plan with current dates, clear the sample and set an anchor date. The window covers five weeks and can shift when active task dates remain within the new window.

## Tests

Use Node.js 20+ for the engine suite.

```bash
node --test
```

T1–T20 run through Node's built-in runner. T24 measures a five-week, 30-task workload with actual repair candidates. On Node versions that default to file-level summaries, use `node --test --test-isolation=none --test-reporter=tap` to see individual results and timing diagnostics.

With the local HTTP server running, Node.js 22+ and Chromium installed, run the browser suite:

```bash
node tests/ui/browser-smoke.mjs
```

Set `CHROMIUM` if your Chromium-compatible binary has another name or path. Set `TEST_ORIGIN` to use a different local server URL. The smoke suite uses a temporary browser profile and runs T21–T24, including console, clipboard, local persistence, import, layout, network, and performance checks.

## Frontend handoff

- Replace `index.html`, `src/ui/styles.css`, and the placeholder rendering and event handlers in `src/ui/app.mjs`. `src/ui/state.mjs` and `src/ui/storage.mjs` provide a starting point for state and storage.
- Keep using the public engine interfaces for capacity, scheduling, evaluation, repairs, commitments, imports, feedback, and week navigation. See the [Engine ↔ UI contract](docs/ENGINE_UI_CONTRACT.md) for signatures and approval rules.
- Treat imported text as data. Let the UI read files and enforce the 1 MB size limit. The parser caps calendar imports at 2,000 busy windows and warns about unsupported events.
- Keep proposals and approval previews separate from committed tasks. Use `applyRepair` with explicit approved action IDs. Display actual deadline misses even when cumulative margins are positive due to earliest-start restrictions.

## Specification interpretations

- M0 preserved the legacy three-repair lists. M1 implements the two-repair lists required by T5 and T7.
- A flexible task with a latest date equal to its target has no movable target. This covers the D2 cap at the last loaded date and an explicitly equal date.
- Calendar busy intervals round outward to half-hour boundaries. Weekly RRULE expansion supports BYDAY, INTERVAL, COUNT or UNTIL, and EXDATE. The parser warns about all-day, cross-midnight, unsupported-zone, and unsupported recurrence patterns.
- The empty plan has a null conservative deadline margin because it has no deadlines. It is classified feasible.
- The accepted scope reduction consumes the task's stated reduction allowance once. D8 remains open for professional consultation. The placeholder omits optional pilot CSV export.

The original [specification](docs/SPEC.txt), [work division](docs/WORK_DIVISION.md), and [legacy prototype](reference/legacy-prototype.html) are retained for reference.
