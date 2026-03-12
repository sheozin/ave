# Episode 15 — Sponsor Logos & Branding in Signage
**Duration target:** 4–5 min
**Style:** Practical and polished; this is a feature clients notice immediately because it shows their branding to the room; tone is professional but approachable — this is not complicated, it just needs to be done right

---

## INTRO (0:00–0:25)

[Screen: CueDeck display page showing the Sponsor mode — a full-screen dark background with a large, clean company logo centred; the logo fades out after several seconds and the next sponsor logo fades in]

> "Every conference has sponsors. And every sponsor expects to see their logo on the screens. In CueDeck, the Sponsor signage mode handles this automatically — you upload the logos, set how long each one displays, and they rotate in a clean fade loop on any display you assign them to.
>
> In this episode I'll show you how to upload sponsors, configure timing, and build a display sequence that rotates between sponsor branding and your session content automatically."

---

## THE SPONSORS TAB (0:25–1:00)

[Screen: Signage panel in the CueDeck console; click the "Sponsors" tab at the top of the panel (if it exists as a tab, otherwise show the Sponsors section within the signage area)]

> "Sponsor logos are managed from the Signage panel. There's a dedicated Sponsors section here — separate from your display configuration — where you manage the sponsor list that feeds the Sponsor mode.
>
> Each sponsor has a name, a logo file, and a display duration in seconds. The list feeds every display that is set to Sponsor mode — so you manage the logos once, and they appear on all the relevant screens.
>
> You can also set a sort order, which controls the rotation sequence. Let's add a sponsor."

---

## UPLOADING A SPONSOR LOGO (1:00–2:00)

[Screen: click "Add Sponsor" or equivalent button; a modal opens — fields for Sponsor Name, Logo file upload, Display Duration in seconds; type a name, click the file upload area, select a PNG file from disk; set duration to 8 seconds; save]

> "Click Add Sponsor. You'll get a small form: the sponsor's name, a logo upload, and display duration in seconds.
>
> For the logo file: the recommended format is PNG with a transparent background. This is important — the Sponsor mode renders on a dark background, so a PNG with transparency will look clean and professional. A white-background JPEG will look like a white rectangle in the middle of a dark screen.
>
> Recommended size is 800 by 600 pixels or larger. CueDeck scales the image to fit the display, so going bigger is fine — it won't pixelate. Going smaller may look soft on a large TV.
>
> I'll upload this sponsor logo, set the name to Platinum Partner, and set the display duration to eight seconds. Hit Save — the logo uploads to the leod-assets storage bucket and the sponsor is added to the rotation immediately."

---

## ADDING MULTIPLE SPONSORS (2:00–2:35)

[Screen: add a second sponsor with a different logo; show the sponsors list now with two entries — name, thumbnail of logo, and duration visible for each; the list is ordered by sort order]

> "Add as many sponsors as you need. Each one gets its own duration setting — so if your title sponsor paid more, you can give them twelve seconds while other sponsors get six. The rotation respects the individual durations per sponsor, not a global setting.
>
> The sort order determines the rotation sequence. Drag to reorder, or manually set the order number — your title sponsor can always appear first.
>
> Once the logos are uploaded, they're live immediately on any display running Sponsor mode. No page refresh, no redeploy — the display picks up the new sponsor via the realtime subscription."

---

## SETTING A DISPLAY TO SPONSOR MODE (2:35–3:10)

[Screen: open a display in the edit modal; set Content Mode to "Sponsors"; save; switch to the display tab showing the Sponsor mode — first logo centred, large, clean; after 8 seconds it fades out and the second logo fades in]

> "To show sponsors on a specific screen, open the display in the Signage panel and set the Content Mode to Sponsors. That display will now rotate through your sponsor list, each logo displayed for its configured duration.
>
> Here's what it looks like. Clean, centred, full-screen logo on a dark background. After the configured duration, it fades out and the next sponsor fades in. The transitions are smooth — no flash, no hard cut.
>
> If a sponsor has no logo uploaded — just a name — the mode renders the name in large text instead. So you're never showing a broken image placeholder."

---

## BUILDING A SEQUENCE (3:10–4:00)

[Screen: open the display edit modal; scroll to the Sequence section — a sequence builder with an "Add Slide" button; add two slides: first "NextUp" mode for 30 seconds, then "Sponsors" mode for 10 seconds; save; switch to the display tab and show the rotation cycling between the session mode and the sponsor logos]

> "The most practical setup for venue displays isn't a screen that shows sponsors full-time. It's a screen that cycles between useful session content and sponsor branding automatically.
>
> CueDeck has a sequence builder for exactly this. In the display edit modal, scroll down to the Sequence section and enable it. Then build your rotation: add a slide for the NextUp mode — the card showing what's on stage now and what's coming next — and set it to run for thirty seconds. Add a second slide for Sponsors mode and set it to ten seconds.
>
> Save the display. Now it runs: thirty seconds of NextUp, ten seconds of sponsors, back to NextUp, back to sponsors — automatically, indefinitely.
>
> You can build sequences with as many slides as you need, combining any of CueDeck's ten display modes: NextUp, Timeline, Programme, Sponsors, Clock, Countdown, and more. Each slide has its own duration."

---

## BRANDING TIPS (4:00–4:25)

[Screen: back to the Sponsor mode on the display — logo looking clean and well-sized on screen]

> "A few practical tips for sponsor logos that look professional on venue screens.
>
> Always use PNG with transparency. Never JPEG.
>
> Minimum 800 by 600 pixels. For a 4K screen, go 1600 by 900.
>
> If a sponsor only gives you a JPEG, open it in any image editor, remove the white background, and export as PNG. Ten minutes of prep prevents an embarrassing white box on a display during the coffee break.
>
> Duration: eight to ten seconds is the sweet spot. Long enough to read, short enough to keep rotating. Avoid anything shorter than five seconds — logos need a moment to register.
>
> And if you're running the Sequence mode — mixing sponsors with session content — the sponsor duration within the sequence is separate from the per-logo rotation duration. The sequence controls how long the display spends in Sponsor mode total. The per-logo duration controls how quickly it cycles through individual sponsors within that window."

---

## WRAP (4:25–4:50)

[Screen: display showing the full sequence cycle — NextUp → Sponsor A → Sponsor B → back to NextUp]

> "Upload your logos, set durations, build a sequence that mixes sponsor time with session content, and every screen in the venue is handling your sponsor commitments automatically.
>
> That wraps up the signage series — Timeline, Programme, and Sponsors. In the next episode we're going deeper into the display system: the full sequence builder, all ten display modes, and how to configure a multi-zone venue where different screens show different content for different audiences. Subscribe so you don't miss it."

[End card: subscribe + next episode thumbnail]

---

## ON-SCREEN ACTIONS CHECKLIST
- [ ] Open CueDeck console as Director with Signage panel open
- [ ] Navigate to the Sponsors section of the Signage panel
- [ ] Click "Add Sponsor" to open the add form
- [ ] Enter a sponsor name (e.g. "Platinum Partner")
- [ ] Click the logo upload area — select a PNG file with transparency from disk
- [ ] Set display duration to 8 seconds
- [ ] Save the sponsor — confirm it appears in the sponsors list
- [ ] Add a second sponsor with a different logo and 6-second duration
- [ ] Show the sponsors list with both entries visible (name, thumbnail, duration)
- [ ] Open a display in edit modal — set Content Mode to "Sponsors"
- [ ] Save and switch to cuedeck-display.html tab
- [ ] Show the Sponsor mode: first logo centred, full-screen
- [ ] Wait 8 seconds — show the fade transition to the second logo
- [ ] Return to the display edit modal
- [ ] Scroll to the Sequence section — enable it
- [ ] Add first sequence slide: NextUp mode, 30 seconds
- [ ] Add second sequence slide: Sponsors mode, 10 seconds
- [ ] Save the display
- [ ] Switch to display tab — show sequence cycling automatically (NextUp → Sponsors → repeat)
