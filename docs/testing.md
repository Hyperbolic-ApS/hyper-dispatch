# Testing Contract
This document defines the testing contract for HyperDispatch. All new tests added in Phase 1+ and by worker agents must follow these conventions.
## Stack
- Framework: Vitest (`vitest run`) with `@vitest/coverage-v8`.
- Route testing helper: `@hono/testing` via `testClient(app)`.
- ESM-native test files and imports.
- Co-located test files named `*.test.ts`.
- Commands:
  - `npm test`
  - `npm run test:watch`
  - `npm run test:coverage`
  - `npm run typecheck`
## Test layers
- Unit tests (default): mock at module boundaries and validate pure logic/branching behavior.
- Route tests: use `@hono/testing` `testClient(app)` against in-process Hono apps.
- DB integration tests: deferred to Phase 5 and gated behind `RUN_DB_TESTS=1`.
## Mocking conventions
- Only mock at module boundaries, especially:
  - `src/db/queries.js`
  - `src/jira/client.js`
  - `oz-agent-sdk`
  - `@octokit/rest`
- Never mock internal helper functions in the same module under test.
- Reset singleton module state in `beforeEach` (`vi.resetModules()`), especially for `_ozClient` / `_githubClient`.
- Unit tests must not perform real `fetch` calls.
## Fixture conventions
- Use shared fixtures in `src/test/fixtures.ts`.
- Fixture factories should use override-by-spread (`{ ...defaults, ...overrides }`), not deep merge.
- Reuse fixture factories before creating test-local ad hoc objects.
## What to test / what not to test
- Test:
  - Pure logic
  - Branching and state transitions
  - Error and fallback paths
- Do not test:
  - TypeScript type declarations
  - Dashboard HTML rendering details
  - Framework internals
## Coverage policy
- Coverage is informational and not currently merge-gating.
- PRs touching `src/orchestration/`, `src/webhook/`, `src/validator/`, or `src/db/queries.ts` must include new or updated tests.
- The backend coverage initiative target is **at least 75%** coverage for:
  - `src/orchestration/`
  - `src/webhook/`
  - `src/validator/`
## Execution policy
- `npm test` must run cleanly with no skipped tests in standard CI/local runs.
- Integration tests that need external services (for example Postgres) must be opt-in by environment gate (for example `RUN_DB_TESTS=1`) and should not require `it.skip`/`describe.skip` in the default run path.
## Naming and structure
- Use `describe("functionName", ...)`.
- Use `it("does X when Y", ...)`.
- Prefer Arrange/Act/Assert structure in each test.
