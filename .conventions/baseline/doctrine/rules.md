# Rule register

Every rule in `doctrine/` has a row here, with its enforcement status in each consuming repo. This
file is what makes [tenet 1](tenets.md) checkable: a rule is either enforced by a named gate, or
says why it is not.

**Status vocabulary**

| Status | Meaning |
|---|---|
| **gated: `<gate>`** | A named CI check fails on a violation |
| **partial: …** | Enforced for part of the scope; what's missing is stated |
| **practiced** | The code follows it today, but nothing would catch a violation |
| **convention: …** | Deliberately not gated, with the reason |
| **uncovered** | Not followed, or not checked. A known hole |

**Registered consumers.** temper and tasker-core have a column below. temper-contrib, tasker-contrib
and storyteller are also registered consumers (2026-10-23); every rule's status for them is
**unexamined** until each adopts the baseline, and is taken then from a fresh reading of that repo,
not copied from these columns. Their columns are not added by hand: per-consumer statuses are moving
into each consumer, and the columns here will be generated from them. For tasker-contrib the
baseline covers its own surfaces only; its templates and example apps are user-owned.

Rows for the Google style-guide integration (RUST-LINT-5 onward, and the Python, TypeScript,
Shell, Markdown and API sections) were taken on 2026-10-23 against `temper@d530840` and
`tasker-core@3888d42`; their counts come from clippy, ruff, Biome, tsc and ShellCheck runs as
well as grep. Statuses were taken on 2026-10-21 against `temper@f460428` and
`tasker-core@48ac836`, and amended on 2026-10-23 for tasker-core#376 and temper#1217, from a
read-only inventory of each repo; counts come from grep. Gated and uncovered cells were checked by
hand. A `practiced` cell is a reading of the code, not a proof — the first grounding pass on each
section re-verifies them. A change that alters a status updates its row in the same change.

## Rust

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| RUST-LINT-1 | One workspace lint table, inherited by every crate | uncovered (no `[lints]` table) | gated: workspace table, every crate inherits |
| RUST-LINT-2 | Clippy and rustdoc `-D warnings` on PRs | gated: code-quality.yml, pre-push | gated: code-quality.yml (tasker-core#376); release pre-flight clippy still lacks it |
| RUST-LINT-3 | `#[expect(reason)]`, never `#[allow]` | uncovered (no rule; ~19 `#[allow]`) | partial: written rule; lint commented out; ~33 `#[allow]` |
| RUST-LINT-4 | Lint adoption is audit-before-enforce | convention: a process rule, judged in review | convention: same |
| RUST-LINT-5 | Held-off groups opened lint by lint | convention: a process rule | convention: same |
| RUST-API-1 | API rules bind library crates, default for application crates | convention: classification, judged in review | convention: same (10 of 14 crates are published, so most are library crates) |
| RUST-FMT-1 | rustfmt defaults, checked in CI | gated: quality-gate.yml `cargo fmt --check` (9 `rustfmt::skip`, unexamined) | gated: code-quality.yml `cargo fmt --check` |
| RUST-ORG-1 | No glob imports | uncovered: 4 `wildcard_imports` findings; lint not set | uncovered: 26 findings; lint not set |
| RUST-ORG-2 | Files named for their item; non-leaf modules only declare | convention: judged in review; unexamined | convention: same; unexamined |
| RUST-UNSAFE-1 | `#![forbid(unsafe_code)]` in every crate root | uncovered | uncovered (no production unsafe, but no forbid) |
| RUST-UNSAFE-2 | Unsafe sites are registered exceptions, with SAFETY comments | uncovered (~10 sites, unregistered) | partial: `undocumented_unsafe_blocks` lint; no register |
| RUST-UNSAFE-3 | FFI through binding frameworks | n/a (no FFI) | practiced (magnus, PyO3, napi-rs) |
| RUST-ERR-1 | `thiserror` in libraries, `anyhow` at edges | practiced | practiced |
| RUST-ERR-2 | No silent defaults for required values | uncovered | uncovered (~121 `unwrap_or_default`; doctrine exists) |
| RUST-ERR-3 | Panics are for bugs | convention: needs judgment per site | convention: same |
| RUST-ERR-4 | No unchecked `unwrap` outside tests | uncovered: 11 `unwrap_used` findings (lib/bin); `unnecessary_unwrap` 0 | uncovered: 76 findings; `unnecessary_unwrap` 0 |
| RUST-PANIC-1 | `catch_unwind` is defense in depth, and needs `panic = "unwind"` | practiced: release unwinds; the one production catch resumes | **uncovered: violated** — `[profile.release] panic = "abort"` with 3 containment sites |
| RUST-TYPE-1 | Public types implement `Debug` | uncovered (lint not set) | gated: `missing_debug_implementations` (with RUST-LINT-2 once fixed) |
| RUST-TYPE-2 | Confusable values are newtypes; unclear bools are enums | convention: judged in review | convention: same |
| RUST-API-2 | Published types `#[non_exhaustive]`; internal types exhaustive | convention: `exhaustive_enums` would fire on internal types; 35 uses, unexamined | convention: same; 8 uses, unexamined |
| RUST-API-3 | Standard traits and derives over bespoke methods | practiced: 0 findings of the four lints; ungated until the table is adopted | practiced: same |
| RUST-API-4 | Accept the most general borrow | practiced: 0 `ptr_arg`/`borrowed_box`; ungated | practiced: same |
| RUST-API-5 | Conversion and constructor naming | partial: `wrong_self_convention` 0, ungated; the rest review | partial: same |
| RUST-API-6 | `#[must_use]` where ignoring is a bug | convention: judged in review (22 uses) | convention: same (179 uses) |
| RUST-TC-1 | Float stable, declare `rust-version` | partial: floats; no MSRV | partial: floats; MSRV on two crates only |
| RUST-TC-2 | Edition is a workspace setting | practiced | practiced |
| RUST-TC-3 | No unstable features | gated: stable CI toolchain refuses `#![feature]` (0 sites) | gated: same (0 sites) |
| RUST-DOC-1 | Library crates document their public API | uncovered: no `missing_docs`; 25 `missing_panics_doc` | uncovered: same; 25 `missing_panics_doc` |
| RUST-READ-1 | Readability over cleverness | convention: judged in review | convention: same |
| RUST-MACRO-1 | A macro is the last resort | convention: judged in review | convention: same |
| RUST-INIT-1 | No first-party code before `main` | practiced: no `ctor` in the lockfile | practiced: `ctor` only via napi-rs |
| RUST-SQL-1 | Compile-checked queries; runtime queries registered | gated: `audit-sqlx-macro-exceptions.sh` | partial: macros dominant (~337 vs ~101 runtime); no register |

## Supply chain

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| SC-ADV-1 | `cargo audit` gates | gated: quality-gate.yml | uncovered: `continue-on-error` and `|| echo` |
| SC-ADV-2 | Reviewed, reasoned ignores | gated: by review of `.cargo/audit.toml` | partial: one ignore, no reason or status |
| SC-DENY-1 | Only crates.io | gated: `cargo deny check sources` | uncovered (no cargo-deny) |
| SC-DENY-2 | License allowlist | gated: `cargo deny check licenses` | uncovered |
| SC-DENY-3 | Bans (wildcards, deny list; duplicates warn) | uncovered (bans not run) | uncovered |
| SC-GHA-1 | Every `uses:` SHA-pinned | partial: privileged jobs gated by `audit-privileged-action-pins.sh`; 39/82 overall | practiced: every `uses:` pinned (tasker-core#376); no tripwire |
| SC-GHA-2 | Top-level `permissions:` | partial: 13/14 workflows; not gated | practiced: 12/12 (tasker-core#376); no tripwire |
| SC-GHA-3 | Release-chain triggers pinned | gated: `check-release-chain-triggers.sh` | uncovered |
| SC-IN-1 | Tool installs pinned or cooled | gated: mise `minimum_release_age`, `mise.lock` | uncovered |
| SC-IN-2 | Dependency updates for every ecosystem | practiced | partial: cargo and Actions; PR #341 adds the rest |
| SC-IN-3 | Lockfiles match manifests | partial: npm via `check-lockfile-versions.sh` | partial: PR #342 adds cargo, bundler and uv |
| SC-SEC-1 | gitleaks and CodeQL | gated: secret-scan.yml, codeql.yml, pre-commit | uncovered |

## Security

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| SEC-CRED-1 | Credentials are secret types | partial: `secrecy` in temper-client only | partial: tasker-secure exists; one consumer |
| SEC-CRED-2 | Credential `Debug` redacted, proven | gated: `audit-credential-debug.sh` | practiced (hand redaction); unproven |
| SEC-CRED-3 | Constant-time comparison | practiced | practiced |
| SEC-CRED-4 | One secret per purpose | gated: `audit-signature-secrets.sh` | uncovered |
| SEC-RED-1 | One redaction module | practiced (`temper-core/src/redact.rs`) | uncovered (duplicated `redact_url`) |
| SEC-RED-2 | Redact by origin, deny by default | practiced | uncovered |
| SEC-SQL-1 | Bind values, validate identifiers | practiced | practiced (queue and NOTIFY validators) |
| SEC-SQL-2 | Authorisation inside the query | practiced | convention: unexamined for tasker-core's model |
| SEC-AUTH-1 | Disabled-auth mode is loud and cannot ship | n/a (auth always on) | uncovered (auth off by default) |
| SEC-AUTH-2 | Authorise before reading the body | gated: `audit-route-auth.sh` | practiced (`authorize()` at the route) |
| SEC-AUTH-3 | Refusal does not reveal existence | practiced | unexamined |
| SEC-TEST-1 | Test doors never ship | gated: `check-production-features.sh` | uncovered |
| SEC-RPT-1 | SECURITY.md with private reporting | practiced | practiced |

## Concurrency

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| CONC-BOUND-1 | No unbounded channels | practiced (0 sites); ungated | practiced (0 sites); ungated |
| CONC-BOUND-2 | Bounds from configuration | uncovered (no rule) | practiced (1 literal outside tests); ungated |
| CONC-BOUND-3 | Declared at-bound strategy | uncovered | practiced (doctrine with recipe) |
| CONC-BOUND-4 | Queues observable | uncovered | practiced (`ChannelMonitor`) |
| CONC-FAIL-1 | Spawned work joined or supervised | unexamined | partial: `catch_unwind` at boundaries, inert in release builds (RUST-PANIC-1) |
| CONC-FAIL-3 | A poisoned lock is not quietly recovered | practiced: 4 recoveries, all whole-value writes with a comment (temper-client `auth.rs`) | practiced: 0 recoveries |
| CONC-FAIL-2 | Concurrent work is named | practiced (`#[act_span]`) | practiced (`spawn_named!`) |
| CONC-DB-1 | Atomic cross-process state in the database | practiced | practiced (CAS functions, `SKIP LOCKED`) |
| CONC-DB-2 | Idempotent retries by construction | practiced (create idempotency keys) | practiced (identity hash) |
| CONC-DB-3 | One decision per transaction | convention: judged in review | convention: same |

## Tripwires

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| TW-1 | Header states why, and what is NOT CHECKED | practiced | n/a (no tripwires yet) |
| TW-2 | Reviewed baseline, `--list`, `UPDATE_BASELINE` | practiced | n/a |
| TW-3 | Empty scan fails | practiced | n/a |
| TW-4 | Fixture override seam | practiced | n/a |
| TW-5 | Bite test | partial: 8 check scripts lack one | n/a |
| TW-6 | Derived set; CI covers all | gated: `cargo make tripwires` | n/a |
| TW-7 | Key on the bug, not the shape | convention: judged in review | n/a |

## Testing and CI

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| TEST-1 | Ignored tests registered with reasons | gated: `audit-ignored-tests.sh` | uncovered |
| TEST-2 | Never weaken a test to get green | convention: judged in review | convention: same (in CLAUDE.md) |
| TEST-3 | Every tier runs in CI | practiced | partial: `test-cluster` local only, by design |
| TEST-4 | Retries are reported | gated: `junit-summary.py` annotations | uncovered |
| TEST-5 | Coverage floors in CI | partial: nightly, advisory | uncovered (local only) |
| CI-1 | Cheap stage-1 gate | gated: quality-gate.yml | uncovered |
| CI-2 | One required aggregate check | gated: `ci-success` | gated: `CI Success` |
| CI-3 | Generated artifacts drift-checked | gated: every generated artifact | partial: codegen syntax only |
| CI-4 | Selective pre-commit hook | practiced | partial: fmt only, opt-in |
| CI-5 | Required checks run on `merge_group` | gated: `ci.yml` `merge_group` trigger; queue exercised | practiced: `ci.yml` `merge_group` trigger (tasker-core#376); first queue merge 2026-10-23; no tripwire |
| CI-6 | Job timeouts budget for cold-cache queue runs | unexamined | practiced: integration timeout 25→40 min (tasker-core#376) |

## Agent guidance

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| AG-1 | Entry file is a router | practiced | uncovered (monolithic CLAUDE.md) |
| AG-2 | Rules state their reason | practiced | partial |
| AG-3 | Rules state their enforcement | uncovered | uncovered (`SQLX_OFFLINE` contradiction) |
| AG-4 | Facts derived or checked | partial: CLI and config references drift-gated | uncovered (stale crate list) |
| AG-5 | Baseline arrives as a projected skill | uncovered (not built) | uncovered |
| AG-6 | Hooks point at real paths | practiced | practiced (SessionStart path fixed, tasker-core#376); no check |

## Python

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| PY-LINT-1 | Every `.py` file under ruff check and format in CI | partial: temper-py gated (test-python.yml); 16 gate scripts unlinted | uncovered: CI runs no ruff (`check-python` is local only); `tools/` outside any config |
| PY-LINT-2 | One canonical ruff selection | uncovered: temper-py 6 findings under `python/ruff.toml`, `.github/scripts` 35 | uncovered: tasker-py 76 findings (37 `BLE001`), tests 186 (mostly autofixable) |
| PY-LINT-3 | Suppressions name code and reason; unused ones fail | practiced: all coded; not gated | partial: all coded; 140 unused `noqa` |
| PY-TYPE-1 | Published packages pass `mypy --strict` in CI | gated: test-python.yml | practiced: 0 issues locally; not in CI |
| PY-TYPE-2 | Native-module stub checked against the module | n/a (no native module) | uncovered: `_tasker_core.pyi` hand-written, unchecked |
| PY-ERR-1 | No bare except; broad except only at a declared boundary | practiced | partial: 37 `BLE001` sites to audit |
| PY-ERR-2 | `assert` is not validation | practiced: 0 library sites | practiced: 0 library sites |
| PY-DEF-1 | No shared mutable defaults | gated in temper-py (`B`, `RUF`); scripts 6 `PLW0603` | practiced: 1 `RUF012`, 1 `PLW0603`; ungated |
| PY-LOG-1 | Log messages are constants; data in fields | practiced | uncovered: 73 f-string messages to FFI log helpers |
| PY-GEN-1 | Generated Python drift-gated, not linted | gated: `check-temper-py-drift.sh` | partial: codegen output only `ast.parse`d |
| PY-VER-1 | One Python floor, stated once | practiced (3.10) | practiced (3.10) |

## TypeScript

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| TS-TOOL-1 | Every package linted and typechecked in CI | partial: all typechecked; temper-ts, temper-telemetry-ts and both agent packages unlinted | gated: `cargo make lint` and `typecheck` |
| TS-TOOL-2 | One shared rule set; no rule at `warn` | uncovered: per-package configs; `warn` rules never fail | uncovered: same |
| TS-TOOL-3 | One pinned TypeScript and Biome version per repo | uncovered: five TypeScript ranges, two release candidates | practiced |
| TS-CFG-1 | Packages extend one strict tsconfig base | partial: `strict` only; `noUncheckedIndexedAccess` adds 4 (cloud) and 124 (ui) errors | partial: all but `noImplicitOverride` |
| TS-CFG-2 | Erasable syntax only | practiced: 0 enums, namespaces, parameter properties; ungated | uncovered: about 6 sites (2 enums, 4 parameter properties) |
| TS-TYPE-1 | No `any` | partial: `noExplicitAny` at warn; 2 sites (agents) | partial: at warn; 0 sites |
| TS-TYPE-2 | No non-null assertions; assertions justified | uncovered: 60 in temper-ui, 1 in telemetry-ts | partial: 0 `!`; `as unknown as` 30, unexamined |
| TS-SUP-1 | Suppressions name rule and reason | practiced; ungated | practiced (10 sites, all reasoned); ungated |
| TS-MOD-1 | Named exports | practiced: 22 framework defaults (agents) need the override | practiced: test fixtures only |
| TS-ERR-1 | Throw only `Error` | practiced | practiced |
| TS-NAME-1 | Language casing; wire casing on wire types | practiced: 1–37 findings per package with properties exempt | practiced: 25 findings |
| TS-GEN-1 | Generated TypeScript drift-gated, not linted | gated: `openapi-ts-drift`, `ts-rs-drift` | partial: napi `index.d.ts` has no drift check found |
| TS-DOC-1 | Published exports documented | convention: Biome has no rule | convention: same |

## Shell

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| SH-1 | Bash via `#!/usr/bin/env bash` | partial: 137 of 144; 3 `sh` (Vercel), 4 zsh | partial: 29 `#!/bin/bash`; shebang check exists but not in CI |
| SH-2 | Strict mode first | partial: 16 scripts drop `-e` without a comment | practiced: 98 of 104 (the rest sourced) |
| SH-3 | ShellCheck gates in CI | uncovered: pre-commit only, `-S error`; 15 warnings; 25 reasonless disables | partial: clean at `-S warning`, but the pass is not in any workflow |
| SH-4 | `$(…)`, never backticks | uncovered: 1 site, a live bug (`check-cli-reference-drift.sh:83`) | practiced: 0 |
| SH-5 | Commands are arrays; no string `eval` | uncovered: 14 files `eval`, mostly drift gates | practiced: `eval "$(tool …)"` form only |
| SH-6 | Portable between GNU and BSD | partial: staged harnesses run locally in pre-commit | uncovered |
| SH-7 | Shell orchestrates; logic lives elsewhere | convention: judged in review (50 files embed interpreters) | convention: same |

## Markdown

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| DOC-1 | One Markdown shape, linted | practiced: ATX throughout; no linter | partial: markdownlint config, not in CI; MD025 off |
| DOC-2 | Code blocks declare a language | uncovered: 92 of 705 fences | uncovered: 413 of 3,086; MD040 off |
| DOC-3 | Prose wraps at 100 | practiced: about 95% of lines; ungated | uncovered: MD013 off |
| DOC-4 | Intra-repo links resolve | uncovered | uncovered |

## HTTP API JSON

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| API-JSON-1 | snake_case names and enum values | practiced: 0 camelCase; ungated | partial: properties snake_case; PascalCase enum values |
| API-JSON-2 | One error shape, described by the spec | practiced: `ErrorBody` matches the wire; no test | uncovered: wire correct, spec wrong (72 references) |
| API-JSON-3 | Timestamps RFC 3339, typed `date-time` | partial: 24 of 25 | uncovered: 9 of 19 |
| API-JSON-4 | Durations are unit-suffixed integers | practiced | practiced |
| API-JSON-5 | No success envelope; lists say if complete | practiced | practiced |

## Consuming the baseline

| Id | Rule | temper | tasker-core |
|---|---|---|---|
| CONS-1 | The pin is a full SHA on the baseline's main, read from the consumer | uncovered: not adopted | uncovered: not adopted |
| CONS-2 | The projection is never hand-edited; compared with the pin | uncovered: not adopted | uncovered: not adopted |
| CONS-3 | Adopted config matches the projection, apart from exceptions | uncovered: not adopted | uncovered: not adopted |
| CONS-4 | Exceptions are local, reasoned and alive | uncovered: not adopted | uncovered: not adopted |
| CONS-5 | Statuses live in the consumer; a named gate exists | uncovered: not adopted | uncovered: not adopted |
| CONS-6 | Agents receive the projected skill; entry guidance links it | uncovered: not adopted | uncovered: not adopted |
| CONS-7 | Lag is reported on every run, and never fails | uncovered: not adopted | uncovered: not adopted |
| CONS-8 | The checks need nothing an outsider lacks | uncovered: not adopted | uncovered: not adopted |
