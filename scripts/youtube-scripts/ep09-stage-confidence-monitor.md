# Episode 09 — Stage Confidence Monitor
**Duration target:** 4–5 min
**Style:** Focused and punchy. This is a single-feature deep dive — show the full feature clearly, explain the real-world use case, and keep the pace up. No wasted time.

---

## INTRO (0:00–0:25)

[Screen: CueDeck director console with a LIVE session visible in the session list]

> "When you're running a live event as a director, your eyes are everywhere. You're watching the session list, the broadcast bar, the delay strip, the operator presence indicators. Somewhere in the middle of that, you also need to know what's actually happening on stage at this exact moment — without having to hunt for the session card.
>
> That's what the Stage Confidence Monitor is for. One click and your entire screen becomes a single, giant, impossible-to-miss display of the current session. Let me show you."

---

## OPENING THE STAGE MONITOR (0:25–1:20)

[Screen: Context panel on the right side of the director console — show the MONITOR section with the STAGE MONITOR button]

> "In the context panel on the right side of the director console — the same panel that shows your quick action buttons — scroll down to the Monitor section. You'll see a button labeled 'Stage Monitor' with a little screen icon.
>
> Click it."

[Screen: Click the STAGE MONITOR button — the fullscreen overlay appears, covering the entire browser window]

> "The overlay fills the entire screen. This is not a new browser window or a new tab — it's a fixed overlay that sits on top of the production console at z-index nine thousand. Your console is still running underneath, all your realtime subscriptions are still live, you haven't navigated away from anything.
>
> At the top: the live session status in red — a pulsing dot and the words 'YOU ARE LIVE'.
>
> In the centre: the session title in massive type — responsive, so it scales with your screen size. Up to eighty pixels on a large display. Below that, the speaker's name.
>
> Below that: the timer. A large monospaced countdown showing minutes and seconds remaining — the exact same clock that drives the timer cards in the session list, synced to the server via CueDeck's clock offset mechanism.
>
> At the bottom of the centre section: the next session. Title, speaker, room, scheduled start time — everything the director needs to think one step ahead.
>
> And in a thin footer bar at the very bottom: the live clock on the right, the event name on the left."

---

## THE TIMER COLOUR STATES (1:20–2:10)

[Screen: Stage monitor showing a LIVE session — pan through different timer colours as described]

> "The timer on the stage monitor uses the same three-colour scheme you'll see everywhere in CueDeck.
>
> Green: the session has more than five minutes remaining. You're in good shape. The label below the timer says 'REMAINING'.
>
> Amber: under five minutes left. The timer colour shifts to amber and the label changes to 'WRAPPING UP'. This is your nudge to start thinking about the transition.
>
> Red: under two minutes. The label becomes 'ENDING NOW'. Time to get ready to call the next session to stage.
>
> If the session goes into OVERRUN — past its scheduled end time — the timer flips to show a positive number and the label changes to 'OVERTIME'. The timer counts upward, telling you exactly how far over time you are.
>
> These thresholds are the same five-minute and two-minute marks used in the session cards and the stage timer display mode — the whole system speaks the same visual language."

---

## WHAT DIRECTORS USE IT FOR (2:10–2:55)

[Screen: Stage monitor still open — zoom out to show it on a screen with other peripherals visible in the shot]

> "In practice, the Stage Confidence Monitor is for a very specific moment: when the director needs to be physically watching something else — the stage door, the operator feed, a conversation with the venue manager — but still needs peripheral awareness of the current session state.
>
> You pop it open on a secondary monitor or a dedicated screen, and you never have to dig through the session list to answer 'how much time does the current speaker have left'. It's right there, full screen, two metres away.
>
> It also syncs immediately with state changes. The moment you or another director transitions the session — ENDED, HOLD, OVERRUN — the stage monitor updates. No delay, no refresh. The live session switches, the next session moves up, and the timer resets for the new context."

---

## THE STANDBY AND READY STATES (2:55–3:35)

[Screen: Stage monitor when no session is LIVE but one is READY — show the standby state]

> "The stage monitor isn't only useful when something is LIVE. When a session is READY or CALLING — meaning it's been flagged to start but hasn't gone live yet — the monitor shows a different state.
>
> The status line changes to 'STANDING BY — STARTING SHORTLY' in amber. The title and speaker are shown. The timer shows the scheduled start time rather than a countdown, and the colour is amber.
>
> And if there's genuinely nothing active at all — between events, or before the first session of the day — the monitor shows 'STANDBY' with the event name, and the next session details below it. You still have context. You're never looking at a blank screen."

---

## CLOSING THE MONITOR (3:35–3:55)

[Screen: Stage monitor with the small 'CLOSE' button visible in the top right corner]

> "To close the monitor, hit the small 'CLOSE' button in the top right corner of the overlay. That's it. Your console comes back exactly as you left it — nothing reloaded, no state lost.
>
> You can also press Escape — the keyboard handler recognises Escape as a dismiss for overlays, so it works here too."

[Screen: Click the close button — the overlay disappears and the console is revealed underneath, unchanged]

---

## WHO ELSE CAN OPEN IT (3:55–4:20)

[Screen: Switch to AV role — show the context panel also has STAGE MONITOR button]

> "Stage Monitor isn't director-only. The AV role and the signage role also have access to the Stage Monitor button in their context panel.
>
> The AV team can open it to keep track of what's live while they're managing their equipment feeds. The signage operator can use it to coordinate timing for manual override actions.
>
> Stage and registration roles don't have the button, because their views already surface what they need at a glance. But any role that benefits from a dedicated confidence display has access to it."

---

## WRAP (4:20–4:45)

[Screen: Stage monitor open with a LIVE session, showing the full layout]

> "Simple feature, high value. One button, full-screen context. The monitor pulls from the same live data as everything else in CueDeck — it's not a separate system or a separate subscription, just a different view on the same state.
>
> In the next episode we move from this director-facing display to something the speaker themselves looks at: the Stage Timer. That's a full-screen countdown designed to sit on a monitor or tablet facing the stage — so the presenter always knows exactly how much time they have. See you there."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck director console with a LIVE session in the session list
- [ ] Scroll to the context panel's Monitor section — highlight the STAGE MONITOR button
- [ ] Click STAGE MONITOR — show the fullscreen overlay appearing
- [ ] Zoom in on the status bar (YOU ARE LIVE + pulsing dot)
- [ ] Zoom in on the session title in large type
- [ ] Zoom in on the speaker name
- [ ] Zoom in on the timer — show it in green (>5 min remaining) with 'REMAINING' label
- [ ] Wait or simulate time passing to show amber (<5 min) with 'WRAPPING UP' label
- [ ] Wait or simulate to show red (<2 min) with 'ENDING NOW' label
- [ ] Simulate OVERRUN state — show timer counting up in red with 'OVERTIME' label
- [ ] Show the NEXT UP section (title, speaker, room, time)
- [ ] Show the footer (event name left, live clock right)
- [ ] End the LIVE session — show monitor switching to standby / READY state
- [ ] Show READY state (amber, 'STANDING BY — STARTING SHORTLY', scheduled start time)
- [ ] Show empty standby state (no active sessions, event name + next session shown)
- [ ] Click the CLOSE button — show overlay dismissing and console returning to normal
- [ ] Switch to AV role — show Stage Monitor button also available in AV context panel
