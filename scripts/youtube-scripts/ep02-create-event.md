# Episode 02 — Setting Up Your First Event in CueDeck
**Duration target:** 5–7 min
**Style:** Hands-on walkthrough — create a real event live on screen

---

## INTRO (0:00–0:30)

[Screen: console, no event selected yet]

> "In episode one we got a quick tour of CueDeck. Now let's actually build something. In the next few minutes I'm going to create a full conference event, add sessions, and have it ready to run live.
>
> This is 'Tech Summit 2026' — a single-day tech conference in London. Let's go."

---

## SIGNING IN (0:30–1:00)

[Screen: app.cuedeck.io — show the sign-in page]

> "You land here. Enter your email and password, hit sign in. CueDeck uses Supabase Auth under the hood — your credentials are secure and the session persists across tabs.
>
> First time here? Click 'Create Account', enter the invite code your director gave you, or start a free trial. We'll cover the invite flow in episode seven."

[Action: log in as demo@cuedeck.io]

---

## THE SETUP WIZARD (1:00–2:00)

[Screen: setup wizard appears for new account]

> "For a brand new account, the setup wizard kicks in. Four steps — create your event, add a session, invite your team, set up a display.
>
> Let's follow it. Step one: create the event."

[Action: fill in wizard step 1]

> "Name: Tech Summit 2026. Date: April 15th. Timezone: Europe London. Event runs 9am to 6pm. Venue: Grand Convention Centre London. Hit Save."

---

## ADDING SESSIONS (2:00–4:30)

[Screen: session list — empty after event creation]

> "Now we have an event with no sessions. Let's add them. Click the plus button."

[Action: open session modal]

> "Each session has a title, a type — keynote, panel, workshop, break, sponsor — a room name, a speaker, their company, planned start and end times, and a sort order to control the running order.
>
> I'll also tick 'Recording' and 'Streaming' for the keynote — these flags appear on every role's view so the AV team knows what to prep."

[Action: fill in session 1 — Opening Keynote, Sarah Chen, 09:30–10:15, Main Stage]

> "Save. There it is — first session, status PLANNED, showing in the list."

[Action: add 2 more sessions quickly — Panel 10:30, Lunch break 12:00]

> "I'll add a few more — a panel and a lunch break. Notice the lunch break is type 'break' so it renders with a different visual treatment in the list.
>
> In a real event you'd add all ten or twenty sessions up front. You can also duplicate sessions from a previous event — there's a seed-from option in the event modal that copies the full schedule."

---

## REORDERING & EDITING (4:30–5:30)

[Screen: show drag-to-reorder or sort order edit]

> "Need to reorder? Click the up/down arrows on any session card, or edit the sort_order directly. The list re-sorts instantly.
>
> To edit a session — click anywhere on the card. The modal comes back pre-filled. Change the speaker, adjust the time, tick or untick flags. Save."

---

## QUICK FILTER BAR (5:30–6:30)

[Screen: filter bar — type in search, click room filter]

> "Once you have a full programme, the filter bar keeps you sane. Type a speaker name — matching sessions surface immediately. Click a room chip to see just that room's schedule. Filter by status to find everything that's still PLANNED.
>
> These filters are local — they don't affect what anyone else sees."

---

## WRAP (6:30–7:00)

> "That's it — event created, sessions in, programme structured. In the next episode we'll go live for the first time and walk through the full session state machine — READY, CALLING, LIVE, HOLD, ENDED.
>
> Subscribe so you don't miss it. See you in episode three."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Sign in as demo@cuedeck.io
- [ ] Setup wizard — create Tech Summit 2026 event
- [ ] Add Opening Keynote session (all fields filled)
- [ ] Add Panel session
- [ ] Add Lunch Break session (type: break)
- [ ] Show drag reorder or sort edit
- [ ] Edit a session, change speaker name, save
- [ ] Use search filter bar — type "Sarah"
- [ ] Use room filter — click "Main Stage"
