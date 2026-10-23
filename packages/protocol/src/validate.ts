import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { VapError } from "./errors.js";

// ajv and ajv-formats are CommonJS; load them through require so that the constructor
// resolves identically under every ESM loader.
const require = createRequire(import.meta.url);
type Ajv2020Ctor = typeof import("ajv/dist/2020.js").Ajv2020;
type AjvInstance = InstanceType<Ajv2020Ctor>;
type ValidateFunction = ReturnType<AjvInstance["compile"]>;

const ajvModule = require("ajv/dist/2020.js") as Ajv2020Ctor & { Ajv2020?: Ajv2020Ctor; default?: Ajv2020Ctor };
const Ajv2020: Ajv2020Ctor = ajvModule.Ajv2020 ?? ajvModule.default ?? ajvModule;
const formatsModule = require("ajv-formats") as ((ajv: AjvInstance) => AjvInstance) & { default?: (ajv: AjvInstance) => AjvInstance };
const addFormats = formatsModule.default ?? formatsModule;

export const SCHEMA_BASE = "https://schemas.vap.invalid/0.1/";
export const SCHEMA_DIR = new URL("../schemas/", import.meta.url);

/** Schema names accepted by validate(). Message bodies are addressed as "messages#<def>". */
export type SchemaName =
  | "task"
  | "observation"
  | "action"
  | "plan"
  | "operation"
  | "evidence"
  | "grant"
  | "approval"
  | "event"
  | `messages#${string}`;

export function loadSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".schema.json")) continue;
    out[file] = JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")) as Record<string, unknown>;
  }
  return out;
}

let shared: SchemaValidator | undefined;

export function schemaValidator(): SchemaValidator {
  shared ??= new SchemaValidator();
  return shared;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class SchemaValidator {
  private readonly ajv: AjvInstance;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      allowUnionTypes: true,
      // Arbitrary-structure fields (facts, arguments, input_schema) are typed as plain objects.
      validateSchema: true,
    });
    addFormats(this.ajv);
    for (const schema of Object.values(loadSchemas())) this.ajv.addSchema(schema);
  }

  private compiled(name: SchemaName): ValidateFunction {
    let fn = this.cache.get(name);
    if (fn) return fn;
    const ref = name.startsWith("messages#")
      ? `${SCHEMA_BASE}messages.schema.json#/$defs/${name.slice("messages#".length)}`
      : `${SCHEMA_BASE}${name}.schema.json`;
    fn = this.ajv.getSchema(ref);
    if (!fn) throw new Error(`unknown schema ${name}`);
    this.cache.set(name, fn);
    return fn;
  }

  check(name: SchemaName, data: unknown): ValidationIssue[] {
    const fn = this.compiled(name);
    if (fn(data)) return [];
    return (fn.errors ?? []).slice(0, 20).map((e) => ({
      path: e.instancePath || "/",
      message: `${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? `: ${String(e.params.additionalProperty)}` : ""}`,
    }));
  }

  /** Validates an inbound body; throws INVALID_ARGUMENT with safe details. */
  assertRequest<T>(name: SchemaName, data: unknown): T {
    const issues = this.check(name, data);
    if (issues.length > 0) {
      throw new VapError("INVALID_ARGUMENT", `request does not match ${name}`, { details: { issues } });
    }
    return data as T;
  }

  /** Validates an outbound payload. A failure is a server defect, never the caller's fault. */
  assertResponse<T>(name: SchemaName, data: T): T {
    const issues = this.check(name, data);
    if (issues.length > 0) {
      throw new VapError("INTERNAL", `response failed ${name} schema validation`, { details: { issues } });
    }
    return data;
  }

  /** Compiles a caller-independent JSON Schema such as an action's input_schema. */
  compileInputSchema(schema: Record<string, unknown>): (data: unknown) => ValidationIssue[] {
    const fn = this.ajv.compile(schema);
    return (data: unknown) =>
      fn(data)
        ? []
        : (fn.errors ?? []).slice(0, 20).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
  }
}

/** Rejects unsupported major protocol versions with a useful compatibility error. */
export function assertProtocolVersion(body: unknown): void {
  if (body === null || typeof body !== "object") return;
  const v = (body as { protocol_version?: unknown }).protocol_version;
  if (v === undefined) return; // reported by schema validation
  if (typeof v !== "string" || v.split(".")[0] !== "0" || v !== "0.1") {
    throw new VapError("UNSUPPORTED_PROTOCOL_VERSION", `protocol_version ${JSON.stringify(v)} is not supported; this runtime speaks 0.1`, {
      details: { supported: ["0.1"] },
    });
  }
}
