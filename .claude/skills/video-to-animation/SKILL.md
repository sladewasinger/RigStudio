---
name: video-to-animation
description: Turn a motion-reference video (dance, gesture, action) into a rig-studio animation by extracting frames, writing a beat-mapped pose script, and iterating a clip through the MCP/CLI filmstrip feedback loop until the rendered poses match the reference. Use when the user wants a character animated "like this video/GIF/clip".
---

# Video → rig-studio animation

You are turning a motion-reference video into a `.rig.json` + `.riv` animation
for a rig-studio character, using the headless CLI (`npx tsx src/headless/cli.ts`)
or the MCP server (`npm run mcp`) — NEVER by adding scripts to this repo (user
rule: agent sessions author animations through the tools; the repo maintains the
tools, not the animations).

## 0. Inputs you need before starting

- **The video as a local file.** You cannot watch streaming video, and you must
  not scrape login-walled platforms. If the user gave a URL, ask them to
  screen-record or save the clip locally (Downloads is fine) and STOP until it
  exists.
- **The target rig**: an existing `.rig.json`, or an SVG to import (the bundled
  `public/PIP_MASTER.svg` is the demo character). Check whether the motion needs
  a viewing angle the artwork doesn't have (profile turns, back views) — if so,
  author a new SVG variant first (SVG is text; follow the import conventions in
  CLAUDE.md: named groups become parts, nesting is preserved).

## 1. Extract a reference frame strip

- Check for ffmpeg (`ffmpeg -version`); if absent, ask before installing.
- Extract evenly spaced frames covering the motion loop — start with
  `ffmpeg -i <video> -vf "fps=8,scale=360:-1" frames/ref-%03d.png`
  and thin to the ~12–24 KEY poses (beat hits, extremes, passing positions).
  Read them (they render as images) and confirm the strip captures the motion.

## 2. Write the motion script (the reviewable artifact)

A beat-mapped pose description, in ms on the clip's duration, one line per beat
per body region. Example row format:
`800ms — torso: lean L 8°; R arm: shoulder -70°, elbow -30°; L arm: shoulder 20°; hips: bounce down 6u; head: tilt R 4°`
Rules: estimate angles from the frames (relative to rest pose, +CW to match the
app); note easing intent (snap vs flow); note which beats are HOLDS; make the
last beat return to the first for a clean loop. Show the script to the user if
they're present; otherwise save it next to the frames.

## 3. Rig the character (once)

Through MCP tools or the CLI + a scratch driver:
- `import_svg` the artwork; `analyze_rig` to see chains/roles.
- If limbs need articulation, `add_bones` with EXPLICIT bind targets (headless
  binding has no geometric fallback) — typically a 2–3 bone chain per limb and a
  spine; attach limb chains to the spine (the unified-skeleton model) if the
  dance moves the whole body from the core.
- `validate`, then `save_project` — the rigged base is reusable.

## 4. The feedback loop (the part that makes it good)

Repeat until convergence:
1. `apply_clip` — translate the motion script into the clip schema (bones-first:
   articulate limbs via their BONE rotate channels root-first with 40–80ms
   follow-through; part-level rotate/tx/ty for whole-limb or whole-figure moves;
   NEVER sx/sy on skinned parts; stepped `z` for reach-behind moments).
2. `render_filmstrip` at the SAME timestamps as your reference key poses.
3. READ both strips side by side. Compare pose by pose: joint angles, silhouette,
   timing feel. List concrete deltas ("beat 3: right arm should be ~30° higher,
   hips bounce is missing").
4. Amend the clip (`apply_clip` mode replace) for the deltas. Two to four
   iterations is normal.

## 5. Deliver

- `export_riv` + `save_project` to the user's requested location (ask if
  unspecified; default to a new folder OUTSIDE the repo, e.g. Downloads).
- Report: the motion script, the final filmstrip, iteration count, and file
  paths. The user can open the `.rig.json` in the editor to refine by hand.

## Traps

- Don't burn context re-reading every frame each loop — compare only the beats
  you changed.
- Front-facing rigs can sell most dance moves with lean + bounce + arm arcs;
  don't author profile artwork unless a move is unreadable without it.
- The clip must loop: first/last keys equal on every track.
- Respect the repo's gates if you touch repo files (you shouldn't need to).
