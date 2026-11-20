# Pilot kit (two weeks, voluntary)

This kit runs the minimum evidence plan in SPEC.txt section 14. It tests H1 (students act on suggestions), part of H2, and H3 (self-reported sleep and stress), **as preliminary, descriptive evidence only**. It contains:

1. [Consent text](#1-consent-text) to read and sign before day 1.
2. [Morning diary](#2-morning-diary-one-page): one page per participant per week. Print it, or copy it into a form.
3. [Analysis](#3-analysis): `scripts/analyze-pilot.mjs` reads the app's CSV export plus the transcribed diary. It prints per-participant medians and the section 14 process metrics.

Before running the pilot:

- Check with your department whether this needs ethics/IRB review. Many institutions require it even for small voluntary studies.
- Agree decision **D8** (whether to show a campus-support link for very low reported sleep) with a counsellor. Agree also what you will do if a diary shows a participant in distress. The app does not do this, by design.

## Design (from section 14)

| | Week 1, baseline | Week 2, intervention |
| --- | --- | --- |
| Planning | Participant's normal planning. **No app.** | Run **Should I Say Yes?** before accepting new commitments; use **Make It Work** when the plan is flagged |
| Every morning | Diary: hours slept, stress 1–5 | Diary: same, plus the short "app use" box |
| End of week | Hand in the diary page | Hand in the diary page; **Settings → Export feedback CSV**, rename the file to your participant code (e.g. `P07.csv`) and send it |

Participants can stop at any time. No names go into the app or the CSV file names. Keep the key linking codes to names on paper or in a separate file, and destroy it after analysis.

**What the CSV contains:** completed-task feedback (task title, type, estimated and actual hours, target and hard dates, completion time), morning sleep reports and applied repairs. Participants should open the file before sending and may rename any task titles they consider private. The analysis does not use titles.

## 1. Consent text

> **The 25th Hour: two-week planning pilot. Participant information and consent**
>
> **What this is.** We are testing a student planning prototype, *The 25th Hour*. It checks whether your commitments fit before each deadline and suggests small changes when they don't. It is a planning tool. It is **not medical advice**, and it is not a treatment for sleep or anxiety problems.
>
> **What you will do.** For two weeks, each morning, write down roughly how many hours you slept and how stressed you felt (1–5). It takes under a minute. In week 1, plan as you normally do. In week 2, also use the app before saying yes to new commitments, and use its suggestions if you want to. You are never required to follow a suggestion.
>
> **Your data.** The app stores everything only in your own browser. Nothing is uploaded, and the app makes no network requests. At the end of each week you hand in your diary page, and at the end of week 2 you export a CSV file from the app and send it to us. You can read the file first and remove or rename anything. We identify you only by a participant code (for example P07). The list linking codes to names is kept separately by *[researcher name]* and destroyed after analysis, by *[date]*. When you finish, you can delete everything in the app with **Settings → Clear all my data**.
>
> **Voluntary.** Taking part is voluntary. You can skip any morning or any question. You can stop at any time without giving a reason and without any consequence for your grades or your relationship with us. If you stop, tell us whether you want the data you already gave deleted, and we will delete it.
>
> **Risks and limits.** Recording sleep and stress can make some people more aware of them. If that becomes uncomfortable, stop. If you are struggling with sleep, stress or mood, please contact *[campus counselling service and contact details]*. This study cannot provide support itself. A plan that fits creates an *opportunity* to sleep; it cannot guarantee sleep.
>
> **What we will report.** Only group-level and per-code summaries (counts and medians), with no names. This is a small study without a control group, so we will not claim that the app caused any change.
>
> **Contact.** *[researcher name, email]*. Questions about your rights as a participant: *[ethics office contact, if applicable]*.
>
> I have read this information, my questions have been answered, and I agree to take part.
>
> Participant code: ________  Signature: ______________________  Date: ____________
>
> Researcher: ______________________  Date: ____________

## 2. Morning diary (one page)

Print one copy per participant per week. Fill in one row each morning, about **the night that just ended**. Skipping a morning is fine: leave the row empty.

```text
THE 25TH HOUR PILOT — MORNING DIARY          Participant code: ______   Week: 1 / 2 (circle)

Each morning (under a minute). Hours slept: nearest half hour (e.g. 6.5).
Stress yesterday: 1 = very low, 5 = very high. Leave anything blank if you prefer.

                    | Hours | Stress |  WEEK 2 ONLY: app use yesterday                              |
 Date (morning)     | slept | (1–5)  | Min in | Fixes I | Requests | Requests | "Accept | Conflicts | ...resolved
                    |       |        | app    | looked  | sent     | approved | anyway" | flagged   | w/o using
                    |       |        |        | at      |          |          | used    |           | sleep
--------------------+-------+--------+--------+---------+----------+----------+---------+-----------+------------
 Mon ___/___        |       |        |        |         |          |          |         |           |
 Tue ___/___        |       |        |        |         |          |          |         |           |
 Wed ___/___        |       |        |        |         |          |          |         |           |
 Thu ___/___        |       |        |        |         |          |          |         |           |
 Fri ___/___        |       |        |        |         |          |          |         |           |
 Sat ___/___        |       |        |        |         |          |          |         |           |
 Sun ___/___        |       |        |        |         |          |          |         |           |

Week 2 column guide (counts for yesterday; 0 if none):
  Min in app ........ rough minutes you spent in the app
  Fixes I looked at . suggested changes you read on "Make It Work" or "Should I Say Yes?"
  Requests sent ..... extension / scope messages you actually sent to a professor or teammate
  Requests approved . of those, how many were approved (count it on the day you heard back)
  "Accept anyway" ... times you accepted a commitment the app said could not fit
  Conflicts flagged . times the app said "can't meet its deadlines" or "almost no room"
  ...resolved ....... of those, how many you sorted out without cutting into your sleep time

Optional note for the week (anything unusual: exams, illness, travel):
_______________________________________________________________________________________
```

### Transcribing the diary

Enter all pages into **one** CSV file, with one row per participant per morning. Dates are ISO (`YYYY-MM-DD`, the morning the row was written). Leave blank cells blank; the script reports them as "n/a", not zero.

```text
participant,date,hours_slept,stress,minutes_in_app,fixes_seen,requests_sent,requests_approved,accept_anyway,conflicts_flagged,conflicts_resolved_without_sleep
P01,2026-11-23,6,4,,,,,,,
P01,2026-11-30,7,3,5,2,1,1,0,1,1
```

A complete example is in `tests/fixtures/pilot/diary.csv`.

## 3. Analysis

Put each participant's export in one folder, named by code (`P01.csv`, `P02.csv`, …). Then run the script with the **first morning of week 1**:

```bash
node scripts/analyze-pilot.mjs --start 2026-11-23 --diary diary.csv exports/*.csv
```

To see a sample report built from the fixture diary alone:

```bash
node scripts/analyze-pilot.mjs --start 2026-11-23 --diary tests/fixtures/pilot/diary.csv
```

### What it computes

| Section 14 metric | How the script computes it | Source |
| --- | --- | --- |
| **Primary outcome:** sleep | Median hours per night in week 1 vs week 2, per participant, and the change. The diary wins for a given morning; app sleep reports fill mornings with no diary entry | Diary + app export |
| Stress | Median 1–5 rating, week 1 vs week 2 | Diary + app export |
| Deadlines met | Tasks completed during the pilot whose completion date was on or before the target date, and on or before the hard date | App export (`task_feedback`) |
| Estimate error | Median of actual ÷ estimated typical hours, by task type | App export |
| Repair adoption | (repairs applied in week 2 + requests sent) ÷ fixes looked at | App export (`applied_change`) + diary |
| Approval success | Requests approved ÷ requests sent | Diary |
| Infeasible accepts | Count of "Accept anyway" | Diary |
| Conflicts resolved | Conflicts resolved without using sleep ÷ conflicts flagged | Diary |
| Effort | Median self-reported minutes per day in the app (week 2) | Diary |

Why some metrics come from the diary: the app stores only the minimum data (section 13). It does not log which repairs were shown, which messages were sent or how they were answered. It never sends messages itself. The export does include repairs that were applied and not undone, labelled `self_serve` or `approved`.

### Reporting rules (printed at the end of every report)

- Report counts and medians **per participant**. Do not claim statistical significance with this sample size. The script computes no p-values or tests, and none should be added.
- State that there is no control group, and that week 2 may differ for reasons unrelated to the app (exam timing, for example).
- "Conflicts resolved" is a process metric. Never present it as proof that sleep improved; sleep change is a separate result.
- A feasible schedule creates an opportunity to sleep; say so in every summary.
