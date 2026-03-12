# Episode 18 — Mobile & Tablet Use
**Duration target:** 4–5 min
**Style:** Practical and grounding — this episode addresses a real anxiety: "will this work on my device backstage?" The answer is yes, emphatically. Show the device emulation in browser dev tools but frame it around real scenarios: stage manager on an iPad, registration team on a phone, director on a laptop with a tablet beside them as a secondary display. Tone is reassuring but also enthusiastic about the flexibility.

---

## INTRO (0:00–0:30)

[Screen: CueDeck console in a standard desktop browser window — full director view.]

> "One of the questions I get asked most often about CueDeck is: does it work on a tablet? What about a phone? Can my stage manager use it on an iPad?
>
> The answer is yes — and in this episode I'll show you exactly what that looks like. CueDeck is a browser app, which means it runs on any device with a modern browser and an internet connection. The layout adapts to the screen it's on. Let me show you how."

---

## HOW THE LAYOUT ADAPTS (0:30–1:30)

[Screen: Open browser developer tools. Switch to device emulation mode. Set device to iPad (768px wide). The CueDeck console reloads in the emulated viewport.]

> "I'll use the browser's device emulation tools so you can see the responsive layout clearly. This is what CueDeck looks like on an iPad in portrait orientation.
>
> Notice what's changed. The role bar — the strip of role buttons at the top — has wrapped onto two lines instead of trying to squeeze into one. The session list takes up the full width of the screen. The context panel, which on desktop sits to the right of the session list, moves to a sheet that slides up from the bottom when you tap a session."

[Screen: Tap a session card. The context panel slides up from the bottom as a sheet — showing the session title, current status, and action buttons.]

> "On a tablet the interaction model is tap-first. Tap a session to select it. The action sheet comes up. Tap the action button to trigger the transition. It works exactly the same as the desktop version — just with your thumb instead of a mouse.
>
> The context panel sheet uses the same data, the same real-time sync, and the same state machine. Nothing is simplified or removed — it's the same production tool."

---

## STAGE MANAGER ON AN IPAD (1:30–2:20)

[Screen: Keep the iPad emulation. Switch role to Stage. The view simplifies: session list only, smaller context buttons, no AI panels or billing — stage-appropriate information only.]

> "Here's the setup I'd recommend for a stage manager running a single room.
>
> They're in Stage role. They have an iPad on a stand or a table just offstage — portrait orientation, tablet stand, screen always on. They can see the entire session list for their room — filter by room, and only their sessions are showing. When a speaker arrives they tap the session, tap Speaker Arrived, the director sees it immediately.
>
> When it's time to go live — if the stage manager has that permission — one tap, one confirmation, the session is live. No radio call needed. The director sees it on their screen the same moment the stage manager taps the button."

[Screen: In Stage role, tap a PLANNED session — context sheet opens. Show the SET READY button prominently. Tap it — show the session badge changing to READY with a green flash.]

> "The buttons are large enough for reliable touch input. There's no tiny click target that's easy to misfire when you're under pressure. The state machine still enforces all the same rules — you can't accidentally put something LIVE that isn't READY first."

---

## REGISTRATION ON A PHONE (2:20–3:00)

[Screen: Switch device emulation to iPhone (390px wide). Switch role to Registration (Reg).]

> "Now let's look at a phone — this is the registration desk use case.
>
> The Registration role has the simplest view in CueDeck: the upcoming session queue, who's on next, and a read-only status of what's live right now. That's all the information a registration team needs — they're not running transitions, they're answering attendee questions.
>
> On a phone that view stacks cleanly. Session cards fill the full width, the current status badge is large enough to read at a glance, and the next session's speaker name and title are prominent.
>
> A registration team member can keep this open on their personal phone or a shared device at the desk, and the screen updates automatically without a refresh. The moment the director takes a session LIVE, it appears here."

[Screen: Show the Reg role view on mobile — session queue, current session highlighted, next session visible below. Show a session badge updating from PLANNED to LIVE without any user action — simulating a realtime update.]

> "No app to install. They sign in, pick their role, and the screen stays live all day."

---

## DIRECTOR ON A TABLET (SECONDARY DISPLAY) (3:00–3:30)

[Screen: Switch to a tablet view again. Switch back to Director role. Show the full director view on tablet.]

> "For directors who run on a laptop with a tablet beside them — this is a useful configuration. The tablet is your second monitor. Open CueDeck in Safari on the iPad, keep it in landscape orientation, and you have the full director view with all controls available.
>
> Some directors I've spoken to use the tablet specifically for the signage panel — they keep their signage displays open on the iPad so they can monitor what's showing on the venue screens without switching windows on their laptop. Two views, one account, fully synced."

---

## PRACTICAL SETUP TIPS (3:30–4:10)

[Screen: Browser dev tools still open. Toggle between phone and tablet sizes to illustrate each point as it's mentioned.]

> "A few practical tips for mobile and tablet setups.
>
> First: use a dedicated browser tab, not a general browsing session. Keep CueDeck as its own pinned tab on the device. It's easier to find under pressure.
>
> Second: on iOS, you can add CueDeck to your Home Screen from Safari — tap the share button and choose 'Add to Home Screen'. It opens full-screen like a native app, no browser chrome. That's a cleaner experience on an iPad in portrait on a stand.
>
> Third: keep the screen on. Most tablets dim the display after a minute of no interaction. Go into your device settings and set the screen timeout to 'Never' or the longest available option for show day. You don't want the screen going dark while you're watching a speaker.
>
> Fourth: about internet connectivity. CueDeck requires an active internet connection for realtime sync — it's communicating with Supabase for every state change and every broadcast. If you're backstage at a venue with unreliable WiFi, test your connection before the event starts. A strong 4G signal on a mobile data connection is a reliable fallback."

---

## WRAP (4:10–4:40)

> "CueDeck works on any modern browser, on any device. The layout adapts, the touch targets are the right size, and every role is usable on a phone or tablet without any feature degradation.
>
> For most production teams the sweet spot is: director on a laptop, stage managers on tablets, registration on phones. Everyone connected, everyone synced, no one staring at a laptop screen when they should be watching the stage.
>
> Next episode is about billing — the plans, the pricing, how the per-event credit option works, and how to upgrade when your team is ready. I'll see you there."

[End card: subscribe + episode 19 thumbnail]

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console as Director in a standard desktop browser window
- [ ] Open browser developer tools (F12 / Cmd+Option+I)
- [ ] Switch to device emulation / responsive mode
- [ ] Set device to iPad (768px wide) — show layout reflow
- [ ] Show role bar wrapping to two lines
- [ ] Tap a session card — show context panel sliding up as bottom sheet
- [ ] Show session title, status badge, and action buttons in the sheet
- [ ] Switch role to Stage in iPad emulation
- [ ] Show session list only, no AI or billing panels
- [ ] Tap a PLANNED session — show SET READY button
- [ ] Tap SET READY — show badge changing PLANNED → READY with green flash
- [ ] Switch device to iPhone (390px wide)
- [ ] Switch role to Registration (Reg)
- [ ] Show registration queue view — current session, next session, read-only statuses
- [ ] Simulate a realtime update — show a session badge changing without user action
- [ ] Switch back to tablet, Director role — show full director view in landscape
- [ ] Demonstrate Add to Home Screen tip on iOS (narrate over mock Safari share sheet or describe)
- [ ] Toggle between phone/tablet in dev tools while narrating setup tips
- [ ] Close dev tools, return to normal desktop view for wrap
