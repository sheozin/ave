# Episode 06 — Delay Cascade & Programme Management
**Duration target:** 5–7 min
**Style:** Practical and methodical — this is a power-user feature. Real event scenario throughout. Show the visual feedback at every step.

---

## INTRO (0:00–0:30)

[Screen: CueDeck console in director view, session list visible with a LIVE session at the top]

> "Every live event production team knows the feeling. The keynote runs long. Or a panel goes fifteen minutes over. Suddenly your entire afternoon programme is out of sync — and you're the only person who knows it.
>
> In this episode we're going to look at one of CueDeck's most useful features: the delay cascade. It's how you absorb overruns without losing control of your programme, and it takes about three seconds to use."

---

## WHAT DELAY_MINUTES AND CUMULATIVE_DELAY MEAN (0:30–1:45)

[Screen: A session card in the session list, zoom in on the delay tag and the session's time fields]

> "Before we hit any buttons, let's understand the two numbers CueDeck tracks behind the scenes.
>
> Every session in the database has a `planned_start` and a `planned_end` — those are the times your programme was originally designed around. They never change. Think of them as your baseline.
>
> When you apply a delay, CueDeck writes to a separate pair of fields: `scheduled_start` and `scheduled_end`. These are the working times — the live reality of your programme right now.
>
> On top of that, each session carries two delay counters. `delay_minutes` is the delay applied directly to this specific session — it's what caused the original ripple. `cumulative_delay` is the total shift this session has accumulated, which can be larger if multiple delays have been applied upstream.
>
> You can see the cumulative delay on every affected session card — that amber tag showing plus-something-minutes. That number tells you how far behind the original programme this session is sitting right now."

[Screen: Hover over a session card showing the orange +10min delay tag]

> "This session, for example, is running ten minutes behind its planned start. The director applied a delay upstream, and it cascaded down to here automatically. Let me show you how that works."

---

## APPLYING A DELAY — THE +5/10/15 BUTTONS (1:45–3:00)

[Screen: Click on the LIVE session card to expand its context. Show the delay group buttons (+5, +10, +15) in the action bar]

> "In the director view, whenever a session is READY, CALLING, or LIVE, you'll see a row of amber buttons labeled +MIN — five, ten, and fifteen. These are your delay controls.
>
> Let's say the current session was scheduled to end at two-fifteen, but it's two-twenty and the speaker is still going. I'll hit plus-five."

[Screen: Click the +5 button on the LIVE session]

> "Watch the session list."

[Screen: The session list scrolls through — each PLANNED session below the live one gets its time updated and a delay tag appears]

> "Every session below this one that is in a PLANNED state just shifted forward five minutes. Their `scheduled_start` and `scheduled_end` both moved. The amber plus-five tag appeared on each of them. And up at the top of the session list, the delay strip appeared — it tells us the programme is now running plus-five minutes, with three sessions affected.
>
> The director console doesn't reload, it doesn't ask for a confirmation dialog. The cascade happens client-side first for instant feedback, and then writes to the database in the background for all other connected devices."

---

## ANCHOR SESSIONS — STOPPING THE CASCADE (3:00–3:55)

[Screen: Scroll the session list to show a session with an anchor icon — or zoom into the session edit modal with the is_anchor checkbox]

> "But here's the scenario most multi-day conferences run into: you have fixed-time slots that cannot move. The lunch break at one o'clock. The opening ceremony. The gala dinner at seven. Those sessions need to hold their ground no matter what happens in the morning.
>
> That's what anchor sessions are for. When you tick the Anchor checkbox on a session in the edit modal, you're telling CueDeck: stop the cascade here.
>
> Watch what happens when I apply a delay with an anchor session in the list."

[Screen: Apply a +10 delay to the session just above the anchor session. Show the cascade stop at the anchor.]

> "The sessions between the live one and the lunch break all shifted. But the lunch break itself didn't move. Neither did anything after it. The anchor absorbed the delay — it acts as a firewall for your fixed-time commitments.
>
> And in the delay strip at the top, you'll see the anchor is called out by name: it tells you the cascade stopped at 'Lunch Break, 13:00'. That's your reminder that your afternoon is still on schedule."

---

## THE NUDGE BUTTONS — ADJUSTING THE LIVE SESSION (3:55–4:40)

[Screen: Show the NUDGE row on the LIVE session card — minus-1m and plus-1m buttons]

> "There's a second set of controls that's specifically for the session that's currently LIVE: the nudge buttons.
>
> These are different from the delay cascade. Nudge only affects the session that's running right now — it moves its end time by one minute without cascading anything downstream. It's for micro-corrections.
>
> If a speaker wraps up a minute early and you want to give the AV team a slightly longer transition window, hit minus-one. If they need just one more minute to finish their thought, hit plus-one. The timer in the live card updates immediately, and so does the stage timer display if you have one connected."

[Screen: Click +1m nudge, show the timer extend by one minute on the card]

> "Small adjustments, no drama."

---

## RESETTING ALL DELAYS (4:40–5:20)

[Screen: Show the orange delay strip at the top with the 'Reset delays' button]

> "Now let's say the session that was running late actually ended on time after all — or maybe you applied a delay by accident, or the event got back on track. You want to wipe the slate clean and go back to the original programme.
>
> Hit Reset delays in the orange strip."

[Screen: Click the button — it changes to 'Confirm reset?' — then click again]

> "CueDeck asks for a single confirmation tap — it changed to 'Confirm reset?' — because this is destructive. Once I confirm, every session's scheduled times go back to their planned originals. Every delay tag disappears. The delay strip goes away. The programme is clean again.
>
> Under the hood, CueDeck is writing `scheduled_start` and `scheduled_end` back to `planned_start` and `planned_end` for every affected session, and zeroing out both delay counters."

[Screen: Show the clean session list after reset — no delay tags visible]

---

## PRACTICAL TIPS FOR MULTI-ROOM EVENTS (5:20–6:15)

[Screen: Session list with multiple rooms visible — session cards showing room labels]

> "A few things worth knowing when you're running a multi-room event.
>
> First: the cascade only touches sessions in the same programme sequence as the session you delayed. It works through sort order, not through room assignment. So if Hall A is running late and you delay Hall A's keynote, sessions in Hall B are not touched. You'd apply a delay to Hall B separately if needed.
>
> Second: the cascade stops at ENDED and CANCELLED sessions too — it skips them. So if a session was cancelled earlier in the day, it won't interfere with the propagation logic.
>
> Third: for events with a hard parallel track — say, a workshop that always runs from two to three regardless of the plenary room — make the first session of that track an anchor. That way no director action on the main stage can accidentally push your workshop slots around.
>
> And finally: the delay strip is visible to all roles in director view, not just the person who applied the delay. So your whole team can see at a glance that the programme is running plus-ten and plan accordingly."

---

## WRAP (6:15–6:45)

[Screen: Clean session list, normal state, director console]

> "The delay cascade is one of those features that sounds complicated until you've used it once, and then you wonder how you ever ran a live event without it.
>
> One click shifts your entire programme. Anchor sessions protect your fixed times. Nudge gives you per-minute surgical control on the running session. And reset brings everything back to plan in two taps.
>
> In the next episode we're moving into the digital signage system — how to set up displays around your venue and get them all pulling live data from CueDeck. See you there."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console in director view with a live event loaded
- [ ] Show session list with at least one LIVE session and several PLANNED sessions below it
- [ ] Zoom in on a session card to show the planned vs scheduled time fields concept
- [ ] Hover over a session card to highlight the orange +Xmin delay tag
- [ ] Click on the LIVE session to expand the context panel — show the +MIN (5, 10, 15) amber buttons
- [ ] Click the +5 button and capture the cascade rippling through the session list in real time
- [ ] Show the orange delay strip appearing at the top with "RUNNING +5 MIN" and the affected count
- [ ] Open a session edit modal to show the Anchor checkbox (is_anchor)
- [ ] Apply a +10 delay with an anchor session below the target — show cascade stopping at the anchor
- [ ] Show the delay strip calling out the anchor session by name
- [ ] Return to the LIVE session and show the NUDGE row (−1m and +1m buttons)
- [ ] Click +1m nudge and show the live card timer extend by one minute
- [ ] Click "Reset delays" in the delay strip — show the confirmation step ("Confirm reset?")
- [ ] Confirm reset and show the session list returning to the clean, undelayed state
- [ ] Show a multi-room event scenario (optional: filter by room to illustrate cascade isolation)
