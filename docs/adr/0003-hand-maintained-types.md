# ADR 0003: Hand-maintained TypeScript types checked against the schemas

Status: accepted (deviation from the SHOULD "generate TypeScript types")

JSON Schema remains the source of truth and every inbound request and outbound response is
validated against it at runtime (Ajv, strict mode). TypeScript shapes in
`packages/protocol/src/types.ts` are hand-maintained instead of generated, because generation
would add a build-time dependency and tool step that could not be exercised during
implementation.

Mitigation: `tests/unit/schemas.test.ts` fails if any enum in `enums.ts` diverges from the
schemas; responses that drift from the schema fail with INTERNAL rather than shipping silently.
Revisit by adding a generator (for example json-schema-to-typescript) in the cloud pipeline and a
check that the generated file is unchanged.
