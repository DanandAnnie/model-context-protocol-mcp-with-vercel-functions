# Best Open-Source Video Editing Stack on GitHub for Daniel Stewart

**Bottom line up front:** No single GitHub project will cover everything. Daniel should treat this as a small toolchain rather than picking one editor. The right combination — given his Mac Mini, React/Vite/Vercel/Node stack, and automation-heavy workflow — is **Remotion as the programmatic core**, **Shotcut as the occasional GUI**, **LosslessCut for fast cuts on raw listing footage**, and **auto-editor + faster-auto-subtitle** as CLI utilities for Heygen post-production and social captions. Everything below is filtered through that lens.

---

## Top Recommendation: Remotion (remotion-dev/remotion)

For Daniel's specific situation, **Remotion is the single highest-leverage tool on this list.** It is a framework that lets you write videos as React components and render them to MP4/WebM, either locally or serverlessly. Why it lines up so cleanly with his stack:

- **React/Vite/Node fit:** He already writes React. Remotion compositions are React components with props. The whole "build a listing intro/outro template once, render 50 of them with different addresses, prices, agent photos" workflow is exactly what Remotion was built for.
- **Vercel-native rendering:** Remotion ships an official `@remotion/vercel` renderer (`renderMediaOnVercel`) plus a Lambda renderer. He can trigger a render from a Supabase Edge Function, hit a Vercel function, get back an MP4 URL, and store it. That's a real estate listing video pipeline in roughly 100 lines of glue code.
- **Apple Silicon native:** Renders use a headless Chromium under the hood; works fine on M-series Macs. Local previews are hot-reloaded like a normal Vite dev server.
- **Captions, vertical formats, branded intros:** All trivial — width/height are just composition props, captions are React components driven by an SRT file, intros/outros are reusable `<Composition>`s that take props.
- **Active maintenance:** Remotion is one of the most actively maintained projects in this space, with weekly releases and a paid team behind it.

**The license caveat (important):** Remotion is *source-available*, not classic open source. It is **free for individuals and for companies of up to 3 people**, including commercial use. If Daniel's three businesses each have fewer than ~3 people involved with Remotion (and he is the operator), he very likely qualifies for the **Free License**. If he ever crosses that threshold or builds Remotion into a SaaS product he resells, a Company License starts at roughly $25/developer/month with a $100/month minimum spend (these are the publicly posted numbers as of 2025). Read the LICENSE.md before relying on it; this is the one caveat that matters and he should confirm eligibility for his specific entity structure.

**Repos worth bookmarking:**
- `remotion-dev/remotion` — the framework
- `remotion-dev/template-music-visualization` and the rest of `remotion-dev/template-*` repos — copy-paste starter templates
- `reactvideoeditor/remotion-templates` — 81 free MIT-licensed Remotion components (chart animations, title cards, transitions) he can drop into a real estate template
- `designcombo/react-video-editor` — a CapCut/Canva-style web editor built on Remotion, useful if he ever wants to give a VA a browser-based timeline

---

## Runner-Up by Scenario

### For "I just need to chop up a listing walkthrough" — LosslessCut (mifi/lossless-cut)
GPL-2.0, Apple Silicon DMG officially shipped, ~30K GitHub stars, very actively maintained (current version 3.68 as of early 2026). It is a thin Electron GUI on top of FFmpeg that does **lossless** trimming and concatenation — no re-encoding, so a 4K drone walkthrough chops in seconds. The new Smart Cut mode does frame-accurate edits by re-encoding only around cut points. **This is the right tool for raw 4K property footage** — use it before anything else hits the timeline. It also exposes its underlying FFmpeg commands and supports CLI-friendly batch project files, so it's not entirely a dead-end for automation.

### For full GUI editing — Shotcut (mltframework/shotcut)
GPL-3.0, native Apple Silicon builds, monthly releases. Of the three "traditional" GUI editors people compare (Shotcut, Kdenlive, OpenShot), **Shotcut has the best macOS story** — Kdenlive's Mac builds historically lag and have stability issues, and OpenShot is the least stable of the three. Shotcut has proper proxy editing (important for 4K listing footage), wide format support via FFmpeg, vertical/social aspect ratios, and a reasonable learning curve for a non-editor. It is the right "pick this up on a Saturday and learn enough in 2 hours to cut a listing video" choice. **Trade-off:** Shotcut is not scriptable in any serious way — there is no real CLI/API surface, so it does not slot into his automation stack. Treat it as the manual-touch tool for hero listings, not the pipeline.

### For programmatic editing without Remotion's licensing concerns — editly (mifi/editly) or Revideo (redotvideo/revideo)
- **editly** is a MIT-licensed Node.js library/CLI built on FFmpeg. You feed it a JSON5 spec describing clips, transitions, music, titles, and it renders an MP4. It is *exactly* the kind of tool a Supabase Edge Function could call. **Honest assessment:** editly has had a rocky maintenance cadence — releases slowed considerably in 2023–2024, and it has known headless-gl install issues on newer Node and macOS versions. Daniel runs Node 22 via nvm, which is *newer* than editly's well-tested LTS targets. Plan on an afternoon of getting it building, or run it via the official Docker image (cleaner). It works, but it isn't as polished as Remotion.
- **Revideo** is the MIT-licensed fork of Motion Canvas with headless rendering and a server-side rendering API. It is the "Remotion alternative" for anyone who can't or won't accept Remotion's source-available license. **Caveat as of 2025:** the team behind Revideo has shifted primary focus to a commercial product called Midrender, and they have stated that recent work has not been upstreamed to the open-source repo. The OSS code still works, but the project's forward momentum is uncertain — treat it as a "stable but slowing" option.

### For automated silence-cutting on Heygen B-roll and walkthrough narration — auto-editor (WyattBlue/auto-editor)
Pure Python CLI, very actively maintained, runs cleanly on Apple Silicon. One command (`auto-editor input.mp4 --margin 0.3s,1.5s -o out.mp4`) trims dead air, awkward pauses, and motionless segments out of a long walkthrough or testimonial. He can chain it before Remotion in a pipeline: raw clip → auto-editor cleans it → Remotion composes it with intro/outro/captions/B-roll. **One thing to know:** the project recently introduced a "FOSSIL" model where some advanced features may require a license key, but the core CLI remains open and free for the use cases Daniel needs.

### For captions — faster-auto-subtitle (Sirozha1337/faster-auto-subtitle) or auto-subtitle (m1guelpf/auto-subtitle)
Both are MIT-licensed Whisper wrappers that take a video in and produce a captioned video out. `faster-auto-subtitle` uses faster-whisper (significantly faster on Apple Silicon than the original) and supports batch folder processing — drop 10 listing walkthroughs in, get 10 captioned outputs. For social vertical content the standard pattern is: generate an SRT with Whisper → render as a Remotion `<Composition>` overlay so captions match Daniel's brand styling. This is a much better look than burned-in default subtitles.

---

## Quick Verdict on the Rest of the Compared Set

- **Kdenlive** — Cross-platform but the macOS port has historically been the weakest target. Skip on a Mac Mini if Shotcut is an option.
- **OpenShot** — Friendly UI, but stability complaints and a thinner feature set than Shotcut. No reason to choose it over Shotcut on macOS.
- **Olive Editor** — Still officially in alpha after years of development. Not production-ready for marketing video. Pass.
- **Motion Canvas** — Beautiful for explainer/data-driven animations, but **the maintainers have explicitly said they don't intend it to be used as a library** — Revideo exists precisely because of that limitation. Use Revideo or Remotion instead.
- **FFmpeg directly** — The thing every other tool here is wrapping. Worth keeping a couple of utility scripts in his toolkit (vertical reframe, watermarking, format conversion) but it's not an "editor" in any practical sense for marketing content.

---

## Suggested Architecture for Daniel's Stack

A concrete pipeline that uses these tools the way they're each strongest:

1. **Capture:** Shoot listing walkthrough on phone/gimbal/drone.
2. **Rough cut (LosslessCut):** Lossless trim down to the good parts, reorder rooms. 30 seconds of work.
3. **Silence/dead-air cleanup (auto-editor CLI):** Single command, runs in the background.
4. **Captioning (faster-auto-subtitle CLI):** Generates SRT files.
5. **Composition (Remotion):** A single `ListingVideo` composition that takes props — `{ address, price, beds, baths, agentName, walkthroughClipUrl, srtUrl, broll[], musicUrl }` — and renders branded intro, walkthrough with captions, B-roll cutaways, and outro.
6. **Trigger:** Supabase Edge Function detects a new row in a `listings` table → calls a Vercel function running `@remotion/vercel`'s `renderMediaOnVercel()` → uploads result to Supabase Storage → notifies Daniel.
7. **Heygen integration:** Same Remotion composition has a `HeygenAvatarVideo` variant that takes the avatar MP4 from Heygen as a prop and overlays B-roll/captions/branding around it.
8. **Hero edits (Shotcut):** For premium listings or before/after staging reveals where he wants hands-on creative control, open the rough cut from step 2 in Shotcut and finish manually.

The only piece he can't get from GitHub at zero cost is **branded music** (he should license a SoundStripe/Artlist track or similar) and **branded fonts/logo assets** (those come from his existing Canva/Gamma work).

---

## Honest Trade-offs

- **Remotion's licensing is the single most important thing to verify.** If for any reason he is not eligible for the Free License (most likely if any of his three businesses has 4+ people involved in Remotion-rendered output), the cost is real but bounded ($100/month minimum). If that's a deal-breaker, fall back to **Revideo** with the understanding that its maintenance has slowed.
- **Learning curve:** Remotion has a real ramp for a non-developer, but Daniel writes React already. Plan on 1–2 weekends to build the first listing template; subsequent listings are then a 5-minute prop change.
- **Rendering performance:** Mac Mini Apple Silicon renders Remotion compositions fine for 1080p and reasonable for 4K, but for batch jobs he should push rendering to Vercel/Lambda rather than blocking his local machine.
- **No "AI cuts" magic:** None of these tools will automatically pick the best 30 seconds of a 10-minute walkthrough the way commercial AI editors are starting to. auto-editor handles silence; everything else is template-driven. If that becomes a need, the right move is a small Python script using a vision model to score frames, then feed timestamps to Remotion or LosslessCut — not a different editor.
- **STR investor / before-after staging videos:** These are heavily template-driven (split screens, before/after wipes, testimonial chyron lower-thirds). This is **exactly Remotion's sweet spot** — build the template once, swap props per property.

---

## GitHub Repos to Bookmark

| Repo | Purpose |
|---|---|
| `remotion-dev/remotion` | Programmatic video core |
| `reactvideoeditor/remotion-templates` | Free MIT animation components |
| `designcombo/react-video-editor` | Optional browser timeline UI on Remotion |
| `mifi/lossless-cut` | Fast lossless trims of raw footage |
| `mltframework/shotcut` | GUI editor for hero edits |
| `WyattBlue/auto-editor` | CLI silence/dead-air removal |
| `Sirozha1337/faster-auto-subtitle` | Whisper-based caption generator |
| `m1guelpf/auto-subtitle` | Simpler Whisper caption alternative |
| `mifi/editly` | Backup programmatic option (MIT) |
| `redotvideo/revideo` | Remotion alternative if licensing is an issue |

If Daniel only does one thing this week: install LosslessCut from the Apple Silicon DMG and run his next listing walkthrough through it. He'll save more time on that single edit than the read of this document took. The Remotion build-out is the bigger investment but the one that compounds across all five of his use cases.
