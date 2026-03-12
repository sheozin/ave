# Episode 07 — Digital Signage: Setting Up Your Displays
**Duration target:** 6–8 min
**Style:** Step-by-step setup walkthrough. Calm and practical — this is configuration work. Narrate every click. Show the end result on a second screen/tab.

---

## INTRO (0:00–0:35)

[Screen: Wide shot of a venue lobby — or mock it with a browser window showing a CueDeck display in full-screen schedule mode]

> "Every conference venue has screens. Lobby displays. Corridor monitors. The big screen at the back of the main hall. Right now, most of those screens are showing a static PowerPoint slide someone emailed to AV three days ago.
>
> With CueDeck's signage system, every one of those screens can show live, realtime data from your production console. Session status, countdowns, the current speaker, your sponsor reel — all updating automatically the moment anything changes. And setting it up takes about two minutes per screen.
>
> Let's do it."

---

## WHAT THE SIGNAGE SYSTEM DOES (0:35–1:30)

[Screen: CueDeck director console with the Signage panel visible in the sidebar]

> "The signage system in CueDeck has two parts.
>
> The first part is the Signage panel inside the production console — that's where the director configures displays, sets their modes, and manages everything. You can see it here in the left sidebar. It's only visible to directors and to operators assigned the Signage role.
>
> The second part is the display page — that's `cuedeck-display.html`, or the `/display` path if you're on `app.cuedeck.io`. This is the page you open on the physical screens around your venue. It connects to Supabase in real time and renders whatever mode you've configured for that display.
>
> Each display in the system is a row in the database. It has a name, a zone, a content mode, and a unique URL. You open that URL on any screen — a browser tab in kiosk mode, a Raspberry Pi, a signage player, anything with a modern browser — and it stays live for the duration of the event."

---

## OPENING THE SIGNAGE PANEL (1:30–2:10)

[Screen: CueDeck console director view — scroll down or click to expand the Signage section in the sidebar]

> "In the director console, scroll down the left sidebar and you'll find the Signage section. If you don't see it, make sure you're logged in as a director — signage configuration is director-only.
>
> The panel shows you all the displays registered to this event. Each card has a name, a zone type — like 'lobby' or 'stage' — the content mode, the orientation, and a coloured dot that tells you whether the display is currently online.
>
> A green dot means the display page pinged the server within the last sixty seconds. Grey means it hasn't been seen recently — either the screen is off, or no one has opened that URL yet. That's useful context when you're setting up on the day: you can glance at the panel and know which screens are up and running."

---

## ADDING YOUR FIRST DISPLAY (2:10–3:45)

[Screen: Click the + Add Display button in the signage panel to open the display modal]

> "Let's add a display. Click the plus button in the signage panel header. A modal opens — this is where you configure everything about one screen.
>
> First, give it a name. Something descriptive like 'Main Lobby Left' or 'Stage Left Monitor'. This is just for your reference in the panel — the physical screen doesn't show it.
>
> Zone type is the physical location category — lobby, stage, corridor, registration. This is also for your own organisation; it groups the cards in the panel by zone.
>
> Orientation: landscape or portrait. This tells the display page how to lay out the content. A portrait display — say, a vertical screen mounted in a column — will get a layout optimised for that aspect ratio.
>
> Content mode is the most important setting. This is what the screen actually shows. We'll cover all eleven modes in detail in the next episode, but for now I'll pick 'schedule' — that's the full programme list with live status badges on each session.
>
> Then there's the Room filter. If you only want this display to show sessions from a specific room — say, Hall A — you can set that here. Leave it blank and the display shows all sessions.
>
> Hit Save."

[Screen: Click Save — the display card appears in the signage panel]

> "The display card appears in the panel immediately. It starts grey because no one has opened the display URL yet — we'll fix that in a moment."

---

## THE DISPLAY URL (3:45–4:30)

[Screen: Show the display card in the signage panel — click the 'Open' or URL button]

> "Each display card has an Open button and a URL. Click Open and it launches the display page in a new tab, pre-loaded with this display's ID.
>
> The URL looks something like this — `app.cuedeck.io/display?id=abc123`. That `id` parameter is what ties this browser window to this specific display configuration in the database. Whatever you change in the signage panel for this display, that URL will reflect it, in real time, without refreshing.
>
> In practice: you copy this URL, paste it into the browser on the physical screen, and hit full-screen. That's your setup. The screen is now live."

[Screen: Open the URL in a new tab and show the schedule mode loading — with live session data populating]

> "There it is — a full-screen schedule view, dark background, showing all the sessions for today's event with their live status. Any session that goes LIVE right now will light up with the live badge on this screen instantly."

---

## CONFIGURING A SEQUENCE (4:30–5:45)

[Screen: Open the display modal again for the same display — scroll down to the Sequence section]

> "Now let's talk about one of the more powerful features: sequences.
>
> Instead of showing a single mode forever, a display can cycle through multiple modes on a timer. This is perfect for a lobby screen — sponsors for twenty seconds, then the schedule, then the countdown to the next session, then back to sponsors.
>
> Scroll down in the display modal to the Sequence section. Click Add Slide."

[Screen: Click Add Slide — a row appears with a mode dropdown and a duration input]

> "Each slide has two settings: the mode to show, and the number of seconds to show it for. I'll add three slides: sponsors for twenty seconds, schedule for thirty, and countdown for fifteen.
>
> You can add as many slides as you like. Drag to reorder them if you need to.
>
> Now hit Save. The display will begin cycling through these modes automatically. There's no reload — the display page reads the sequence from the database and starts the rotation as soon as it detects the change."

[Screen: Switch to the display tab — watch it cycle from schedule to sponsors]

---

## SCROLL VS PAGINATE (5:45–6:20)

[Screen: Re-open the display modal, show the Scroll Style dropdown and the Seconds/Page input]

> "There's one more setting worth knowing before we move on: scroll style. For modes that show a list — like schedule, timeline, or agenda — you can choose how the display handles content that's too long to fit on screen at once.
>
> 'Scroll' does a continuous slow auto-scroll, looping back to the top when it reaches the bottom. This looks great on a lobby display that people glance at while walking past.
>
> 'Paginate' instead shows a full page of sessions, holds for a set number of seconds, then cuts to the next page. The seconds-per-page field appears when you select this option — the default is ten seconds.
>
> Paginate is better for a seated audience who needs to read the full session titles carefully. Scroll is better for passing traffic."

---

## THE SIGNAGE ROLE (6:20–6:55)

[Screen: Show the Operators panel with a user assigned the 'signage' role]

> "One last thing: you don't have to run the signage panel yourself. If your venue has a dedicated AV operator or a signage technician, you can assign them the Signage role in the Operators panel.
>
> The Signage role gives that person access to the signage panel and the context panel's global override buttons — things like putting all screens into break mode, triggering a speaker recall, or swapping to the sponsor reel with one click. They can manage all the physical displays without ever touching session controls.
>
> We'll see those global override buttons in action when we get to the display modes episode."

---

## WRAP (6:55–7:30)

[Screen: Back to the director console with the signage panel showing two or three green-dot displays]

> "So in about five minutes we went from nothing to a live signage system. We added a display, got its URL, opened it on a second screen, configured a sequence, and set up scroll behaviour.
>
> The key things to remember: every display has a unique URL tied to its database ID. Whatever you change in the signage panel updates the display in real time. And sequences let you rotate through multiple modes so one screen can do the work of three.
>
> In the next episode, we're doing a full tour of all eleven signage display modes — what each one looks like, when to use it, and how they adapt to your live event data. See you there."

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck director console with an active event loaded
- [ ] Scroll the left sidebar to show the Signage section / panel
- [ ] Show an empty signage panel with no displays configured
- [ ] Click the + Add Display button to open the display configuration modal
- [ ] Fill in: Name ("Main Lobby Left"), Zone Type (lobby), Orientation (landscape), Content Mode (schedule)
- [ ] Click Save and show the display card appearing in the panel (grey/offline dot)
- [ ] Click the Open button on the display card to launch the display URL in a new tab
- [ ] Show the display tab loading the schedule mode with live session data
- [ ] Switch back to the console tab — re-open the display modal
- [ ] Scroll to the Sequence section — click Add Slide three times (sponsors 20s, schedule 30s, countdown 15s)
- [ ] Click Save — switch to display tab and show it cycling between modes
- [ ] Re-open display modal — show Scroll Style dropdown (scroll vs paginate) and Seconds/Page input
- [ ] Switch to paginate, set 10 seconds — click Save
- [ ] Show Operators panel with a user having the signage role assigned
- [ ] Return to signage panel showing green-dot displays
