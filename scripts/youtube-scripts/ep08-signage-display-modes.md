# Episode 08 — Signage Display Modes: All 11 Modes Explained
**Duration target:** 8–10 min
**Style:** Visual showcase. Move briskly through modes with a consistent rhythm — show the live screen for each mode, then narrate what it's designed for. Deep-dive on 3–4 modes; quick-fire the rest.

---

## INTRO (0:00–0:30)

[Screen: CueDeck display page cycling through several different modes — quick montage]

> "CueDeck's display system has eleven content modes. Each one is designed for a specific screen, a specific moment, or a specific audience in your venue. In this episode we're going through all of them — what they look like, what they're for, and when to use them.
>
> I'll go deep on the four most commonly used modes and move quicker through the rest. Let's go."

---

## MODE OVERVIEW — THE FULL LIST (0:30–1:00)

[Screen: CueDeck display modal — scroll through the content mode dropdown showing all 11 options]

> "The eleven modes are: Schedule, Agenda, Sponsor, Countdown, Clock, Next Up, Ticker, Recall, Timeline, Programme, and Stage Timer.
>
> Each one pulls live data from Supabase in real time. There's no refresh button, no manual updates. When a session goes LIVE in the console, every display showing schedule or agenda data updates automatically within a second.
>
> Let me walk through each one."

---

## MODE 1 — SCHEDULE (1:00–2:20)

[Screen: Display page in schedule mode — full session list with live status badges]

> "Schedule is the workhorse mode. It shows the full programme list for today's event — all sessions in chronological order, with the session title, speaker, room, planned time, and current status.
>
> Sessions that are LIVE or in OVERRUN get a pulsing green badge. Sessions that are READY or CALLING get an amber 'coming up' indicator. Ended sessions are dimmed. Cancelled sessions disappear.
>
> If you've applied a delay in the production console, the scheduled times shown here update to reflect that. So your lobby screens are always showing the current working programme, not the original one from last week.
>
> Best used for: main lobby entrance displays, registration area, any screen where attendees need to know the full day's programme at a glance.
>
> In the display modal, you can add a Room filter — that limits this display to only showing sessions from one specific room, which is great for corridor screens outside a particular hall."

[Screen: Apply a room filter in the modal — show the display narrowing to only that room's sessions]

---

## MODE 2 — AGENDA (2:20–3:15)

[Screen: Display page in agenda mode — room column grid]

> "Agenda is the room grid view. Instead of a single chronological list, it shows multiple columns — one per room — each with that room's sessions stacked in time order.
>
> This is your 'at-a-glance what's happening in all rooms right now' mode. Up to four columns fit comfortably on a landscape screen. LIVE sessions get a bold green card. READY sessions get a ready indicator.
>
> Best used for: foyer screens at the entrance to a multi-track conference, where attendees are choosing which session to attend. It lets them compare tracks in one look rather than scanning a linear list."

---

## MODE 3 — TIMELINE (3:15–4:00)

[Screen: Display page in timeline mode — chronological vertical list with time column on the left]

> "Timeline is similar to Schedule but with a cleaner two-column layout: a left column showing the start time, and a right column with the session title, speaker, room and duration. There's no room filter grid here — it's all sessions in one stream, sorted by time.
>
> The real difference from Schedule is the scroll and paginate behaviour. Timeline mode supports both smooth auto-scroll and page-by-page pagination, which you configure in the display settings. This makes it ideal for a tall portrait screen — a vertical monitor mounted in a column or on a stand.
>
> Best used for: tall format lobby displays, tablet stands, or portrait orientation kiosks."

---

## MODE 4 — PROGRAMME (4:00–4:45)

[Screen: Display page in programme mode — time × room grid]

> "Programme is the most information-dense mode. It's a matrix: time on the vertical axis, rooms across the horizontal. Each cell is a session block, sized to reflect its actual duration.
>
> Think of it as a visual conference schedule grid — the kind you'd see printed in a conference booklet, but live and updating.
>
> Best used for: large lobby screens where attendees have time to study the grid, or a director's secondary monitor for a quick structural overview of the day. It works best with landscape orientation and at least a 1080p display."

---

## MODE 5 — NEXT UP (4:45–5:30)

[Screen: Display page in nextup mode — large current session + smaller next session below]

> "Next Up is a two-panel display: the current LIVE or READY session fills the top two-thirds of the screen in large type — title, speaker, room. The bottom third shows the next session coming up.
>
> This is a production-oriented mode. It's for the screen at the back of the main hall that the director glances at to confirm what's live, or for a confidence monitor at the stage entrance so the next speaker knows they're coming up.
>
> The live session shows a pulsing LIVE badge. When the session ends and the next one becomes live, the display transitions automatically — no manual action needed."

---

## MODE 6 — COUNTDOWN (5:30–6:00)

[Screen: Display page in countdown mode — large countdown timer to the next session start]

> "Countdown shows a single large timer counting down to the start of the next session, or to the start of the event if nothing has begun yet.
>
> Best used for: pre-event lobby screens building anticipation before the opening keynote, or a break screen showing how many minutes are left in the coffee break before the next session begins."

---

## MODE 7 — CLOCK (6:00–6:20)

[Screen: Display page in clock mode — huge time display]

> "Clock is exactly what it sounds like: a full-screen clock showing the current time in large format. CueDeck uses its server-synced clock — the same `correctedNow()` function that drives all timing in the production console — so the clock on your display is accurate to within a few milliseconds of the server.
>
> Best used for: registration areas, the back of the room for the director's reference, or anywhere a precise time display is more useful than programme information."

---

## MODE 8 — SPONSOR (6:20–7:00)

[Screen: Display page in sponsor mode — sponsor logos rotating on screen]

> "Sponsor mode cycles through your sponsor logos — images you upload to CueDeck's asset store in the Sponsors section of the signage panel. Each logo appears full-screen or in a grid depending on how many sponsors you've uploaded, and the display rotates through them automatically.
>
> Sponsorship is a revenue stream at most events, and sponsors expect their logo to be visible. Sponsor mode lets you run a professional-looking sponsor reel on any display without any video editing or external software.
>
> Best used for: break screens, lobby displays during registration, corridor monitors between sessions."

---

## MODE 9 — TICKER (7:00–7:20)

[Screen: Display page in ticker mode — scrolling text bar across the bottom or full screen]

> "Ticker shows a scrolling text message — like a news ticker. The message comes from the Broadcast bar in the production console. When the director sends a broadcast, displays in ticker mode scroll it across the screen.
>
> Best used for: supplementary information screens, announcements during sessions — things like 'Lunch is now being served in the Atrium' — where you want a non-intrusive rolling message rather than a full-screen alert."

---

## MODE 10 — RECALL (7:20–7:50)

[Screen: Display page in recall mode — large 'PLEASE RETURN TO YOUR SEATS' message with a timer]

> "Recall is a dedicated speaker and attendee recall mode. It shows a large-format 'PLEASE RETURN TO YOUR SEATS' or speaker recall message, with a countdown timer.
>
> The signage operator can trigger this globally from the context panel with a single button — it overrides all displays simultaneously and shows the recall screen. When the recall is cleared, displays snap back to their configured modes.
>
> Best used for: end-of-break recall, between sessions when you need people moving quickly."

---

## MODE 11 — STAGE TIMER (7:50–8:30)

[Screen: Display page in stage-timer mode — large green countdown, title at bottom]

> "Stage Timer is the newest mode and probably the most important one for your on-stage team. It turns a display into a speaker-facing countdown timer — the clock the presenter looks at while they're talking.
>
> You get a huge colour-coded countdown: green when there's plenty of time, amber when under five minutes, red when under two minutes. OVERRUN switches to a flashing red plus-MM:SS counter. HOLD freezes the timer in orange with a PAUSED indicator. And when nothing is live yet, it shows a 'NEXT UP IN' countdown.
>
> This mode gets its own full episode — episode ten — where we'll walk through every state in detail. But the quick summary is: one display, one URL, the speaker is always informed."

---

## THE GLOBAL OVERRIDE (8:30–9:10)

[Screen: Signage role context panel — showing the four global override buttons]

> "Before we close out, one more thing: global overrides. These appear in the context panel for the director and signage role, and they let you switch all displays simultaneously with a single click.
>
> Break Screen puts everything into a neutral break mode. Five-Minute Recall triggers the recall screen across all displays. Sponsor Reel pushes every display into sponsor rotation. Back to Schedule clears the override and restores each display to its configured mode.
>
> These overrides bypass individual display settings temporarily. When you clear them, every display goes back to whatever mode you originally configured for it. It's the fastest way to manage a whole venue when you need instant control."

[Screen: Click 'Break Screen' — show all displays in the panel switching to override indicator, then switch to the display tab and see the break screen]

---

## WRAP (9:10–9:40)

[Screen: Display modal with the content mode dropdown visible]

> "Eleven modes, each with a specific job. The ones you'll use most are probably Schedule for the lobby, Next Up for the stage entrance, Stage Timer for the speaker-facing monitor, and Sponsor for breaks — but they're all there when you need them.
>
> Set a display to sequence mode and it can rotate through several of these automatically, giving you a professional multi-format display without any manual intervention throughout the day.
>
> Next episode: the Stage Confidence Monitor. That's the fullscreen overlay on the director's own screen — a different tool from signage, purpose-built for the person running the show. See you there."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open the display modal and slowly scroll through all 11 modes in the dropdown
- [ ] Open display tab in schedule mode — show full session list with live badges
- [ ] Apply a room filter in display modal — show display narrowing to one room
- [ ] Switch display to agenda mode — show the room column grid with LIVE card highlighted
- [ ] Switch display to timeline mode — show two-column time+session layout
- [ ] Switch display to programme mode — show the time×room matrix grid
- [ ] Switch display to nextup mode — show current LIVE + next session two-panel layout
- [ ] Switch display to countdown mode — show large countdown timer to next session
- [ ] Switch display to clock mode — show large full-screen clock
- [ ] Switch display to sponsor mode — show sponsor logos cycling
- [ ] Switch display to ticker mode — show scrolling broadcast message
- [ ] Switch display to recall mode — show the recall screen with countdown
- [ ] Switch display to stage-timer mode — show the green countdown with session title
- [ ] Open signage context panel — show the 4 global override buttons
- [ ] Click 'Break Screen' override — show all display cards switching to override state
- [ ] Switch to display tab — confirm break screen is showing
- [ ] Click 'Back to Schedule' to clear override — confirm display reverts
