export function validateToolInput(schema: Record<string, unknown> | undefined, input: unknown): void {
  if (!schema) return;
  if (schema.type && schema.type !== "object") throw new Error("Tool schema must use object parameters");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");

  const value = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string" || !(key in value)) throw new Error("Missing required parameter: " + String(key));
  }

  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, property] of Object.entries(value)) {
      const definition = (properties as Record<string, unknown>)[key];
      if (!definition) {
        if (schema.additionalProperties === false) throw new Error("Unknown parameter: " + key);
        continue;
      }
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
      const type = (definition as Record<string, unknown>).type;
      if (type && !matchesType(property, type)) throw new Error("Invalid type for parameter: " + key);
    }
  }
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (type === "null") return value === null;
  return true;
}
