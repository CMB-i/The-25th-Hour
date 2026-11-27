# The 25th Hour

**Know what your next yes will cost.**

A local-first university workload decision-support prototype. It evaluates deadlines across three estimates (optimistic, typical, conservative), searches for the smallest verified repair, learns per-type estimate multipliers from real completion feedback, and protects sleep before allocating any work. The application runs as static HTML, CSS, and ES modules with local browser storage (`localStorage`) and zero external dependencies or network requests.

## Run locally

Use Python 3 from the repository root and open the URL in your browser:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. GitHub Pages serves the same root files over HTTPS. Keep `index.html` at the repository root and use relative module and asset paths (`./src/ui/...` and `../engine/...`).

**How the app is organised (v3).** The visual spec is `docs/v3-mock/` (fonts replaced by local system stacks; the mock's numbers are illustrative). A slim top bar holds the wordmark (Home) and **My week**. Every page has an address (`#/home`, `#/start`, `#/check`, `#/week`, `#/rescue`, `#/feedback`, `#/settings`).

- **Home** (`render-home.mjs`, `home-model.mjs`): a greeting from the clock, one line on the week from the engine ("You have 3 hours of real slack by Tuesday."), a week strip (planned vs room, coral only where over), the form for the next yes (**What is it? / How long might it take? / When is it due? / Who's waiting on an answer?** then **See if it fits**), and **Recent checks** from recorded decisions. A first-run card points to setup when there are no work hours; it never blocks the form.
- **First run** (`render-start.mjs`): sleep, work hours (day chips plus one range), classes (import `.ics` or add blocks, or later). Each step saves through the existing validation.
- **See if it fits** (`render-check.mjs`, `check-model.mjs`): the verdict as the largest text ("Not yet." / "That fits."), a needed-vs-free bar from the engine run, one verified option (**If approved** when it needs approval), and the reply slip with tabs that exist only for replies the engine verified. **Copy reply** only copies. *Just me* hides the slip. With no work hours the request is kept and the check asks for them inline. After a wind-down time, "This can wait till morning" appears only when an engine run confirms the work still fits with nothing starting before morning (`night.mjs`).
- **My week** (`render-week.mjs`, `week-model.mjs`): date strip with one day on a phone and the whole week on a desktop, BUSY vs DEADLINE WORK, free time per day, protected sleep, busy blocks you can name, import, and what still needs doing.
- **Reset** (`render-rescue.mjs`): numbered verified changes. With a request pending it answers for that request; otherwise for the committed plan. Apply, approval and undo are separate explicit buttons.
- **What my yeses cost** (`render-feedback.mjs`): the completion log first, one insight once there are three finished tasks of a type, and a guessed-vs-took ledger. Sleep and stress are collapsed.
- **Settings:** sleep, a day-and-time work-hours editor, preferences, learned estimates, local data, and deletion kept apart.
- **Night:** `data-theme="night"` follows the sleep window (an hour before sleep until it ends).
- **No example data in the interface.** Fixtures stay for tests only. A plan an older build saved as the fixture is not shown as your week; it is left untouched on load and archived under `the25thhour.v1.archived-example` before anything overwrites it.

1. **My Week (`src/ui/render-week.mjs`):** Switch between **Flexible target (Scenario A)** and **All deadlines fixed (Scenario B)**, adjust the demo research slider (`4–6h`), or navigate across the 5 loaded weeks. Inspect the live feasibility verdict (`aria-live="polite"`), binding deadline demand vs. available capacity, 3-way comparison cards (*Weekly hours only (simulated baseline)*, *Deadline-aware scheduler (same allocation, no repair step)*, *The 25th Hour*), 30-minute accessible slot timeline, 3-estimate uncertainty table, and calendar freshness status (including the 24-hour stale warning).
2. **Should I Say Yes? (`src/ui/render-check.mjs`):** Submit one or more draft commitments (name, typical hours, optional min/max with D3 `0.8× / 1.4×` defaults, deadline, priority tag, flexible latest acceptable date with D2 `+1 day` default, earliest start, and task type). Compare before-and-after verdicts (`separate` and `together` when multiple drafts are pending), read the plain-language cost statement and top verified fix, and choose **Accept**, **Accept with suggested change**, **Accept anyway** (which keeps the unresolved conflict visible), or **Not now**.
3. **Make It Work (`src/ui/render-rescue.mjs`):** Review up to 5 ranked verified repairs with `Self-serve` vs. `Needs approval` badges, preview the adjusted 30-minute timeline, apply self-serve fixes, or use the multi-step **Undo last change** history. For approval-gated repairs (such as deadline extensions or approval-required scope reductions), copy the plain-text request draft (with optional opt-in workload summary), record **Mark approved** or **Mark declined**, and explicitly click **Apply approved change** once approved.
4. **Did It Work? (`src/ui/render-feedback.mjs`):** Record actual completion hours with one tap on **As planned** or a half-hour stepper, log optional/skippable morning sleep and stress check-ins, and inspect the 7-day review (deadlines met/missed, estimate vs. actual hours, applied adjustments, reported sleep vs. protected sleep opportunity, and learned per-type estimate ratios that unlock optional suggestions after 3 samples without ever overwriting user input silently).
5. **Settings (`src/ui/render-settings.mjs`):** Configure the protected sleep window, 5-week anchor date, and weekly available work windows; import a local `.ics` calendar file (up to 1 MB / 2,000 events, read locally via `File.text()` with weekly `RRULE` support) or paste deadline lines (`Title | 3h | YYYY-MM-DD | tag | [optional latest date]`); export feedback as CSV; or click **Clear all my data** to wipe `localStorage` (`the25thhour.v1`).

The built-in demo covers 16–20 November 2026 inside a five-week rolling window. To start a fresh plan on current dates, click **Clear all my data** and save an anchor date in **Settings**.

## Architecture & Repository Layout

```text
the-25th-hour/
├── index.html                     # Root GitHub Pages entry point
├── src/
│   ├── engine/                    # Pure deterministic JS engine (no DOM, storage, or network)
│   │   ├── capacity.mjs           # 30-min slot generation & protected sleep exclusion
│   │   ├── commitments.mjs        # Draft proposal validation, D2/D3 defaults & comparison
│   │   ├── dates.mjs              # Pure ordinal date & lexical comparison helpers
│   │   ├── demo-data.mjs          # Golden Scenario A (flexible) & Scenario B (fixed) fixtures
│   │   ├── evaluate.mjs           # 3-estimate evaluation, weekly comparison & binding cost
│   │   ├── feedback.mjs           # EMA estimate learning, suggestions & 7-day review
│   │   ├── importers.mjs          # Pure pasted-task & .ics (with weekly RRULE) parsers
│   │   ├── repairs.mjs            # Verified repair search, superset pruning & approval drafts
│   │   ├── scheduler.mjs          # Earliest-deadline-first (EDF) scheduler & task validator
│   │   └── weeks.mjs              # 5-week rolling calendar, week views & plan rebasing
│   └── ui/                        # Modular static frontend (single state store & DOM renderers)
│       ├── app.mjs                # 5-screen router, store subscription & error boundary
│       ├── dom.mjs                # XSS-safe DOM builder (textContent), formatters & copy helpers
│       ├── check-model.mjs        # Pure verdict/option/reply/range model built from engine output
│       ├── render-home.mjs        # Home: one observation and the See if it fits form
│       ├── week-model.mjs         # Pure agenda and calendar-status model for My week
│       ├── import-controls.mjs    # Calendar/deadline import and busy-block form (beside My week sections)
│       ├── reply-slip.mjs         # Copy controls shared by reply slips (copy only, never dispatches)
│       ├── render-check.mjs       # See if it fits: verdict, one option, reply slip
│       ├── render-feedback.mjs    # Screen 4: Did It Work? (F3 Reality Feedback & 7-day review)
│       ├── render-rescue.mjs      # Screen 3: Make It Work (F2 Rescue Engine & approval gate)
│       ├── render-settings.mjs    # Screen 5: Settings, .ics/paste imports, CSV & clear data
│       ├── render-timeline.mjs    # Shared accessible 30-minute timeline component
│       ├── render-week.mjs        # Screen 1: My Week dashboard, verdict & 3-way comparison
│       ├── state.mjs              # Single store, pure reducer, undo stack & engine derivations
│       ├── storage.mjs            # Versioned localStorage wrapper (the25thhour.v1)
│       └── styles.css             # Cream/brown/sage design system, mobile first (down to 360px)
├── tests/
│   ├── baseline.test.mjs          # Root HTML entry smoke check
│   ├── engine.test.mjs            # T8–T15, T20 property & approval-gate tests
│   ├── feedback.test.mjs          # T19 estimate learning & 7-day review tests
│   ├── golden.test.mjs            # T1–T7 golden scenario tests
│   ├── imports.test.mjs           # T16–T18 importer & validation tests
│   ├── weeks.test.mjs             # 5-week navigation & T24 engine performance benchmark
│   ├── fixtures/                  # Calendar (.ics) and 5-week/30-task workload fixtures
│   └── ui/
│       └── browser-smoke.mjs      # T21–T24 automated Chrome/Chromium DevTools acceptance suite
├── docs/
│   ├── SPEC.txt                   # Build specification
│   ├── ENGINE_UI_CONTRACT.md      # Engine ↔ UI module boundary and data contracts
│   └── WORK_DIVISION.md           # Team ownership and milestone gates
├── reference/
│   └── legacy-prototype.html      # Original single-file prototype snapshot (read-only)
├── .github/workflows/tests.yml    # CI workflow running node --test and browser-smoke.mjs
└── package.json
```

## Tests

Use Node.js 20+ for the deterministic engine test suite (`T1–T20` and `T24`):

```bash
node --test
```

With the local HTTP server (`python3 -m http.server 8000 --bind 127.0.0.1`) running, Node.js 22+, and Chrome/Chromium installed, run the automated browser acceptance suite (`T21–T24`):

```bash
npm run test:ui
# or directly:
node tests/ui/browser-smoke.mjs
```

Set `CHROMIUM` to override the browser executable path (on macOS, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` is auto-detected when `CHROMIUM` is unset), `CHROMIUM_NO_SANDBOX=1` in sandboxed/CI environments, and `TEST_ORIGIN` to override `http://127.0.0.1:8000`. The browser suite runs in an isolated temporary profile and verifies:
- **T21:** Both demo scenarios, dynamic binding-day numbers (no hard-coded Thursday), B6 comparison labels, B7 calendar freshness & 24h stale warning, B9 three empty-repair messages, approval gating & clipboard copy, `aria-live="polite"`, keyboard navigation, `360px` zero horizontal overflow across all 5 screens, and zero console/page errors.
- **T22:** Full `localStorage` reload persistence across tasks, applied repairs, undo history, settings, feedback, and sleep reports, plus **Clear all my data**.
- **T23:** Untrusted HTML/JS payloads (`<img src=x onerror=alert(1)>`) in pasted tasks and `.ics` files rendered strictly as inert text, `> 1 MB` `.ics` rejection, inline field validation errors, and zero external network requests.
- **T25–T34:** the v3 flows end to end (Home, first run, verdict and reply tabs, My week, Reset, yeses, night, wait-till-morning), plus the earlier check-to-reply paths;
- **T25–T26 (earlier):** the Check-to-reply path (verdict, one option, reply slip, smaller offer, rerun with edited reply, approval copy applies nothing), first-use setup, the work-hours editor, example round-trip, routing, and a squeezed-text check on every page at 360/390/1200px.
- **T24:** 35-day / 30-task performance budgets (`evaluate < 100 ms`, `findRepairs < 250 ms`) and responsive UI re-renders.

## Safety & Guardrails Implemented

- **Protected sleep time:** Sleep slots are removed from capacity before any task is scheduled and cannot be shrunk by repairs. Every verdict and review reminds the user: *"A feasible plan makes room to sleep; it can't guarantee sleep."*
- **Explicit approval gate:** Extensions and approval-dependent scope reductions are previewed as *"If approved"* and never modify committed tasks until the student explicitly clicks **Mark approved** and **Apply approved change**. Request drafts are copied to the clipboard only—never sent automatically.
- **No silent estimate changes:** Learned estimate ratios require at least 3 completed samples of a task type and appear only as an explicit opt-in suggestion button (*"Use Xh"*).
- **Local-only privacy:** All state lives in `localStorage` under `the25thhour.v1`. Calendar and task imports are parsed in memory with zero network uploads.

The original [specification](docs/SPEC.txt), [engine-UI contract](docs/ENGINE_UI_CONTRACT.md), [work division](docs/WORK_DIVISION.md), and [legacy prototype](reference/legacy-prototype.html) are retained for reference.
