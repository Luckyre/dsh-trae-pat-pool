# PAT Pool UI A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved PAT pool overview, explicit credential save/validation, collapsible account cards, and session-specific account/allowance indicators.

**Architecture:** Keep state projection and per-request ownership separate from selection. Add a pure request tracker and a host account-status service, expose additive authenticated routes, then consume their snapshots in the existing client settings and composer registrations. Keep the old single-PAT fallback and selection policies.

**Tech Stack:** TypeScript host, plain JavaScript React client, DSH connection/credentials/config services, esbuild, node:test.

---

Working directory: `C:/Users/PC/Documents/deepseek-harness/default-workspace/.worktrees/dsh-trae-pat-pool-ui-a`.

Approved specification: `docs/superpowers/specs/2026-11-28-pat-pool-ui-design.md` (all sections apply).

Execution decision: continue in this session using scoped subagents and sequential integration; user has authorized implementation, so no additional execution-mode question is needed. Do not install, publish, push, or alter the original dirty worktree. Reuse its dependencies through the existing node_modules junction. Only one writer owns a given source file at a time; only the integrating agent runs final builds and commits generated artifacts.

## File ownership and boundaries

- `src/trae/request-usage.ts` (new): request lifecycle, per-session/latest snapshots, bounded switch history, stale completion protection.
- `src/trae/pool-view.ts` (new): configuration/validation/cooldown projection, safe errors, credential generations, per-seat validation deduplication.
- `src/trae/pool.ts`: targeted force validation and request-scoped failure reporting, normalized single-seat reference; no policy changes.
- `src/adapter.ts`: start, select, switch, complete/cancel/fail request ownership; pass actual member into stream failure reporting.
- `src/index.ts`: connect host services and authenticated status/validation/usage routes, credential invalidation.
- `src/trae/quota.ts`: targeted seat lookup without reading every other seat.
- `client/client.js`: existing module-loader factory, localized account overview/cards, explicit secret drafts and save states, shared polling and session indicator. Extract local responsibilities within the factory to preserve the current one-file browser artifact.
- `test/_internals.ts`: export real new units for tests.
- `test/pool-ui.test.mjs`, `test/request-usage.test.mjs` (new): host behavior tests; extend existing pool, plugin and client suites for integration.
- `package.json`: include new test suites; preserve all existing scripts.
- `README.md`, `CHANGELOG.md`: final behavior and evidence boundaries.
- `lib/index.js`, `lib/client.js`: generated only after source integration.

## Task 1: Clean baseline and behavioral contracts

- [ ] Build the tracked test entry and run the tracked baseline suite. Record failures with exact names; do not silently adjust unrelated tests.
- [ ] Add request tracker tests before implementation. The core assertion is:

```js
const usage = new RequestUsage()
const old = 'request-old'
usage.start('s1', old, 'm')
usage.select('s1', old, 'A', 'Account A')
const current = 'request-current'
usage.start('s1', current, 'm')
usage.select('s1', current, 'B', 'Account B')
usage.finish('s1', old, 'completed')
assert.equal(usage.get('s1').requestId, current)
assert.equal(usage.get('s1').phase, 'running')
assert.equal(usage.get('s1').seatId, 'B')
```

- [ ] Add a second interleaved-session assertion so `s2` activity never replaces `s1`. Use explicit timestamps/ids via constructor injection if necessary; no sleep-based race tests.
- [ ] Run the new tests and confirm the missing behavior fails before adding production logic.

## Task 2: Request ownership and concurrent failure attribution

- [ ] Implement the request tracker with methods `start(sessionId, requestId, model)`, `select(sessionId, requestId, seatId, seatName, reasonCode?, credentialVersion?)`, `finish(sessionId, requestId, phase)`, `get(sessionId)` and `latest()`. The adapter allocates the request id; snapshots carry a non-secret opaque credentialVersion so historical usage cannot be paired with a replacement credential's quota. Use phases selecting/running/completed/failed/cancelled, bounded sessions and at most ten switch records. Return immutable copies and keep the account name captured when selected.
- [ ] Add tracker to adapter options through a structural interface. Start only main-loop turns, update on every actual pool pick including failover and retries, finish in a finally path with the real result. Background title/compaction requests cannot call tracker start/select.
- [ ] Carry the chosen member for each stream attempt in local request state. Extend `reportFailure(code, message, memberId?)` compatibly and pass the explicit member at stream errors. Add a single-seat normalized reference path without changing the existing non-pool request policy.
- [ ] Add adapter regression tests with controlled asynchronous streams: two concurrent sessions use A/B; an A stream failure after B selection must report A. Include stop/failure and old completion after a newer request.
- [ ] Rebuild test entry, run request tracker, pool and adapter tests, then review the diff against spec sections 3.2/5.3 before the integration commit.

## Task 3: Pool state, validation and targeted quota

- [ ] Add tests with real pool objects and fake fetch responses for these outcomes: configured but unknown; missing token; PAT exchange accepted; direct JWT parsed locally but server rejects identity; network failure; cooldown persists after successful validation; credential replacement while old validation is pending.
- [ ] Verify absent module/behavior failures, then add the pool-view service. Each row has seatId/name/priority/configured/writable/validation/checkedAt/validatedUntil/reasonCode/retryAt/identity. Unknown read errors remain unknown, not false.
- [ ] Build counts from these rows: total, configured, verified usable, cooldown/invalid, needs setup/verification. No result may contain token/password/raw server bodies. Use generation numbers on credential changes; discard older generation results. Cache only in memory with expiry bounded by JWT validity.
- [ ] Force targeted PAT verification using per-seat auth, bypassing selection and rotation; for direct JWT use the existing GetUserInfo service through an explicit seat-bound auth provider. Coalesce simultaneous per-seat validations, preserve cooldown and sanitize errors to standard codes. No validation calls chat endpoints.
- [ ] Expose targeted quota lookup by validated seatId; refactor shared computation as needed so only that seat is queried and the legacy primary/all functions preserve behavior.
- [ ] Run pool-ui, pool and quota tests. Inspect generated responses in assertions for unexpected secret fields and verify the rotation cursor has not advanced after status/validation reads.

## Task 4: Authenticated host route integration

- [ ] Extend existing plugin route harness tests to assert GET pool returns a snapshot, POST validate rejects malformed JSON/types (400) and unknown refs (404), and GET session with view=usage returns only tracked data without auth/userInfo calls.
- [ ] Wire the new host state and request tracker in `src/index.ts`; use the same connection registrations and error envelope as existing routes. Credential/config updates invalidate only affected seat validation generations and refresh the roster.
- [ ] Add latestRequest to GET pool; add request to the old session projection while preserving all old fields; for view=usage branch before any userInfo/auth calls. Accept `?seat=` in the quota route before primary/all dispatch; reject unknown accounts.
- [ ] Use `request.json()` only for non-secret `{ seatId }`, verify membership, return structured safe errors. Never accept a raw token through these routes.
- [ ] Build and run the host plugin harness and all new behavior tests. Review spec compliance, then code quality before handing the stable route contract to the client task.

## Task 5: Client save feedback and account overview

- [ ] Extend client behavioral harness with credentials.set failures and deferred responses. Assert PAT stage does not call credentials.set after time passes/structural changes; explicit save calls it once; rejected save retains draft; successful old save cannot clear newly edited text; saved validation failure retains configured state.
- [ ] Change secret-field staging to explicit commit, keep name debounce only. Store per-field draft revision and save status rather than a global busy bit for all cards. Clear secrets after acknowledged write, independently re-read metadata, then invoke targeted validation; preserve drafts on write failure. Cancel edit only clears that draft, never the saved credential.
- [ ] Add zh/en locale entries for all new statuses and actions. Render top five statistics with loading/error states, latest global request, collapsible account cards, attention filter and existing move/remove controls. Use DSH theme tokens and primitive controls; no app root replacement or actual raw credential read-back.
- [ ] Add keyboard-accessible expand/save/cancel controls and a live status region. Unknown identity falls back to user name/account number, never the credential reference as an email. Read-only credentials disable editing with a clear reason.
- [ ] Add shared status fetching with an active/visibility-aware timer. Settings uses 15s, session usage uses 2s running / 30s idle, 5/15/30s error backoff. Deduplicate requests; abort/discard stale responses and clear timers at disposal. Refresh after account mutation and save/verify.
- [ ] Run client tests against a newly copied/built browser artifact. Update old debounce tests to describe the new explicit PAT behavior, keeping meaningful non-secret name-debounce coverage.

## Task 6: Session indicator and per-account allowance

- [ ] Add client regression cases for two session stores, phase completed/cancelled/failed, no usage yet, account switch with an old quota response resolving late, and allowance errors while usage remains visible.
- [ ] Integrate account state into the existing composer quota registration so old slot ids remain compatible. Use the slot's actual sessionId; never read global last-used member for a conversation label. Add explanatory tooltip and inline switch notice.
- [ ] Fetch `quota?seat=` only for the captured account, using the existing low-frequency cache; do not force quota refresh every usage poll. Clear old seat's number immediately on switching. No usage means no invented current-account percentage.
- [ ] Run client/host integration suites, then inspect the feature diff for changes outside approved scope.

## Task 7: Verification, documentation and local delivery

- [ ] Update README with explicit PAT saving, validation meanings, status count definitions, per-session indicator and targeted quota. Add an Unreleased changelog entry; do not invent a published release number.
- [ ] Run typecheck, production build, test-entry build and the complete tracked/new test suites using bundled Node/pnpm. Preserve the original working tree's uncommitted work; generated artifacts belong to this feature branch only.
- [ ] Request independent specification review first; resolve findings. Then request code-quality/security/concurrency review and resolve findings. Read the final diff, not only reviewer summaries.
- [ ] Verify browser rendering when tools allow it. If real plugin installation is not authorized, do not modify the current profile; report separately which real GUI assertions were not exercised. Static tests and a prototype are not proof of current DSH installation changes.
- [ ] Commit only reviewed source, tests, docs and generated artifacts on feature/pat-pool-ui-a. Check worktree state and commit identity, then deliver branch/commit, main visible changes, tests and remaining runtime coverage. Leave installation/release/push for a separate explicit instruction.

## Commands

Use direct existing tool entry points in this sandbox. pnpm's implicit dependency verification rejects the deliberately shared node_modules junction, and the normal Node test runner cannot spawn piped child processes here:

```powershell
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/esbuild/bin/esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=lib/index.js --external:@deepseek-ai/cordis --external:@deepseek-ai/dsh-llm --external:@deepseek-ai/schemastery
Copy-Item client/client.js lib/client.js
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' node_modules/esbuild/bin/esbuild test/_internals.ts --bundle --platform=node --format=esm --target=node20 --outfile=lib/testing.mjs --external:@deepseek-ai/dsh-llm
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test --test-isolation=none --test-concurrency=1 test/request-usage.test.mjs test/pool-ui.test.mjs
& 'C:\Users\PC\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test --test-isolation=none --test-concurrency=1 --test-skip-pattern='^artifact: a stored zip with UTF-8 names that unzip accepts$' test/internals.test.mjs test/pool.test.mjs test/pool-plugin.test.mjs test/plugin.test.mjs test/client.test.mjs test/share.test.mjs test/request-usage.test.mjs test/pool-ui.test.mjs
```

Baseline result: 158 passed / 159 total; only `artifact: a stored zip with UTF-8 names that unzip accepts` failed because its captured `execFileSync('python3')` is blocked with EPERM. Preserve that test unchanged. Its ZIP header, standard CRC, UTF-8 names, contents and Python zipfile CRC assertions were separately executed with the real zipStore export and bundled Python invoked directly from PowerShell; all passed. Final test report must name the one runner skip and this separate coverage, not describe the skipped test itself as passing.

Expected: typecheck/build and feature suites exit 0, full compatible regression has zero failures with the one named platform skip. Regular package scripts remain suitable for ordinary CI; no dependencies are reinstalled and no original worktree files are changed.

## Plan self-review

Spec coverage: tasks 2/6 cover conversation ownership and allowance; tasks 3/4 cover status/validation/compatibility/security; task 5 covers cards, statistics, save state, visibility, locale and disposal; task 7 covers final code and actual GUI evidence. No implementation task authorizes profile installation or upstream publication. Contract property names and phases in the tasks match the specification. All tasks use real units and behavior tests rather than copying implementation predicates.
