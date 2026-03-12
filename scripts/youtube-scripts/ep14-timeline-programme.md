# Episode 14 — Timeline & Programme Signage Modes
**Duration target:** 5–7 min
**Style:** Visual and spatial; this is about what attendees see on the screens in the venue; narration should paint a picture of the physical space — lobby monitors, large format displays — and how these modes serve people navigating a conference

---

## INTRO (0:00–0:35)

[Screen: CueDeck display page open in a separate browser window — full-screen dark background with a vertical list of sessions scrolling smoothly; on another half of the screen, the console]

> "Attendees at a conference shouldn't need to check their phones to know what's on next. They should be able to look up at a screen and see exactly what's happening now, what's coming up, and where it is.
>
> CueDeck has two signage modes built specifically for this: Timeline and Programme. Timeline is a vertical chronological list — great for lobby screens and corridor monitors. Programme is a time-by-room grid — the kind of grid you'd see on a large conference board.
>
> Both update in realtime as your sessions go live, overrun, or end. Let me walk you through setting them both up."

---

## THE SIGNAGE PANEL (0:35–1:10)

[Screen: CueDeck console, Signage panel — show the list of configured displays in the sidebar with their zone types and content modes listed beneath each name]

> "Signage is managed from the Signage panel in CueDeck — accessible from the left sidebar. Each display you've configured shows here as a card: its name, zone type, orientation, and the current content mode.
>
> If you haven't set up any displays yet, there's an Add Display button at the top. Each display corresponds to a physical screen somewhere in your venue — a lobby monitor, a stage confidence screen, a hallway TV.
>
> For today's episode, I already have a few displays configured. We'll edit two of them — one for Timeline and one for Programme."

---

## SETTING UP A TIMELINE DISPLAY (1:10–2:20)

[Screen: click on an existing display to open the edit modal — show the Content Mode dropdown; select "Timeline"; the scroll style and paginate settings appear below]

> "To set a display to Timeline mode, open it in the Signage panel and set the Content Mode to Timeline. That's it — one dropdown.
>
> But there are two options worth understanding: scroll style and paginate.
>
> Scroll means the list animates continuously from bottom to top — like a news ticker, but for your conference schedule. This is ideal for a screen that's visible from a distance and people are glancing at while walking past. It's always moving, always showing new content.
>
> Paginate means the list shows a full page of sessions, holds for a set number of seconds — you configure this, typically between eight and fifteen seconds — and then advances to the next page. This is better for a screen where people are standing and reading, because the content stays still long enough to be read properly.
>
> I'll set this one to Paginate, ten seconds per page, and save it."

---

## WHAT TIMELINE LOOKS LIKE (2:20–3:05)

[Screen: switch to the cuedeck-display.html tab showing the Timeline mode — full-screen dark background; sessions listed vertically with time on the left, title and room on the right; LIVE session has a green dot and "LIVE" badge; ENDED sessions are visually dimmed; upcoming sessions are full brightness]

> "Here's what the display looks like. Timeline mode renders a vertical chronological list of all sessions for the day — time on the left, session title and room on the right.
>
> The LIVE session has a green indicator — it stands out immediately on a dark screen from across a lobby. Sessions that have already ended are visually dimmed, so the focus naturally falls on what's current and upcoming. Future sessions are at full brightness.
>
> This updates in realtime. When a director hits Go Live in the console, that session's status on this screen changes within a second — no refresh, no delay. A lobby screen running Timeline is always accurate."

---

## SETTING UP A PROGRAMME DISPLAY (3:05–3:55)

[Screen: open a second display in the edit modal; set Content Mode to "Programme"; save it; switch to the display tab]

> "Now let's set up Programme mode. Same process — open the display, set the Content Mode dropdown to Programme.
>
> Where Timeline is a vertical list, Programme renders as a grid: time slots run down the left side, rooms run across the top. Each cell in the grid shows the session in that room at that time. It reads exactly like the printed conference programme that delegates pick up at registration.
>
> This is the mode you want on a large-format screen — a wide television in the main lobby, a display at the registration desk, or a screen at the entrance to the session floor where people are choosing which room to go to."

---

## WHAT PROGRAMME LOOKS LIKE (3:55–4:45)

[Screen: Programme display mode — a grid with time rows and room columns; session titles visible in cells; LIVE cell has a green indicator; empty cells are blank or greyed; colour coding may distinguish session types]

> "Here's the Programme grid. Rooms across the top — Hall A, Hall B, Workshop Room, Breakout — and time slots down the left. Each session sits in the correct cell.
>
> The currently LIVE session has a green highlight in its cell. As sessions end and new ones go live, the grid updates automatically.
>
> You can also configure the paginate setting for Programme mode, exactly the same as Timeline. If you have a very large conference — a lot of rooms, a lot of time slots — the grid might not fit on one screen, so you configure pages with an automatic advance interval.
>
> For most single-day conferences with three to five rooms, the Programme grid fits comfortably on a 55-inch screen in landscape orientation."

---

## SCROLL VS PAGINATE — QUICK COMPARISON (4:45–5:20)

[Screen: split view or rapid cut between scroll version and paginate version of Timeline — show the scroll animating smoothly, then the paginate version sitting still for several seconds before advancing]

> "Quick comparison so the difference is clear.
>
> Scroll is best for: lobby corridors, anywhere screens are glanced at while moving, long session lists that would take multiple pages.
>
> Paginate is best for: screens where people stop to read, registration desk displays, anywhere the audience is stationary.
>
> The paginate interval — how many seconds per page — is set per display. You can tune it independently for each screen. A large lobby screen might flip every twelve seconds. A registration desk screen might sit for twenty seconds because delegates are standing there reading every line.
>
> Both settings are saved per display and persist across sessions and page refreshes."

---

## REALTIME UPDATES IN CONTEXT (5:20–5:55)

[Screen: side-by-side or alt-tab: console on one side, the display page on the other; director clicks Go Live on a session in the console; on the display side, the Timeline immediately shows that session with a LIVE indicator]

> "This is worth seeing live. On the left, the director console. On the right, the Timeline display.
>
> I'll click Go Live on the next session — and watch what happens on the display.
>
> The session immediately gets a green LIVE badge. The previous session dims to ENDED. The whole list reflows. All of this happens via a Supabase realtime subscription — the display page is listening for postgres changes on the session table and re-renders as soon as any status changes.
>
> Your venue's displays are always showing the current state of the event."

---

## WRAP (5:55–6:30)

[Screen: both display modes visible — Timeline on one screen, Programme on another]

> "Timeline for corridors and lobbies. Programme for overview screens and registration areas. Both update live, both support scroll and paginate, both are configured from the Signage panel in under a minute.
>
> In the next episode, the final piece of the signage system: sponsor logos. How to upload your sponsor branding, configure rotation timing, and build a display sequence that rotates between the sponsor mode and the session modes automatically. That one is short and practical — I'll see you there."

[End card: subscribe + episode 15 thumbnail]

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console as Director with Signage panel visible
- [ ] Show existing display list in the Signage panel sidebar
- [ ] Click an existing display to open the edit modal
- [ ] Set Content Mode to "Timeline"
- [ ] Show scroll style dropdown — select "Paginate"
- [ ] Set paginate seconds to 10
- [ ] Save the display
- [ ] Switch to cuedeck-display.html tab showing Timeline mode
- [ ] Show vertical session list: time on left, title + room on right
- [ ] Point out LIVE session (green indicator), ENDED sessions (dimmed), upcoming (full brightness)
- [ ] Return to console, open a second display, set Content Mode to "Programme"
- [ ] Save and switch to display tab showing Programme mode
- [ ] Show time×room grid: rooms across top, time slots down left, sessions in cells
- [ ] Point out green LIVE cell in the grid
- [ ] Return to console — side-by-side if possible with display visible
- [ ] Click "Go Live" on a session — show display updating in real time with LIVE indicator
- [ ] Show Timeline and Programme modes side by side briefly for comparison
