// Shared MCP annotation sets for the curated overlay. The generated tools
// derive theirs from the HTTP method (specgen/generator/tools.ts); curated
// tools have no method to read, so each one picks the set that matches what
// it does. Every tool here reaches the Runpod API, so openWorldHint is always
// true.
import type { ToolAnnotations } from '../types.js';

/** A pure read: safe to call without asking anyone. */
export const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** A write that creates or submits: repeating it produces another thing. */
export const write: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** A write that sets state: repeating it lands on the same state. */
export const idempotentWrite: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** A write that destroys work in flight (cancel, purge, delete). */
export const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
