// Shared MCP annotation sets for the curated overlay. The generated tools
// start from the HTTP method, with overrides in generator-config.yaml
// (specgen/generator/tools.ts); curated tools have no method to read, so each
// one picks the set that matches what it does. Every tool that reaches the Runpod API sets openWorldHint; the
// knowledge tools read the bundled plugin package and do not. destructiveHint
// means "can delete a resource, lose data that cannot be read back, or
// interrupt work in flight"; a write that only sets the fields it names, with
// the old values still readable beforehand (a rename), is not destructive.
// tests/specgen-annotations.test.ts pins every tool's hints by name.
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

/** A destructive write whose repeat lands on the same state (cancel, purge, replace). */
export const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** A destructive write whose repeat has a further effect (retry, consume). */
export const destructiveWrite: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
