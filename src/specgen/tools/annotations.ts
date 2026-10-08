// Shared MCP annotation sets for the curated overlay. The generated tools
// derive theirs from the HTTP method (specgen/generator/tools.ts); curated
// tools have no method to read, so each one picks the set that matches what
// it does. Every tool that reaches the Runpod API sets openWorldHint; the
// knowledge tools read the bundled plugin package and do not. destructiveHint here means "can delete a resource or work in flight",
// not "can lose state": an additive update such as a PATCH is not destructive.
import type { ToolAnnotations } from '../types.js';

/** A pure read: safe to call without asking anyone. */
export const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** A read of the bundled plugin knowledge: no Runpod API call. */
export const bundledRead: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
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
