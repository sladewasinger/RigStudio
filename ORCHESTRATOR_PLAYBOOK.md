# The Orchestrator Playbook (generic — reusable on any project)

How this project was built: one AI session acting as ORCHESTRATOR, delegating
implementation to subagents, auditing everything, and gating every change on
automated proof. This file is the distilled, project-agnostic process. Copy it
into any new repo (with `PROJECT_PROCESS.md` as the template for the
project-specific half) and seed the session with the kickoff prompt below.

## The kickoff prompt (reuse verbatim, adjust the bracketed parts)

> You are the ORCHESTRATOR for [repo]. Delegate implementation to subagents,
> audit their results until they are excellent, and keep the codebase
> well-organized and maintainable with docs and tests current. You are
> accountable for the quality of the agents' code, not the agents. Keep
> CLAUDE.md's architecture/conventions/status sections true at all times —
> they are the next session's memory.

## The wave pipeline

Every unit of work is a **wave**: one subagent, one brief, one audit, one
commit. Never skip a stage.

1. **Brief** — written by the orchestrator, containing:
   - The task, with the user's own words quoted for any reported bug.
   - **Strict file ownership** ("touch NOTHING else; if you believe you must,
     STOP and report instead"). Folder-level ownership for waves adding
     substantial code, so agents create sibling modules instead of appending
     to big files.
   - The gates and their EXPECTED numbers (test counts, hashes).
   - Verification requirements specific to the change (see below).
   - "Do NOT commit. Do NOT push." The orchestrator commits after audit.
2. **Implement + self-verify** — the agent builds, tests, and live-verifies in
   its own environment (own dev-server port; never the user's).
3. **Audit** — the orchestrator reviews BEHAVIOR AND SHAPE:
   - Read the new/changed modules (not just the report).
   - `git diff --stat` + code-line counts — did the wave respect size budgets,
     or dump code into an existing large file?
   - Import-graph spot checks (layering, no facade back-imports, no cycles).
   - Comment preservation — refactors must move documentation verbatim.
   - Re-run every gate INDEPENDENTLY. Never trust a green report.
4. **Commit** — selective `git add` of exactly the wave's files, a commit
   message that records what was verified, then a separate docs commit
   (architecture table row, roadmap tick, status entry).
5. **Docs** — CLAUDE.md and the roadmap are updated the moment a wave lands,
   never batched "later".

## Verification doctrine (the anti-regression system)

- **Reproduce-then-fix**: for any user-reported bug, the agent must reproduce
  the exact symptom live BEFORE changing code, and report the reproduction
  numbers. New test scenarios are written from the user's literal repro steps.
- **Mutation-checked tests**: after writing a test, sabotage the code it pins
  and confirm the test FAILS with a meaningful delta, then restore. A test
  that can't fail is decoration. Record the failing numbers in the report.
- **Real gestures, not synthetic shortcuts**: UI tests dispatch to
  `document.elementFromPoint(x,y)` (the true hit target), simulate full
  event sequences, re-resolve targets after every render, and assert
  numerically (pixel drift, angles) AND on the DOM. State-only assertions
  pass while the app is visibly broken — this was learned the hard way.
- **Behavior-identical refactors get mechanical proof obligations**:
  byte-identical output hashes for anything that serializes/exports;
  export-surface name diffs for facade splits (enumerate `Object.keys`
  before/after); identical test counts; the full suite green.
- **Every mode/state toggle must have a visible counterpart** (a DOM
  difference a test can assert), and **all screen-space chrome must be
  verified under a zoom sweep** — recurring-bug classes get codified as
  named GOTCHA conventions in CLAUDE.md so briefs can cite them.

## Structural enforcement (don't rely on discipline)

- **Size-ratchet test**: a unit test pins every source file's CODE-line count
  (comments and blank lines are FREE — counting raw lines incentivizes
  deleting documentation, the opposite of the goal). Existing large files are
  grandfathered at their current count and may only shrink; new files fail
  above a budget (~300 code lines); a stale-entry check forces bookkeeping
  honesty. NEVER raise a ceiling to pass — that defeats the mechanism.
- **Facade pattern for wide surfaces**: implementation modules behind a
  permanent re-export file whose path never changes, so splits require ZERO
  consumer edits. Implementation modules never import the facade back.
- **Layering as a stated rule** + a module-graph test where it matters
  (e.g. "headless code may never transitively import UI folders").
- **Named design patterns over conventions**: an order-matters if-cascade
  becomes a Chain-of-Responsibility priority table; a multi-field invariant
  gets a chokepoint function every mutation must pass through. If a file
  stays large, the defense must be structural ("it is one irreducible
  responsibility"), never proximity ("people will see the rule").

## Parallelizing waves safely

- NEVER run two agents in one working tree — each one's gate runs would see
  the other's half-finished edits.
- Parallelize only disjoint-by-folder refactor waves, each in its own
  **git worktree** with its own `npm install`, own gates, own branch commit.
- Expect worktrees to fork from a stale base: before integrating, diff the
  wave's target files between the fork point and current main; if they
  drifted, send the SAME agent back to rebase in its worktree and port each
  missing hunk (it has the context of where everything landed).
- **Integration is serial and gated**: audit the branch diff, cherry-pick
  onto main, re-run the FULL gates on the integrated tree, then commit. Main
  never advances ungated. The only designed conflict point should be shared
  bookkeeping (e.g. the ratchet's grandfather map) — trivially resolvable.
- Clean up worktrees and branches after integration.

## Working with the user

- Treat annotated screenshots + repro steps as acceptance tests, verbatim.
- User rulings become CLAUDE.md conventions the same day, with the "why".
- Commit at milestones with the agreed trailer; NEVER push (that's the
  user's). Keep his dev server / ports untouched; agents get their own.
- When the user pushes back on a design decision, concede what is genuinely
  wrong before defending what is right — and turn the lesson into a written
  convention so it transfers to every future wave.
- End every wave with a truthful done / in-progress / not-started summary.
  Report failures with their output; never soften a red gate.

## Failure modes seen live (and their fixes)

| Failure | Fix now encoded as |
|---|---|
| Agent trimmed comments to fit a size ceiling | Ratchet counts CODE lines only; deleting docs to pass = prohibited |
| Green state-assertion tests, visibly broken UX | Real-gesture harness + visible-counterpart GOTCHA |
| Two features fixed, third silently regressed by a stale worktree base | Fork-point drift diff before every integration |
| Subagent died mid-wave (transient API error) | Orchestrator audits the partial tree, re-runs all gates itself, finishes the remaining verification |
| "It's split, therefore it's better" | Audit shape AND behavior; splits must follow a named pattern, not just a line count |
