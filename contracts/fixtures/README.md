# Golden fixture corpus

Generated once from the Python test suite (see `docs/typescript-rewrite.md`'s "Contract
preservation strategy"): per test case, either the exact `model_dump()` JSON (valid cases) or
the exact `e.errors()` list (invalid cases) from the real Pydantic models. The TypeScript
`packages/schema` test suite runs the same fixtures through its Zod schemas and asserts
byte-identical output and error messages. Populated in Phase 2 of the rewrite.
