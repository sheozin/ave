# Episode 10 — Stage Timer: The Speaker-Facing Countdown
**Duration target:** 5–6 min
**Style:** Deliberate and visual. This feature has five distinct visual states — spend time on each one. Simulate each state live on camera. The portrait/tablet angle is a nice closer.

---

## INTRO (0:00–0:35)

[Screen: Split view — left: director console running a session. Right: a tablet or second browser window showing the stage timer in green countdown mode]

> "There's a problem that every conference speaker faces: how do I know how much time I have left without staring at the director?
>
> The classic solution is a floor clock, or a hand signal from the back of the room. Both work — but neither is elegant, and neither is visible if the speaker is moving around or focused on a slide.
>
> CueDeck's Stage Timer solves this cleanly. It's a full-screen, colour-coded countdown that you put on any screen facing the speaker — a tablet on the lectern, a monitor at the back of the stage, a TV at the side of the room. The speaker glances at it and instantly knows exactly where they stand. No director intervention required.
>
> Let's set one up and walk through every state it can be in."

---

## SETTING UP A STAGE TIMER DISPLAY (0:35–1:30)

[Screen: Director console — navigate to the Signage panel in the sidebar]

> "The Stage Timer is a display mode in CueDeck's signage system. That means you create it exactly like any other display: open the Signage panel in the director console, click Add Display.
>
> Give it a name — something like 'Stage Timer — Main Hall'. Set the zone to 'stage'. Set orientation to portrait if you're using a tablet or a vertical monitor — the layout is designed to work well in both orientations, but portrait is particularly good for a tablet on a stand at the lectern.
>
> For content mode, select 'stage-timer'.
>
> Hit Save."

[Screen: The display card appears in the signage panel with mode 'stage-timer']

> "The display card appears. Now click Open to get the URL."

[Screen: Click Open — the stage timer display loads in a new tab/window]

> "There it is. A large, full-screen timer. Right now it's showing the standby state because we haven't started a session yet. Let's go through each state one by one."

---

## STATE 1 — STANDBY: NEXT UP IN (1:30–2:05)

[Screen: Stage timer in standby state — showing 'NEXT UP IN', countdown, and next session title]

> "When no session is currently LIVE or on HOLD, the stage timer shows the standby state.
>
> If there's a session coming up — in READY, CALLING, or PLANNED state — the display shows 'NEXT UP IN' at the top, a large countdown to that session's scheduled start time in the centre, and the session title and speaker name at the bottom.
>
> This is what the speaker sees as they're preparing backstage or walking to the lectern. They can see exactly how many minutes until their session begins, and confirm they're looking at the right session title."

---

## STATE 2 — LIVE: GREEN COUNTDOWN (2:05–2:40)

[Screen: Transition the session to LIVE in the director console — switch to the stage timer tab and show it updating to green]

> "The moment a director clicks Go Live in the production console, the stage timer updates automatically. Supabase pushes the state change via its realtime channel and the display re-renders within a second.
>
> The green state: clean, calm, plenty of time. The status badge at the top reads LIVE. The timer in the centre is enormous — we're talking the size that's readable from across a room. Below it, a label reading 'REMAINING'.
>
> Underneath the timer, the session title and speaker name. And at the very bottom, a small 'NEXT:' line showing the title of the next session in the programme — so the speaker knows what's following them.
>
> There's also a progress bar running across the width of the screen, filling from left to right as the session time is consumed. It's a visual secondary indicator — useful for peripheral awareness even when the number itself is hard to read at a distance."

[Screen: Show the green countdown with the progress bar slowly filling]

---

## STATE 3 — AMBER: UNDER 5 MINUTES (2:40–3:10)

[Screen: Timer counting down — when under 5 minutes, show the colour shift to amber]

> "At five minutes remaining, the timer colour shifts to amber. No animation, no flash — a clean, smooth transition. The label below the timer changes from 'REMAINING' to 'WRAPPING UP'.
>
> The progress bar also turns amber to match.
>
> This is the speaker's cue to start bringing their talk to a conclusion. They don't need eye contact with the director, they don't need a hand signal — the screen is telling them."

---

## STATE 4 — RED: UNDER 2 MINUTES (3:10–3:40)

[Screen: Timer under 2 minutes — colour turns red]

> "At two minutes remaining, the timer turns red. The label becomes 'ENDING NOW'.
>
> This is the critical threshold — the speaker has ninety seconds to wrap up and hand back to the stage. The red state is hard to ignore. Even in a bright room, a red full-screen display gets attention.
>
> The progress bar is now nearly full and also red."

---

## STATE 5 — OVERRUN: FLASHING RED + MM:SS (3:40–4:15)

[Screen: Session goes past scheduled end — timer flips to OVERRUN state, showing +MM:SS, flashing]

> "When the session runs past its scheduled end time, the timer flips. The status badge at the top now reads 'OVERTIME'. The timer stops counting down and starts counting up — showing a plus sign followed by the number of minutes and seconds over time.
>
> And the entire timer flashes. Not subtle. This is intentional — a speaker in OVERRUN needs an unmistakable signal.
>
> The director in the production console sees the same OVERRUN status on the session card, and can choose to nudge the session — extending its end time by one minute — if they decide to give the speaker more room. When a nudge is applied from the console, the stage timer display picks it up immediately and the countdown resumes from the extended time."

[Screen: Apply a +1m nudge from the director console — show the stage timer switch back to a short countdown]

---

## STATE 6 — HOLD: FROZEN ORANGE PAUSED (4:15–4:50)

[Screen: Transition the session to HOLD from the AV role — show the stage timer switching to the orange PAUSED state]

> "HOLD is the paused state — used when AV needs to stop the session clock temporarily. Maybe there's a technical problem, a fire alarm, an unexpected interruption.
>
> When a session goes on HOLD in the production console, the stage timer freezes. The timer stops counting — it holds the exact remaining time at the moment HOLD was triggered. The colour shifts to orange. The status badge changes to 'HOLD'. The label below the timer reads 'PAUSED'.
>
> This is important: the timer is frozen, not counting. The speaker and the director both see the same frozen number. When the session resumes — when AV transitions it back to LIVE — the countdown picks up from exactly where it stopped. Time that was on hold doesn't count against the speaker's remaining time."

[Screen: Transition from HOLD back to LIVE — show the timer resuming from the frozen value]

---

## PORTRAIT ON A TABLET (4:50–5:20)

[Screen: Show the stage timer display resized to a portrait viewport — or displayed on a tablet mock-up]

> "The Stage Timer is designed to work in portrait orientation as well as landscape. Portrait is ideal for a tablet on a lectern stand — the long axis of the screen means the timer can be even larger, and the session title and next session footer have more vertical space.
>
> To use portrait, just set orientation to portrait when you create or edit the display in the signage panel. The display page adapts its layout automatically.
>
> In practice: buy a cheap tablet mount, prop it on the lectern, open the display URL in full screen, lock the screen orientation. That's your speaker timer. No hardware, no timecode, no dedicated timer device."

---

## OPENING FROM THE CONTEXT PANEL (5:20–5:40)

[Screen: Director console — context panel — STAGE TIMER button]

> "One quick note on access: directors and stage managers can open the Stage Timer display directly from the context panel in the production console — there's a 'STAGE TIMER' button in the Monitor section, right next to the Stage Monitor button.
>
> Clicking it opens the configured Stage Timer display URL in a new tab. If no Stage Timer display has been set up yet, CueDeck will show a toast notification and scroll the signage panel into view so you can create one on the spot."

---

## WRAP (5:40–6:00)

[Screen: Stage timer in green countdown, clean and large on a second screen]

> "The Stage Timer is a simple concept executed well. One URL, open on any screen facing the stage, and your speakers are self-managing their own time with zero director overhead.
>
> Set it up once, and it runs for the entire event. Every session transition, every delay, every HOLD — it all reflects automatically.
>
> That wraps up this episode. In the next one we're going into the AI agent modules — the Incident Advisor, the Cue Engine, and the Post-Event Report Generator. See you there."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck director console — navigate to Signage panel
- [ ] Click Add Display — fill in: Name ("Stage Timer — Main Hall"), Zone (stage), Orientation (portrait), Mode (stage-timer)
- [ ] Click Save — show the display card appearing with mode 'stage-timer'
- [ ] Click Open — show the stage timer display loading in a new tab
- [ ] Show STATE 1: Standby — 'NEXT UP IN' countdown, next session title at bottom
- [ ] Transition a session to LIVE in the director console
- [ ] Switch to stage timer tab — show STATE 2: green countdown, LIVE badge, REMAINING label, progress bar
- [ ] Zoom in on the progress bar filling
- [ ] Zoom in on the NEXT section at the bottom showing the next session title
- [ ] Simulate/wait for under 5 minutes — show STATE 3: amber colour shift, 'WRAPPING UP' label
- [ ] Simulate/wait for under 2 minutes — show STATE 4: red colour, 'ENDING NOW' label
- [ ] Let session go past end time — show STATE 5: OVERTIME badge, +MM:SS flashing red counter
- [ ] Switch to director console and click +1m nudge — switch back to stage timer showing resumption of countdown
- [ ] Transition session to HOLD — show STATE 6: orange, HOLD badge, PAUSED label, frozen timer
- [ ] Transition back to LIVE — show timer resuming from frozen value
- [ ] Resize the browser viewport to portrait orientation (or show on a tablet mock-up)
- [ ] Show the context panel STAGE TIMER button — click it — show it opening the display URL in a new tab
- [ ] Simulate no Stage Timer display configured — click button — show toast message and signage panel scroll
