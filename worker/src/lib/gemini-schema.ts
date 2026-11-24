// contracts/relay-steps.md §GeminiSchema, research.md R4. Converts the relay's
// JSON Schemas (strict OpenAI style) into the small subset the app maps onto
// firebase_ai `Schema`. Anything outside the subset throws: a schema the app
// cannot represent must fail in the relay's tests, not on a learner's phone.

export type GeminiType = "object" | "array" | "string" | "number" | "integer" | "boolean";

export interface GeminiSchema {
  type: GeminiType;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  nullable?: true;
}

const TYPES: readonly string[] = ["object", "array", "string", "number", "integer", "boolean"];
// Keywords that carry no meaning for Gemini and are dropped silently.
const DROPPED = new Set(["additionalProperties", "description", "title"]);

export function toGeminiSchema(input: unknown, path = "$"): GeminiSchema {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`gemini schema: ${path} is not an object`);
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let nullable = false;

  for (const [key, value] of Object.entries(src)) {
    if (DROPPED.has(key)) continue;
    switch (key) {
      case "type": {
        let t = value;
        if (Array.isArray(t)) {
          const nonNull = t.filter((x) => x !== "null");
          if (nonNull.length !== 1 || t.length > 2) throw new Error(`gemini schema: ${path}.type union not supported`);
          nullable = t.length === 2;
          t = nonNull[0];
        }
        if (typeof t !== "string" || !TYPES.includes(t)) throw new Error(`gemini schema: ${path}.type '${String(t)}' not supported`);
        out.type = t;
        break;
      }
      case "properties": {
        const props: Record<string, GeminiSchema> = {};
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          props[name] = toGeminiSchema(sub, `${path}.${name}`);
        }
        out.properties = props;
        break;
      }
      case "required":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`gemini schema: ${path}.required invalid`);
        out.required = [...value];
        break;
      case "items":
        out.items = toGeminiSchema(value, `${path}[]`);
        break;
      case "enum":
        if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
          throw new Error(`gemini schema: ${path}.enum must be a non-empty string list`);
        }
        out.enum = [...value];
        break;
      case "nullable":
        if (value === true) nullable = true;
        break;
      default:
        throw new Error(`gemini schema: ${path}.${key} not supported`);
    }
  }
  if (out.type === undefined) throw new Error(`gemini schema: ${path} has no type`);
  if (nullable) out.nullable = true;
  return out as unknown as GeminiSchema;
}
