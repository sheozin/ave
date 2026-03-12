# Episode 11 — AI Incident Advisor
**Duration target:** 5–6 min
**Style:** High-energy, high-stakes demo; treat the AI response as the payoff moment; narration is calm but urgent, like a director who has seen things go wrong before

---

## INTRO (0:00–0:30)

[Screen: CueDeck console, a live event in progress — one session is LIVE, the session list has three more queued up]

> "It's the middle of a keynote. The speaker's laptop has just died. Slides are frozen on the projector. The room is watching. Your AV engineer is on comms but everyone is talking at once and nobody's agreeing on what to try first.
>
> This is the situation that the Incident Advisor was built for. It's an AI-powered emergency co-pilot that lives inside CueDeck — and when things go sideways on stage, it gives you a diagnosis and a numbered action plan in under ten seconds.
>
> Let me show you exactly how it works."

---

## WHAT IT IS (0:30–1:10)

[Screen: zoom slowly into the AI AGENTS panel in the left sidebar — the three module cards visible]

> "The Incident Advisor is one of three AI agent modules built into CueDeck. It lives in the AI Agents panel, which is visible only to the Director role — because this is a tool for the person running the production, not for every operator on the floor.
>
> It's powered by Claude, Anthropic's AI model, running through a server-side proxy — so there's no API key to set up, no configuration required. The feature is included in all CueDeck plans, and it works the moment you're logged in as a director.
>
> You trigger it manually when something goes wrong. You describe the incident, it analyses it, and it comes back with a structured plan."

---

## OPENING THE ADVISOR (1:10–1:45)

[Screen: click the Incident Advisor card in the AI Agents panel — the modal appears with a red accent stripe, the header reads "INCIDENT ADVISOR" in small caps]

> "To open it, click Incident Advisor in the AI Agents panel. You'll get this modal — dark background, red accent bar at the top, which is intentional. This isn't a settings panel. This is an emergency tool and it looks like one.
>
> At the top you'll see a title field, a metadata line showing location and timestamp, and below that the body area where the AI response will appear. The modal is already rendering a spinner — it's waiting for you to describe the incident."

---

## DESCRIBING THE INCIDENT (1:45–2:30)

[Screen: in the incident description input, type the following slowly so viewers can read it: "Speaker's laptop died mid-keynote, slides not loading on backup HDMI, we are 3 minutes in, room of 400 waiting"]

> "Here's where you describe what's actually happening. Be specific — the more context you give the AI, the more specific the action plan you'll get back.
>
> I'll type: speaker's laptop died mid-keynote, slides not loading on backup HDMI, three minutes in, room of four hundred waiting.
>
> One thing worth noting: the Incident Advisor knows about your current event. It has context — session title, the room, the planned timing, what's currently live. So your description doesn't need to repeat that. Just describe the problem."

---

## THE AI RESPONSE (2:30–3:45)

[Screen: click Submit / trigger the incident — the spinner animates for a moment, then the modal populates with: a Diagnosis block (2–3 sentences), followed by numbered Resolution Steps (4–5 steps, each clickable), and an estimated resolution time in the footer]

> "And here it comes. The spinner animates while Claude processes the incident — this takes under ten seconds on a normal connection — and then the response populates.
>
> First you get a Diagnosis block. This is the AI's interpretation of what is technically happening and why. For a laptop-and-HDMI failure, it might identify a signal handshake issue, a source-not-detected problem on the switcher, or a display timeout — based on the symptoms you described.
>
> Below that, Resolution Steps. These are numbered, ordered by priority, and they're interactive — you can click each one to mark it done as your crew works through them. The steps are specific: check the switcher output assignment, toggle EDID, pull and re-seat the HDMI, switch to the house laptop, advance manually from the operator station.
>
> And down in the footer — an estimated resolution time. The AI calculates this based on the severity of the issue and the steps it's recommending. In this case: approximately four minutes."

---

## WORKING THROUGH THE STEPS (3:45–4:30)

[Screen: click through two or three of the resolution steps, each one turning green with a strikethrough as it's marked done; the checked count in the footer updates]

> "As your crew works through the steps, you check them off. Each one turns green with a strikethrough — giving you a running view of where you are in the resolution. Your stage manager is on one comms channel, your AV lead is on another, and you're coordinating from this modal while the room waits.
>
> When the issue is resolved, hit Mark Resolved at the bottom right. CueDeck logs the incident to your event log — system, location, timestamp, resolved status. That entry will show up later in your post-event report.
>
> If the issue is beyond your team's ability to fix on-site, you have the Escalate button. That fires a notification through your configured escalation channel — and also logs the escalation to the event log."

---

## WHEN TO USE IT (4:30–5:10)

[Screen: scroll back to the AI Agents panel, show the module card; brief cut to a second scenario — staging issue — to illustrate range of use cases]

> "A few notes on when to reach for this versus when not to.
>
> The Incident Advisor is for unexpected, time-sensitive technical failures — laptop not connecting, PA system cutting out, streaming encoder dropping, interpretation channel going silent. Anything where you need a structured response fast and you don't have time to think through the full troubleshooting tree.
>
> It is not for planned schedule changes, late speakers, or administrative issues. Those go through the session state machine — delay nudge, hold, call speaker — not through the Incident Advisor.
>
> The best way to think of it: it's the equivalent of having a senior AV engineer looking over your shoulder. One who has seen every failure mode, doesn't panic, and gives you numbered steps."

---

## WRAP (5:10–5:45)

[Screen: close the modal, return to the session list, the event is still running]

> "That's the Incident Advisor. One click, describe the problem, get a diagnosis and a ranked action plan in under ten seconds — while your event is still running.
>
> In the next episode we're covering the Cue Engine — the second AI agent module. That one fires eight minutes before every session start and runs through a readiness checklist so you never go live with a cold microphone or a slide deck that isn't loaded. I'll see you there."

[End card: subscribe + episode 12 thumbnail]

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console as Director with a live event loaded
- [ ] Show the AI Agents panel in the left sidebar
- [ ] Click Incident Advisor to open the modal
- [ ] Show modal header: red accent bar, "INCIDENT ADVISOR" label, spinner
- [ ] Type incident description: "Speaker's laptop died mid-keynote, slides not loading on backup HDMI, we are 3 minutes in, room of 400 waiting"
- [ ] Trigger the AI analysis (submit / trigger button)
- [ ] Wait for spinner → show Diagnosis block populating
- [ ] Show numbered Resolution Steps list
- [ ] Show estimated resolution time in footer
- [ ] Click through 2–3 steps, watch them turn green / strikethrough
- [ ] Show "Checked: X / Y" counter updating in footer
- [ ] Click "Mark Resolved" — show confirmation banner, modal closes
- [ ] Return to session list — event still running normally
