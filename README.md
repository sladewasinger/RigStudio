# Rig Studio

A browser-based 2D rigging and animation editor for SVG artwork — bones, groups,
inverse kinematics, skinning, a keyframe timeline with a curve editor, Rive-style
state machines, and an AI animation assistant. Exports **Rive `.riv`** files (play
anywhere the official Rive runtimes run: web, Android, iOS, Flutter, React Native,
Unity) and **Lottie JSON**.

Try it here:
[Rig Studio (Github Pages)](https://sladewasinger.github.io/RigStudio/)

![Rig Studio screenshot](samples/rig_studio_screenshot.png)

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
npm test           # unit tests (vitest)

npm preview        # run production preview server (no file watching, make sure build first)

npm run pages      # build github pages folder (make sure to commit and push)
```

## Workflow

1. **Import** — `Open…` an SVG (or `Load sample`). Each named group
   (`inkscape:label`) becomes a rig part; ellipses/circles/rects convert to paths. A
   group transform of the form `rotate(a, cx, cy)` — or the equivalent `matrix(...)`
   Inkscape rewrites it into — seeds the part's pivot, so pre-rigged joints import
   for free.
2. **Rig (Setup mode)** — move/scale/rotate/skew parts Inkscape-style, drag pivots
   (the artwork never shifts), parent parts into bone hierarchies, place bones and
   IK chains, group with Ctrl+G, bind artwork to bones for skinned deformation, and
   edit path nodes (insert/delete/join/split, segment bending, persistent node
   types). Toggleable snapping (`%`) covers nodes, pivots, and bounding boxes.
3. **Animate** — pose parts on the canvas to auto-key at the playhead; clips
   organize animations (one clip per action/mood). The timeline offers marquee key
   selection, retiming, copy/paste, per-key easing presets, and a curve editor with
   custom cubic beziers.
4. **State machines** — the timeline's `🔀 logic` view: define inputs
   (bool/number/trigger), states bound to clips, transitions with conditions and
   crossfade blends, and pointer listeners on parts. Preview runs the machine live
   on the canvas — clicks on the artwork fire listeners.
5. **AI assistant** — enter an Anthropic API key (stored locally, sent only to
   `api.anthropic.com`), describe motion in plain language, and the assistant writes
   or critiques the active clip's choreography; optionally allow it to make
   structural rig changes.
6. **Export** — `Export Rive (.riv)`: the whole document, every clip as a named
   animation plus state machines, playable in the official Rive runtimes (reference
   animations and inputs by name, e.g. from `rive-android`). `Export Lottie
   (.json)`: one clip as a Lottie file. `Save project` round-trips everything as
   `.rig.json` (autosaved to localStorage).

Press `?` in the app for the complete keyboard-shortcut reference.

## Headless & agents

- **CLI**: `npx tsx src/headless/cli.ts <import|validate|export-riv|render-frames>` —
  import an SVG, validate/round-trip a project, export a playable `.riv`, or render
  PNG frames of a clip, all without the browser.
- **MCP server**: `npm run mcp` (stdio) — 12 tools so any MCP client (Claude Code,
  Claude Desktop, …) can build rigs, drop bones, apply animation clips (the same
  structured schema the in-app AI assistant uses), and export — end to end, headless.
  One-off animations (demos, app assets) should be authored THIS way by an agent
  session, not committed as maintained scripts in this repo.

## Documentation

- [CLAUDE.md](CLAUDE.md) — architecture, invariants ("conventions that must hold"),
  and the verified status log.
- [ROADMAP.md](ROADMAP.md) — status dashboard (review list, deferred decisions,
  what's next) and the full feature history.
- [docs/ORCHESTRATOR_PLAYBOOK.md](docs/ORCHESTRATOR_PLAYBOOK.md) +
  [docs/PROJECT_PROCESS.md](docs/PROJECT_PROCESS.md) — the AI-orchestrated
  development process (see below).

## Replicating the development process (new machine / new project)

This repo is built by an AI session acting as ORCHESTRATOR — delegating to
subagents, auditing everything, gating every change. The process is fully
portable because it lives in the repo, not in any machine's memory:

1. Clone; `npm install`; sanity-check the gates:
   `npm run build && npm test && npm run test:interaction`
   (the unit suite includes the structural enforcement tests — size ratchet,
   nodeTypes chokepoint, headless boundary, golden `.riv` byte-identity — so the
   discipline travels with the clone).
2. Start a Claude Code session in the repo and open with the kickoff prompt from
   [docs/ORCHESTRATOR_PLAYBOOK.md](docs/ORCHESTRATOR_PLAYBOOK.md), plus:
   *"Read docs/ORCHESTRATOR_PLAYBOOK.md and docs/PROJECT_PROCESS.md and follow
   them."* (`CLAUDE.md` auto-loads and also points there.)
3. Point it at [ROADMAP.md](ROADMAP.md) — the status dashboard says what's next,
   what's awaiting review, and which decisions are reserved for a human.

For a NEW project, copy the playbook, write a fresh `PROJECT_PROCESS.md` from its
template ideas (gates, ports, machine quirks), and seed the session the same way.

## Semantics (the short version)

- Coordinates are SVG document space: +y down, positive rotation clockwise.
- Keyframed values are absolute; the rest pose fills unkeyed channels.
- Every part rotates around its own pivot; parenting composes like a bone hierarchy;
  `root` translates/scales the whole figure.
- Easing lives on the arriving keyframe; custom curve-editor beziers override
  presets everywhere, including exports.
