# Five-minute demo script

This script walks a professor through the claim the prototype can support. That claim is narrow: **a deadline-aware engine catches a conflict that a weekly total misses, and it finds a verified fix** (SPEC.txt section 2, hypothesis H0). The demo does not claim that students act on the suggestions, sleep more or feel less stressed. Those claims are unproven (section 14).

All numbers below are the golden values from SPEC.txt section 10. They are pinned by tests T2–T7 and T9, and checked in the browser by T21. If the screen ever shows a different number, stop and run `node --test`.

## Before the demo (2 minutes, once)

1. Start the server from the repository root:

   ```bash
   python3 -m http.server 8000 --bind 127.0.0.1
   ```

2. Open <http://127.0.0.1:8000> in a fresh browser window (a private window is easiest, because it starts with no saved data).
3. If you have used the app before in this browser, go to **Settings → Clear all my data**, confirm, and you are back on the built-in demo.
4. Make the window at least 1000px wide so the verdict and the comparison cards sit side by side.

The demo week is Monday 16 Nov to Friday 20 Nov 2026. Protected sleep is 23:00–07:00. Free hours per day are 4, 3, 3, 3 and 7, which is 13h through Thursday and 20h in the week.

| Task | Hours (min / typical / max) | Due |
| --- | --- | --- |
| DBMS Lab | 4 / 4 / 4 | Tue |
| ML Assignment | 3 / 3 / 3 | Thu |
| AUV Club Poster | 3 / 3 / 3 | Thu target (A: may move to Fri; B: fixed) |
| French Homework | 3 / 3 / 3 | Fri |
| New Research Project (proposal, droppable) | 4 / 5 / 6 | Thu |

## 0:00–0:30 Framing

> "Students say yes to things without checking whether the hours exist *before each deadline*. A weekly total can look fine while one deadline is already impossible. This tool checks every deadline, protects sleep before scheduling anything, and suggests the smallest change that a re-run of the scheduler confirms works."

## 0:30–2:00 Scenario A: the weekly check says it fits; the deadline check says 2h short

Screen: **My Week**, with **Flexible target (Scenario A)** selected (the default) and **Include demo research proposal** ticked at **5h**.

1. Point at the three comparison cards under **Three ways to check one week**:
   - **Weekly hours only (simulated baseline): ✓ Fits.** "18h of 20h available this week."
   - **Deadline-aware scheduler (same allocation, no repair step): ✕ Misses.** "2h short by Thursday."
   - **The 25th Hour: ↗ Repair.** "Self-serve repair found."

   > "Same inputs, three readings. The weekly total says yes. Checking each deadline says no."

2. Point at the verdict card (it is a polite live region, so screen readers announce it):
   - **✕ INFEASIBLE: This plan can't meet its deadlines.**
   - **"Thursday (2026-11-19): 15h of work due, 13h available. Short by 2h."**
   - "Tasks due by Thursday: DBMS Lab (4h), ML Assignment (3h), AUV Club Poster (3h), New Research Project (5h)."
   - Metrics: **18h** required, **20h** available, **−2h** Thu margin.

   > "No single task is blamed. Four tasks share Thursday, and together they need 2h more than exists."

3. Point at **Three-estimate check**. Thursday is short at every estimate: **−1h** optimistic, **−2h** typical, **−3h** conservative. Because the typical estimate misses, the verdict is *infeasible*, not "at risk" (decision D1).
4. Optional, 15 seconds: drag the research slider to **4h**. Thursday typical becomes −1h and the verdict stays **infeasible** (scenario C). Drag it back to **5h**.

## 2:00–2:45 Scenario A: the top verified repair

Click **See 2 verified fixes in Make It Work →**.

1. Exactly two repairs are listed. The redundant "move + decline" combination (score 270) is pruned (B2).
   - **01 Move AUV Club Poster target to Friday**: Self-serve, 1 change, **After: ▲ At risk**, typical Thu **+1h**, conservative Thu **0h** (engine score 113).
   - **02 Decline New Research Project**: Self-serve, 1 change, **After: ✓ Feasible**, +3h at every deadline (score 165).

   > "The smallest change among the candidates the engine examined. It does not claim to be globally optimal. Each card is a re-run of the scheduler, not a guess."

2. The preview on the right shows the repaired 30-minute timeline. Click **Apply** on repair 01.
   - Status: "Verified change applied. Plan verdict is now At risk."
   - Header: **▲ AT RISK: It fits, but there is almost no room for error.** Thursday has 0h to spare at conservative estimates.
   - Exactly one further repair remains: **Decline New Research Project → Feasible** (T6).
3. Click **Undo last change**. The verdict returns to **✕ INFEASIBLE**.

## 2:45–4:00 Scenario B: declining vs requesting an extension (the approval gate)

Still on **Make It Work**, click **Scenario B (Fixed)**. Now the poster deadline is fixed on Thursday, but an extension can be requested. Verdict and margins are the same as A.

1. Two repairs:
   - **01 Decline New Research Project**: **Self-serve**, After: ✓ Feasible (score 165).
   - **02 Request AUV Club Poster deadline on Friday**: **Needs approval (pending)**, If approved: ▲ At risk, typical Thu +1h, conservative 0h (score 173).

   > "Declining is something the student can do alone. The extension depends on another person, so it ranks lower and is clearly marked."

2. Click **Preview** on repair 02. The panel is labelled **IF APPROVED · HYPOTHETICAL PREVIEW**: "Your real plan, deadlines, and verdict do not change until you mark this request approved and apply it."
3. Click **Copy approval request**. The clipboard now holds plain text. The app sends nothing:

   ```text
   Subject: Request to adjust AUV Club Poster deadline

   Hello,

   Could the deadline for AUV Club Poster move to 2026-11-20? The current deadline stays in effect until you approve the change.

   Thank you.
   ```

   Workload numbers are added only if the student ticks **Include my workload summary**.
4. Click **Mark approved**. The status reads 'Approval recorded. Click "Apply approved change" to update your real plan.' **The header still says ✕ INFEASIBLE.** Recording the answer does not change the plan (T9: poster hard day is still Thursday).
5. Click **Apply approved change**. Only now does the plan change: "Approved change applied. Plan verdict is now At risk."

   > "Anything that needs a professor's or teammate's yes stays hypothetical until the student says it happened, and then the student applies it explicitly."

## 4:00–4:45 Did It Work?

Click **Did It Work?**

1. "How long did it actually take?" lists tasks whose target day has passed. With **DBMS Lab** selected, click **As planned (4h)**. Status: "Task feedback saved… Estimate learning (other): 1 of 3 samples recorded."
2. In **Sleep & stress report (optional)**, enter **6.5** hours and stress **3**, then click **Save sleep report**. This is skippable without consequence.
3. Read the **Seven-day review**:
   - Summary: "Your plan kept protected sleep time free on 5 of 5 loaded days in this review. You reported 6.5h on average on 1 logged night. A feasible plan makes room to sleep; it can't guarantee sleep."
   - Deadlines: DBMS Lab, estimated 4h vs actual 4h, ✓ Target met.
   - Adjustments applied: "Request AUV Club Poster deadline on Friday · Approved."
   - Sleep: reported 6.5h vs 8h protected opportunity.
   - Learned profiles: "Learning (1 of 3)". After 3 samples the app *suggests* an adjusted estimate; it never changes the student's number silently (T19).

## 4:45–5:00 Close: what is and isn't proven

> "What this shows: a deadline-aware check catches a conflict the weekly total misses, and every fix is verified before it is shown. What it doesn't show yet: that students act on the fixes, or that anyone sleeps more. That's what the two-week pilot in docs/PILOT.md is for, and we won't claim significance from it."

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| Numbers differ from this script | Settings → **Clear all my data**, reload. If they still differ, run `node --test`. |
| Yellow "Your calendar may be out of date" banner | Expected in the demo: no calendar is imported. It does not block anything. |
| Blank page | The page must be served over HTTP (`python3 -m http.server`). Opening `index.html` as a `file://` URL blocks ES modules. |
| "Copy approval request" does nothing | The clipboard API needs a focused window on `127.0.0.1` or HTTPS. Read the draft from the on-screen box instead. |
