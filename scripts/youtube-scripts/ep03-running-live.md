# Episode 03 — Running Your Event Live: The Session State Machine
**Duration target:** 6–8 min
**Style:** Demonstrate the 8-state machine live — director + second browser as stage view

---

## INTRO (0:00–0:30)

[Screen: console with Tech Summit 2026 loaded, sessions in PLANNED state]

> "Your event is set up. Sessions are in. It's showtime.
>
> In this episode I'm going to walk you through the entire session lifecycle — from PLANNED, through READY, CALLING, LIVE, HOLD, and ENDED. This is the core of CueDeck, and once you understand how the state machine works, running a complex event becomes straightforward."

---

## THE 8 STATES (0:30–1:30)

[Screen: zoom in on a session card showing the status badge]

> "Every session in CueDeck lives in one of eight states:
>
> PLANNED — it's on the programme, nothing has happened yet.
> READY — the room is set up, we're expecting the speaker.
> CALLING — the speaker is being called to stage.
> LIVE — on stage right now.
> HOLD — live but paused, speaker is waiting.
> OVERRUN — the session went past its scheduled end time.
> ENDED — finished.
> CANCELLED — removed from the running order.
>
> Transitions flow in one direction. You can't accidentally move a session backwards through the machine. And every state change is timestamped and logged."

---

## SET READY (1:30–2:15)

[Screen: select the Opening Keynote card, show context panel]

> "It's 9:15 — fifteen minutes before the keynote. The room is set up. Let's move Sarah's session to READY.
>
> Click the session to select it. The context panel shows 'Set Ready'. Click it. The card flips to a green READY badge. Every connected device — the stage manager's phone, the AV laptop, the display monitors — updates in under a second."

[Action: click Set Ready on session 1]

---

## CALL SPEAKER (2:15–2:45)

[Screen: context panel now shows CALLING option]

> "9:25. Time to call Sarah to stage. Click CALLING. The card goes amber — every stage manager knows to go find the speaker. The broadcast bar can send a message to the whole crew at the same time — we'll cover that in episode five."

[Action: click Call Speaker]

---

## GO LIVE (2:45–3:30)

[Screen: Go Live button prominent in context panel]

> "Sarah's on stage. It's 9:30. Hit GO LIVE.
>
> The session card turns bright green, the status changes to LIVE, and the actual_start timestamp is recorded. The clock starts.
>
> If you have digital displays or a stage confidence monitor set up — we'll build those in episodes eight and nine — they all flip to show this session live."

[Action: click Go Live, show the timer ticking on the card]

---

## HOLD (3:30–4:15)

[Screen: HOLD button visible]

> "Sometimes you need to pause mid-session. Fire alarm, technical issue, speaker needs water. Hit HOLD.
>
> The session freezes. The stage timer freezes. Everyone on every device sees the HOLD state. When you're ready to resume, click LIVE again — the session continues from where it was, timer picks back up."

[Action: click Hold, wait a few seconds, click Live again]

---

## NUDGE / DELAY (4:15–5:00)

[Screen: nudge buttons +1 / -1 in context panel]

> "Sarah went 3 minutes over on her demo. We need to adjust the rest of the programme.
>
> The nudge buttons add or subtract a minute from the current session's end time. The delay cascade automatically shifts every subsequent PLANNED session forward. You can see the knock-on effect ripple down the session list in realtime.
>
> We'll go deep on delay management in episode six."

[Action: click +1 three times, show cascade in session list]

---

## END SESSION (5:00–5:30)

[Screen: End Session button]

> "Session done. Click END SESSION. Status flips to ENDED with a green check. Actual end time is recorded. The time variance — how far over or under planned — is calculated and stored. You'll see all of this in the post-event report."

[Action: click End Session]

---

## SPEAKER ARRIVED FLAG (5:30–6:15)

[Screen: speaker arrived toggle on a future session]

> "On the next session — the panel — you can mark speakers as arrived before the session is even called. The stage manager ticks 'Speaker Arrived' on each panellist as they check in backstage. Directors can see at a glance whether all speakers are present.
>
> This feeds into the pre-cue AI agent too — but that's episode ten."

[Action: tick Speaker Arrived on the Panel session]

---

## WRAP (6:15–7:00)

> "That's the full session lifecycle. PLANNED → READY → CALLING → LIVE → ENDED, with HOLD and delay nudges along the way.
>
> In the next episode we'll look at roles — how to invite your team and what each role can see and do.
>
> See you in episode four."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open console with Tech Summit 2026 loaded
- [ ] Open second browser window / tab showing Stage role view
- [ ] Set Ready on Opening Keynote
- [ ] Call Speaker
- [ ] Go Live — show timer ticking
- [ ] Trigger Hold — show both windows freeze
- [ ] Resume Live
- [ ] Nudge +1 three times — show cascade
- [ ] End Session
- [ ] Tick Speaker Arrived on Panel session
