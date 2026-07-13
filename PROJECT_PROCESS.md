# Rig Studio — project-specific process (the second half of the playbook)

The generic method lives in `ORCHESTRATOR_PLAYBOOK.md`. This file pins the
concrete gates, numbers, and etiquette for THIS repo. The architecture,
conventions, and status themselves live in `CLAUDE.md` — this file is about
HOW work runs, not what the code is.

## The gates (every wave, in this order)

```sh
npm run build             # tsc --noEmit + vite build — must be clean
npm test                  # unit project (node) — includes the size-ratchet test
npm run test:interaction  # headless-Chromium real-gesture suite (~3 s)
npm run export:take-pill  # headless end-to-end; then hash the output:
#   out/pip_take_pill.riv SHA-256 must equal
#   4351052ebd49a4d7f1f5e50f30757bbe7faf8f9c226e3ee67c1db2441102dc47
#   for any wave that claims byte-identical export behavior (refactors).
#   Feature waves that legitimately change export bytes re-pin the hash in
#   their commit message.
```

Current expected counts live in git history (each wave's commit message
records them). Always re-run gates yourself after an agent reports green.

## Live verification etiquette

- Port **5173 is the user's own dev server — never kill, restart, or reuse
  it.** Agents add a TEMPORARY `.claude/launch.json` entry on a unique port
  (5196–5199 have been used), verify, stop their server, and revert the
  entry byte-identically before reporting.
- Screenshots time out in this environment; verify via DOM/state inspection
  (`window.__rigStudio`: `state`, `renderPose`, `exportRiv`, `exportLottie`,
  `serializeDoc`, `loadProjectText`, `setEditorMode`; `window.__smPanel`
  for the state-machine editor, `window.__aiPreview` in interaction tests).
- Load `public/PIP_MASTER.svg` via "Load sample" for UI verification. The
  nested-import fixture is `girl_example.svg` (test asset only).

## Interaction-test rules (codified in the harness — use it)

`src/__tests__/interaction/harness.ts` provides the gesture helpers; write
scenarios with it rather than hand-rolling events. The binding rules (full
list in CLAUDE.md "Testing interactions"): dispatch to
`document.elementFromPoint`, full gesture sequences, re-resolve after
renders, numeric + DOM assertions, `assertScreenConstant` zoom sweeps for
any canvas chrome, and the connected-chain `assertNoGap` afterEach in the
bone/freeze/ik suites. Any change under `src/view/` must pass the suite;
new interaction features get a scenario; every scenario gets a mutation
check before it counts.

## Commit conventions

- Orchestrator commits after audit; agents NEVER commit in the main tree
  (worktree waves commit to their own branch as instructed per-wave).
- Selective staging: exactly the wave's files. Docs (CLAUDE.md/ROADMAP.md)
  land as a separate follow-up commit that cites the code commit's hash.
- Message body records what was VERIFIED (gate counts, hashes, live
  evidence), not just what changed. End with:
  `Co-Authored-By: Claude <the model's noreply address>`
- NEVER push — pushing is the user's.

## PowerShell 5.1 traps (this machine)

- Embedded double quotes inside `git commit -m @'...'@` here-strings split
  into pathspecs — write commit messages without inner double quotes.
- Never regex-edit docs via `Get-Content`/`Set-Content` (encoding mojibake
  on em-dashes); use the Edit tool.
- `npm run <script> -- -flag value` can mangle flags; invoke CLIs directly
  (`npx tsx src/headless/cli.ts ...`).

## Where things are pinned

- Architecture + conventions + GOTCHAs + per-wave status: `CLAUDE.md`.
- Feature sequencing and tick-offs: `ROADMAP.md` (update in the same wave).
- File-size enforcement: `src/__tests__/architecture.test.ts` (CODE lines,
  comments free, grandfather map shrink-only, honesty check).
- Headless boundary: `src/__tests__/headlessBoundary.test.ts`.
- .riv binary correctness: `src/__tests__/rivDecoder.ts` (shared decoder)
  + the exportRiv test suite; real-runtime spot checks via
  `public/riv-check.html` (`@rive-app/canvas`).

## Session memory

The orchestrator keeps cross-session notes (user workflow rulings, pending
approved-but-unqueued designs, environment quirks) in its persistent memory
directory, indexed in `MEMORY.md` there. Repo-derivable facts stay OUT of
memory — CLAUDE.md and git history are the source of truth.
