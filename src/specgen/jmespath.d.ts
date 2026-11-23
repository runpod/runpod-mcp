// jmespath 0.16.0 ships no types, and @types/jmespath declares only search.
// compile returns the syntax tree list-query.ts checks before running it.
declare module 'jmespath' {
  export interface JmespathNode {
    type: string;
    name?: string;
    value?: unknown;
    children?: (JmespathNode | number | null)[];
  }
  export function compile(expression: string): JmespathNode;
  export function search(data: unknown, expression: string): unknown;
}
