/**
 * The one error type every MCP tool handler throws for an expected, user-actionable
 * failure (bad session name, invalid clip, missing file, ...) — `createServer.ts`'s
 * per-tool wrapper catches exactly this type and turns it into an MCP `isError: true`
 * result with the message as-is; anything else (a genuine bug) is re-thrown as a
 * generic "unexpected error" so it isn't mistaken for a handled, actionable failure.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** `e instanceof Error ? e.message : String(e)`, spelled once. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
