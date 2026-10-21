// The client configures form/non-exploded arrays globally. Fail generation if
// a future spec requires another encoding, so new routes cannot silently regress.
export function validateQueryEncoding(spec) {
  function resolve(value) {
    const seen = new Set();
    while (value?.$ref) {
      const ref = value.$ref;
      const annotations = new Set(["$ref", "description", "summary", "title", "deprecated", "example", "examples", "externalDocs"]);
      if (Object.keys(value).some(key => !annotations.has(key))) {
        throw new Error(`Unsupported query reference siblings: ${ref}`);
      }
      if (!ref.startsWith("#/") || seen.has(ref)) throw new Error(`Unsupported query reference: ${ref}`);
      seen.add(ref);
      value = ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
      if (!value) throw new Error(`Missing query reference: ${ref}`);
    }
    return value;
  }
  const scalarTypes = new Set(["string", "number", "integer", "boolean"]);
  function scalar(schema) {
    return schema && scalarTypes.has(schema.type) && !schema.allOf && !schema.oneOf && !schema.anyOf;
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
      if (!item[method]) continue;
      const parameters = new Map();
      for (const raw of [...(item.parameters ?? []), ...(item[method].parameters ?? [])]) {
        const parameter = resolve(raw);
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      for (const parameter of parameters.values()) {
        if (parameter.in !== "query") continue;
        const schema = resolve(parameter.schema);
        const type = schema?.type;
        // Require a reviewed serializer for composition/content/object queries.
        if (!schema || schema.allOf || schema.oneOf || schema.anyOf ||
            (type === "array" ? !scalar(resolve(schema.items)) : !scalar(schema))) {
          throw new Error(`Unsupported query schema: ${method} ${path} ${parameter.name}`);
        }
        const style = parameter.style ?? "form";
        const explode = parameter.explode ?? (style === "form");
        if (parameter.allowReserved || style !== "form" || (type === "array" && explode !== false)) {
          throw new Error(`Unsupported query encoding: ${method} ${path} ${parameter.name}`);
        }
      }
    }
  }
}
