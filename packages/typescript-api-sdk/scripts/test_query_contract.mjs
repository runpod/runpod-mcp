import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQueryEncoding } from "./query_contract.mjs";
const spec = (query, overrides = []) => ({ paths: { "/test": {
  parameters: [query], get: { parameters: overrides },
} } });
const array = { in: "query", name: "values", schema: { type: "array", items: { type: "string" } }, explode: false };
test("accept current form/non-exploded contract", () => {
  assert.doesNotThrow(() => validateQueryEncoding(spec(array)));
});
test("reject future exploded or unsupported query contracts", () => {
  for (const parameter of [{ ...array, explode: true }, { ...array, style: "spaceDelimited" },
    { ...array, allowReserved: true }, { ...array, schema: { type: "object" } }]) {
    assert.throws(() => validateQueryEncoding(spec(parameter)), /Unsupported query/);
  }
});
test("operation parameters override path parameters", () => {
  assert.doesNotThrow(() => validateQueryEncoding(spec({ ...array, explode: true }, [array])));
});
test("resolve referenced parameter and schema", () => {
  const document = spec({ $ref: "#/components/parameters/Array" });
  document.components = { parameters: { Array: { ...array, schema: { $ref: "#/components/schemas/Array" } } }, schemas: { Array: array.schema } };
  assert.doesNotThrow(() => validateQueryEncoding(document));
  document.components.parameters.Array.explode = true;
  assert.throws(() => validateQueryEncoding(document), /Unsupported query encoding/);
});
test("reject object, nested, untyped, nullable, and composed array items", () => {
  for (const items of [
    { type: "object", properties: { name: { type: "string" } } },
    { type: "array", items: { type: "string" } }, {}, true,
    { type: ["string", "null"] },
    { type: "string", oneOf: [{ const: "a" }, { const: "b" }] },
  ]) {
    assert.throws(() => validateQueryEncoding(spec({ ...array, schema: { type: "array", items } })), /Unsupported query schema/);
  }
});
test("resolve item refs and reject objects or cyclic refs", () => {
  const document = spec({ ...array, schema: { type: "array", items: { $ref: "#/components/schemas/Item" } } });
  document.components = { schemas: { Item: { type: "string", enum: ["POD", "SERVERLESS"] } } };
  assert.doesNotThrow(() => validateQueryEncoding(document));
  document.components.schemas.Item = { type: "object" };
  assert.throws(() => validateQueryEncoding(document), /Unsupported query schema/);
  document.components.schemas.Item = { $ref: "#/components/schemas/Item" };
  assert.throws(() => validateQueryEncoding(document), /Unsupported query reference/);
});
test("accept all supported primitive array item types", () => {
  for (const type of ["string", "number", "integer", "boolean"]) {
    assert.doesNotThrow(() => validateQueryEncoding(spec({ ...array, schema: { type: "array", items: { type } } })));
  }
});
test("do not discard schema constraints alongside item refs", () => {
  const document = spec({ ...array, schema: { type: "array", items: { $ref: "#/components/schemas/Item", type: "object" } } });
  document.components = { schemas: { Item: { type: "string" } } };
  assert.throws(() => validateQueryEncoding(document), /Unsupported query reference siblings/);
});
