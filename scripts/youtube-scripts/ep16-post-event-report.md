# Episode 16 — Post-Event Report & Event Log
**Duration target:** 5–6 min
**Style:** Reflective and methodical — the pressure of the live day is over; this is the accountability layer, the documentation phase. Tone is measured and professional, like writing a debrief email while the chairs are still being stacked. Every claim is backed by data the viewer can see on screen.

---

## INTRO (0:00–0:35)

[Screen: CueDeck console, director view — session list entirely in ENDED state, grey badges, all sessions grayed out. Clock shows late afternoon.]

> "The event is over. Every session is ENDED. The last speaker has left the stage.
>
> Now comes the part that production teams usually dread — the debrief. Which sessions ran late? By how much? Who triggered what, and when? If something went wrong at two-thirty, what exactly happened?
>
> CueDeck has been recording every single action throughout the day — every state change, every delay, every broadcast, every actor. That data doesn't disappear when the event ends. In this episode we're going to look at where it lives, how to read it, and how to turn it into a document you can actually send to a client."

---

## THE EVENT LOG (0:35–2:00)

[Screen: Scroll down in the director sidebar to find the Event Log panel — or click the log icon in the session toolbar. Show the log table: columns are Timestamp, Session, Transition, Actor.]

> "The event log is the audit trail for everything that happened during the day. It lives in the `leod_event_log` table in Supabase, and CueDeck surfaces it right here in the console — no SQL required.
>
> Every row is a state transition. Time it happened, the session it applies to, what the transition was — PLANNED to READY, READY to LIVE, LIVE to ENDED — and which operator triggered it. Name and role, both recorded.
>
> Let me scroll through this."

[Screen: Scroll through the event log — showing rows like "09:02:14 — Opening Keynote — PLANNED → READY — Sarah (Stage)", "09:04:31 — Opening Keynote — READY → CALLING — Sarah (Stage)", "09:05:18 — Opening Keynote — CALLING → LIVE — Director".]

> "You can see exactly how Session 2 played out. Ready at nine-oh-two, speaker called at nine-oh-four, went live at nine-oh-five. That's a three-minute window from ready to live — tighter than average. Good execution.
>
> Now look further down."

[Screen: Scroll to a row showing a delay — "10:47:22 — Workshop B Panel — LIVE — +5 min delay applied — Director".]

> "Here's the delay at ten-forty-seven. The panel was running long. Five minutes applied, cascade fired to every subsequent session in that room. The log captured exactly when it happened and who made the call.
>
> If a client asks 'why did the afternoon session start twelve minutes late,' this is your answer. You can point to a specific row, a specific time, and a specific person. That's the accountability layer."

---

## WHAT THE LOG STORES (2:00–2:45)

[Screen: Open Supabase dashboard, navigate to the Table Editor, click on leod_event_log. Show the column list: id, event_id, session_id, session_title, from_status, to_status, actor_id, actor_role, actor_name, created_at, notes.]

> "Under the hood the log table has everything you'd want for a proper audit trail.
>
> Every row has the session ID and title — so you can filter by session. The `from_status` and `to_status` columns capture the full transition, not just the destination. The actor fields record who triggered it: their ID, their role, and their display name. And `created_at` is a full timezone-aware timestamp.
>
> There's also a notes column — that's populated when a broadcast goes out alongside a state change, or when the Incident Advisor logs a flagged event.
>
> You'll never need to dig this deep for a normal debrief — CueDeck surfaces it in the console. But when a client wants a formal record, or when something went wrong and you need the raw data, it's all here."

---

## THE AI REPORT GENERATOR — VARIANCE TAB (2:45–3:50)

[Screen: Return to the CueDeck console. Navigate to the AI Agents panel in the sidebar. Click the Report Generator module. The report modal opens and begins generating. Show the thinking animation briefly, then jump to the Sessions tab once it renders.]

> "Now let's connect the log to the client-facing output. The Report Generator — which we covered in Episode 13 — pulls all of this data and presents it in a format you can actually send.
>
> The Sessions tab is where the variance lives. Every session, side by side: planned start time from your original programme, actual start time from the event log, and the delta in minutes. Positive numbers mean late. Negative means you were ahead of schedule."

[Screen: Show the sessions variance table — columns: Session, Room, Planned Start, Actual Start, Delta; green deltas for on-time sessions, orange for +2/+3 min, red for anything +5 or above.]

> "Look at the colour coding. Green rows started on time or within a minute. Orange sessions drifted two to four minutes late — normal production variance. The red rows are where you had real schedule pressure.
>
> In this example, the afternoon keynote started seven minutes late — that's the one where the delay cascade fired. The log tells you why: the panel before it ran over, the delay was applied at ten-forty-seven, and it rolled downstream.
>
> This is not a story you have to reconstruct from notes. It's already here, timestamped to the second."

---

## EXPORTING VIA post-event-report.sql (3:50–4:45)

[Screen: Open the Supabase dashboard — navigate to SQL Editor. Paste in the post-event-report.sql query. The query is visible: SELECT fields including planned_start_ts, scheduled_start_ts, actual_start, start_vs_planned_min, end_vs_planned_min, actual_duration_min, planned_duration_min, delay_minutes, cumulative_delay, speaker_arrived, mics, recording, streaming.]

> "For clients who want a full spreadsheet — or for your own production archive — there's a SQL export query included with CueDeck.
>
> Paste this into the Supabase SQL Editor, replace the event ID placeholder with your event's UUID, and run it. What you get back is one row per session with every timing field: planned start and end, scheduled start and end after any delay cascade, actual start and end from the live run, and the variance in minutes against both the planned and scheduled times.
>
> It also includes the production flags — speaker arrived, mic type, recording on or off, streaming, interpretation. Everything that was set on the session record comes through."

[Screen: Click Run in the SQL Editor. The results table appears — multiple rows, all columns visible. Then click the Export CSV button at the top right of the results panel.]

> "Hit Export CSV and you have a spreadsheet you can open in Excel or Google Sheets in about three seconds. Filter it, sort it by variance, chart the deltas. That's your post-event data asset — it follows every event you run on CueDeck."

---

## PRACTICAL USE CASES (4:45–5:25)

[Screen: Return to the console — session list all ENDED, clean view.]

> "Four things this gets you in the real world.
>
> First, client debrief. Within an hour of the event ending you can send a professional written summary — generated by the Report Generator — with the variance data attached as a CSV. That turnaround time is a differentiator.
>
> Second, billing justification. If you're billing for overtime on a specific room, the timestamps are your evidence. You went live at nine-oh-five, you wrapped at eighteen-forty-two. That's the billable day, in the database.
>
> Third, incident accountability. If something went wrong at fourteen-thirty-two, you have a log entry with the exact time, the operator who responded, and the system that was affected. No 'I think it was around half two' — it was fourteen-thirty-two.
>
> And fourth, continuous improvement. Run three events. Export the variance CSVs. Plot the average delay per session type. You'll know within two events whether your keynotes consistently run long, whether your breaks are too short, and where to add buffer next year. That kind of institutional knowledge used to live in a production manager's head. Now it's in a table."

---

## WRAP (5:25–5:50)

> "The event log and the post-event report are the accountability layer in CueDeck. Every transition is stored, every actor is identified, every minute of variance is measured.
>
> Used together — the in-console log, the AI Report Generator, and the SQL export — you have everything you need to close out an event professionally and improve the next one.
>
> In the next episode we're going deep on something that changes how fast you can work inside the console — keyboard shortcuts and the command palette. If you've ever wished you could trigger a session transition without taking your eyes off the stage, that's the episode. See you there."

[End card: subscribe + episode 17 thumbnail]

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console as Director, all sessions in ENDED state
- [ ] Scroll to Event Log panel in the sidebar or click log icon
- [ ] Show the log table — columns: Timestamp, Session, Transition, Actor
- [ ] Scroll through multiple log rows showing PLANNED→READY→CALLING→LIVE→ENDED chain for one session
- [ ] Locate the delay entry row (+5 min, timestamp, actor name)
- [ ] Open Supabase dashboard → Table Editor → leod_event_log
- [ ] Show the full column list (id, session_title, from_status, to_status, actor_name, actor_role, created_at, notes)
- [ ] Return to console — navigate to AI Agents panel → Report Generator
- [ ] Click Generate Report — show thinking animation briefly
- [ ] Click Sessions tab — show variance table with colour-coded delta column
- [ ] Point to green rows (on time), orange rows (minor drift), red rows (late)
- [ ] Open Supabase SQL Editor
- [ ] Paste post-event-report.sql query — show the SELECT fields on screen
- [ ] Replace placeholder event ID with a real UUID
- [ ] Click Run — show results table with all timing columns
- [ ] Click Export CSV — show the file downloading
- [ ] Return to console for wrap
