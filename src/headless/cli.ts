/**
 * `rig` CLI entry point — a thin process wrapper around `cliCommands.ts`'s pure
 * command functions (kept separate so tests call those directly instead of spawning a
 * process or asserting on real stdout/exitCode). Run via `npm run rig -- <command>`
 * (`tsx src/headless/cli.ts`) or the `rig-studio` bin launcher (`bin.mjs`) — both land
 * here with the same `process.argv`.
 */
import { dispatch } from './cliCommands';

const result = dispatch(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
