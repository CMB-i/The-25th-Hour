# Exact two-person work division

**Person 1: Kaushal (backend / engine).** **Person 2: teammate (frontend / UI).**

Here, “backend” means **client-side computation**, not Node/Express hosting. The site must remain deployable to GitHub Pages as plain HTML/CSS/JS.

## File ownership

| Paths | Owner | What may be changed |
| --- | --- | --- |
| `src/engine/**`, `tests/*.test.mjs` except `baseline.test.mjs`, `tests/fixtures/**` | Kaushal | Capacity, EDF scheduling, classification, repair ranking, imports, feedback math, golden tests |
| `index.html`, `src/ui/**`, `tests/ui/**` | Teammate | CSS, pages, forms, state, storage, action/approval flows, browser tests |
| `docs/ENGINE_UI_CONTRACT.md`, `docs/WORK_DIVISION.md`, `docs/SPEC.txt`, `package.json`, `.github/**` | Shared | Change only in agreed coordination/integration PRs |
| `reference/legacy-prototype.html` | Neither | Preserve as an unchanged baseline |

The frontend owner is the only person who edits `index.html`; the engine owner extracts code by **reading** it and writes only under `src/engine/`. This prevents the main M0 merge conflict.

## Milestones: precise work tickets

### M0: Extract without changing behaviour

**Kaushal**

- [ ] Copy `makeSlots` and time-window helpers into `capacity.mjs`.
- [ ] Move `schedule` and input validation into `scheduler.mjs`.
- [ ] Move `evaluate` and `weeklyCheck` into `evaluate.mjs`.
- [ ] Move `actionIdeas`, `applyAction`, `findRepairs`, `draftApprovalRequest` into `repairs.mjs`.
- [ ] Move `demoData` into `demo-data.mjs`, preserving the original demo dates and tasks.
- [ ] Extract `parsePastedTasks` and `parseIcs` into `importers.mjs`. Preserve old behaviours in M0, except normalise return envelopes per the agreed importer contract; save behaviour corrections for M2/M5.
- [ ] Write fixtures for scenarios A–F; first implement T1–T7, documenting which expectations require M1 bug fixes. For M0, T1–T4 should pass; T5/T7 exact repaired-list counts are expected to fail until B2. Skip those assertions with an explicit M1 TODO, or keep them as separately reported expected failures, rather than weakening their expected values.
- [ ] Run `node --test` and give teammate the exported API list and a sample evaluation/repair output.

**Teammate**

- [ ] Move style content to `src/ui/styles.css`, with `<link href="./src/ui/styles.css" rel="stylesheet">` in root `index.html`.
- [ ] Move DOM code and event listeners to `src/ui/app.mjs` and rendering functions to `src/ui/render-*.mjs`.
- [ ] Replace six legacy globals (`scenarioFixed`, `includeResearch`, `researchLikely`, `appliedActions`, `extraTasks`, `extraEvents`) plus selected preview/timestamps with **one state object** in `state.mjs`.
- [ ] Import named engine exports from `../engine/*.mjs`; **do not** copy scheduler functions into UI.
- [ ] Maintain existing demo layout and scenario/slider/import interactions. No new forms/screens yet.
- [ ] Run local server, verify 2 scenarios, toggle, slider, repair preview and import controls with no console errors.

**Joint gate:** browser behaves like original, T1–T4 and all applicable legacy assertions pass, T5/T7 are recorded as pending M1 fixes, and there is no duplicate engine code. Commit M0 integration to `main`.

### M1: Make the demo truthful

**Kaushal**

- [ ] B1: adopt D1 recommended verdict rule (typical miss = infeasible).
- [ ] B2: remove redundant superset repairs.
- [ ] B5: accept only repairs that strictly improve verdict.
- [ ] D10-related comparisons expose correct data; replace `localeCompare` tie breaks with plain lexical comparisons.
- [ ] Add B8 reduction + approval fixture; implement **T8–T14**, plus **T20**. Verify exact scores in scenarios A/B and scenario C slider sweep.

**Teammate**

- [ ] B4: binding deadline from margins, showing deadline demand/capacity/shortfall (no fixed Thursday).
- [ ] B6: use accurate simulated comparison-card names.
- [ ] B7: separate calendarImportedAt and lastEditedAt; show stale/no-calendar banner after 24 hours.
- [ ] B9: render distinct empty-repair messages by verdict.
- [ ] Wording per section 8; `aria-live="polite"` and keyboard smoke check.
- [ ] Collaborate with Kaushal on **T15** (engine data + UI wording assertions), preparing **T21** browser coverage.

**Joint gate:** verify A, B, C, D, F and all numbers in section 10; **T1–T15, T20** pass, including newly enabled T5/T7. Only then move to M2.

### M2: Real Commitment Check (F1)

**Kaushal**

- [ ] Validate Task ids, titles, day indices, hour increments/ranges, `splittable` and estimate modes (T18).
- [ ] B3: correct pasted-task flexible/droppable mapping, unique IDs and row-level error handling (T16).
- [ ] Adopt recommended D2 (+1 day flexible default) and D3 (0.8x/1.4x rounded to 0.5h) for new inputs.
- [ ] Finish non-recurring .ics parser, TZ handling, skipped-event count and warnings (T17).
- [ ] Ensure evaluating a draft task and all previews never mutate input tasks/days (T13).

**Teammate**

- [ ] Build `Should I say yes?` form: name, likely hours, optional min/max, deadline, priority, optional latest, earliest and type.
- [ ] Show without/with verdicts, binding-day cost and top verified fix.
- [ ] Implement Accept, Accept with self-serve fix, Accept anyway (visible unresolved-conflict banner) and Not now.
- [ ] Handle two pending proposals as separately evaluated and together when applicable.
- [ ] Display errors beside corresponding fields; no blank screen. Test task entry in <10 seconds.
- [ ] Connect updated pure importers without network uploads.

**Joint gate:** **T16–T18** pass and F1 works using arbitrary input, not just the research slider.

### M3: Setup and local persistence

**Kaushal**

- [ ] Confirm engine accepts any loaded-day array and configurable sleep (including overnight wrap) without state or persistence.
- [ ] Provide validation cases for user-entered work/sleep windows; ensure sleep remains excluded (T10/T18).

**Teammate**

- [ ] Build first-run sleep and weekly work-window setup plus optional imports.
- [ ] Add `src/ui/storage.mjs`: schemaVersion, load/save, corrupt-data fallback and clear-all.
- [ ] Persist tasks, settings, applied changes, approval records, feedback and both timestamps.
- [ ] Add Settings and Clear all my data. Cover reload/clear behaviour (T22) and script-injection / oversized-file cases (T23).

**Joint gate:** **T22–T23** pass. Fresh user sees setup; returning user sees their own saved week.

### M4: Reality Feedback (F3)

**Kaushal**

- [ ] Implement per-type ratio `0.6 * previous + 0.4 * actual/estimate`, clamp [0.5,3], sample count and 0.5h suggestion.
- [ ] Implement no suggestion before three samples; use spec task types (D9).
- [ ] Write **T19** (ratios 1.2, 1.32, 1.392; recommendation 5.5h from 4h).

**Teammate**

- [ ] After task completion/target passes, request actual duration once; default to likely hours; offer “As planned”.
- [ ] Add optional skippable morning sleep/stress input; at most once per day.
- [ ] Build seven-day `Did it work?` review: adjustments, deadline results, estimates vs actual, sleep opportunities vs reports.
- [ ] Display learned estimate suggestion **without changing** user input until user accepts.
- [ ] Keep health wording neutral and add the specified sleep disclaimer.

**Joint gate:** **T19** passes and F3 behaves correctly after reload.

### M5: Reach, polish and validation

**Kaushal**

- [ ] Implement rolling five-week calculation support if time allows (D5); avoid any hard-coded Thursday in engine.
- [ ] Expand weekly `RRULE` (BYDAY, UNTIL, COUNT, INTERVAL, EXDATE) as D7, with fixtures; otherwise warn explicitly and document deferral.
- [ ] Property tests T8/T10/T11/T12/T13, and performance measurement for **T24**.

**Teammate**

- [ ] Add week navigation if D5 is selected.
- [ ] Implement optional CSV pilot export and accessibility pass (360 px, WCAG AA, labels, touch sizes, keyboard).
- [ ] Set up Playwright smoke/UI tests **T21–T24**, including no console errors and 1 MB import limit.
- [ ] Keep GitHub Pages entry at root; update README run instructions as needed.

**Joint gate:** all **T1–T24** pass, golden scenarios A–F match and README setup takes <5 minutes.

## Git collaboration: exact procedure

1. Agree on contract and push the scaffold once as `main`. Both pull the same starting commit.
2. Work in **short-lived milestone branches**, not never-ending feature branches:
   - Kaushal: `backend/m0-extract`, `backend/m1-repairs`, `backend/m2-imports`, etc.
   - Teammate: `frontend/m0-extract`, `frontend/m1-verdict-ui`, `frontend/m2-commitment-form`, etc.
3. The backend M0 extraction PR merges **first**, so frontend M0 code can import the final module names; teammate can draft CSS/markup in parallel.
4. Every PR must state: files changed; acceptance test IDs checked; exact test output; unresolved spec decisions; known omissions.
5. Each partner reviews the other's PR before merge. Do not rewrite code owned by the other person in a PR without prior discussion.
6. After every merge, both sync their branch with current `main` before continuing. Run `node --test` again.
7. Merge a milestone only after its **joint gate**, then create the next branches.

Example commands (replace URL with your real repository):

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
git switch -c backend/m0-extract       # Kaushal
# edit and test
node --test
git add src/engine tests
git commit -m "M0: extract deterministic engine"
git push -u origin backend/m0-extract
```

The teammate substitutes `frontend/m0-extract` and stages `index.html src/ui`. Open GitHub PRs with `main` as the base. Never commit `node_modules`.

## Decisions adopted for planning

| Decision | Choice | When actually implemented |
| --- | --- | --- |
| D1 | (b) typical miss = infeasible | M1 |
| D2 | (a) flexible defaults to +1 day | M2 |
| D3 | (b) 0.8x / 1.4x estimate range | M2 |
| D4 | (a) localStorage behind a wrapper | M3 |
| D5 | (b) rolling five weeks only if time after M4 | M5 |
| D6 | (b) split .mjs files, no build step | M0 |
| D7 | (b) weekly recurrence if feasible | M5 |
| D8 | **Unresolved:** consult a professional before any pilot thresholds | Before pilot |
| D9 | (a) seven task types | M4 |
| D10 | (a) corrected comparison label | M1 |

Do not prematurely change M0 expected behaviour based on decisions scheduled for later.

## One inconsistency found in the source specification

Section 16 says M0 must preserve the old engine *without changing behaviour* **and** pass T1–T7. But section 12's T5/T7 expect only two non-redundant repairs while the supplied legacy engine returns three (113, 165, **270** in scenario A; 165, 173, **330** in scenario B). Removing those extra repairs is explicitly **B2 in M1**. Therefore, keep M0 as behaviour-preserving and mark exact-count T5/T7 pending; turn them green in M1. Do not misrepresent M0 test coverage.
