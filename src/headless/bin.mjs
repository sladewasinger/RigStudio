#!/usr/bin/env node
// `bin` launcher for the `rig-studio` CLI (package.json's `bin.rig-studio`). Uses
// tsx's `tsImport` API to run the TypeScript entry point (`cli.ts`) in-process — no
// subprocess spawn, no pre-compile step — so `npx rig-studio <cmd>` (or an
// `npm link`ed `rig-studio`) works without a build. This repo's own dev workflow
// (`npm run rig -- <cmd>`) takes the simpler `tsx src/headless/cli.ts` path directly
// and never touches this file.
//
// Plain `.mjs` (not `.ts`): it must be runnable by a bare `node` with no loader
// already active — it's the thing that BRINGS TS support in, so it can't depend on
// TS support existing yet. It lives under src/headless/ (not a top-level bin/ folder)
// to keep every new file from this wave inside one folder.
import { tsImport } from 'tsx/esm/api';

await tsImport('./cli.ts', import.meta.url);
