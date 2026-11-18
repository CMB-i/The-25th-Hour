# The 25th Hour

**Know what your next yes will cost.**

A local-first, deadline-aware workload decision-support prototype for university students. This is a static website with a **pure JavaScript scheduling engine**, not a server-backed application.

## What is ready

- `index.html` is the **unchanged original Claude prototype**, so the demo can be opened immediately and published with GitHub Pages.
- `docs/SPEC.txt` is the original authoritative build specification.
- Team responsibilities, file ownership and the implementation order are in `docs/WORK_DIVISION.md`.
- The agreed engine/UI boundary is in `docs/ENGINE_UI_CONTRACT.md`.
- The initial CI test only checks that the runnable entry page is present. **None of T1–T24 is claimed as passing yet.**

The unmodified prototype contains known bugs B1–B9. Do not present its verdicts as validated until M1 is complete.

## Run locally

Requirements: Node.js 20+ for tests; Python 3 for an optional local HTTP server. No runtime dependencies or build step.

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>. Run the current tests with:

```bash
node --test
```

Once browser tests are added in M5: `npx playwright test` (after installing the dev dependency).

## Publish on GitHub Pages

1. Create a new empty GitHub repository (or use the empty one already created).
2. Upload or push **the contents of this folder** to the repository's `main` branch, keeping `index.html` at the repository root.
3. In GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, select `main` and `/(root)`, then Save.
4. Wait for Pages to display the site URL. The root `index.html` is the public entry point.
5. Do not move `index.html` under `src/ui`; frontend modules and CSS go under `src/ui/` and are imported relatively from the root page.

The existing page is entirely self-contained; a Pages URL can work before refactoring begins. Browser ES modules require HTTP(S), so use the local server for development instead of relying on `file://`.

## Repo map

```text
the-25th-hour/
├── index.html                     # Live GitHub Pages entry; frontend owner
├── src/
│   ├── engine/                    # Pure deterministic JS; backend owner
│   │   ├── capacity.mjs
│   │   ├── scheduler.mjs
│   │   ├── evaluate.mjs
│   │   ├── repairs.mjs
│   │   ├── feedback.mjs
│   │   └── importers.mjs
│   └── ui/                        # Frontend owner
│       ├── styles.css
│       ├── state.mjs
│       ├── app.mjs
│       ├── storage.mjs
│       └── render-*.mjs
├── tests/
│   ├── baseline.test.mjs          # Starter smoke test; not an acceptance test
│   ├── fixtures/                  # Golden scenario data and import fixtures
│   ├── *.test.mjs                 # T1–T20: backend owner
│   └── ui/                        # T21–T24: frontend owner
├── docs/
│   ├── SPEC.txt                   # Source of truth
│   ├── WORK_DIVISION.md
│   └── ENGINE_UI_CONTRACT.md
├── reference/
│   └── legacy-prototype.html      # Read-only original snapshot
├── .github/workflows/tests.yml
└── package.json
```

**Important:** The names in the tree are the **target layout**, not a claim that the engine or UI has been extracted. Only create each target source file when the corresponding owner implements it in M0 onward. No empty implementation stubs were introduced.

## Work sequence

1. Both: initial commit, confirm Pages serves the current demo, agree on `docs/ENGINE_UI_CONTRACT.md`.
2. **M0:** backend extracts the engine and writes T1–T7 checks; frontend extracts the UI and imports the engine. Integrate together and verify unchanged pre-fix behaviour. T5/T7's *fixed* expected repair counts are gated for M1 (see the documented specification inconsistency).
3. **M1:** fix demo truthfulness, preserve all golden numbers under adopted D1.
4. **M2:** real commitment check; **M3:** setup and persistence; **M4:** reality feedback; **M5:** navigation and polish.

For M0, do not silently apply M1 fixes. After M0, use the D1 recommended classification rule per the spec.

## Rules

- The specification wins over the legacy HTML when they conflict, except explicit pending decisions.
- No DOM, network, storage, randomness or Date.now inside `src/engine/`; time/dates enter as arguments.
- Never allocate into protected sleep slots or silently approve an extension.
- Each change to score weights, ranges or thresholds must update corresponding golden tests.
- User data stays in the browser. There is no remote backend, AI inference, or data collection.
- Run `node --test` on every PR; later also run Playwright on UI PRs.

See `docs/WORK_DIVISION.md` for the complete task-by-task checklist and merge procedure.
