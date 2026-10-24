---
name: tasker-systems-conventions
description: The tasker-systems engineering baseline as this repository is pinned to it — the rules,
  why each exists, and whether a gate enforces it here. Use before adding a lint suppression, an
  unsafe block, a dependency, a CI workflow, a test exception, or agent guidance; and whenever you
  are about to claim a rule is enforced.
---

# tasker-systems conventions

This skill is **projected** into this repository from the `tasker-systems/conventions` baseline at
the revision pinned in `.conventions/consumer.toml`. Do not edit it here: `conventions.py bump`
rewrites it, and CI fails if it differs from the projection (CONS-6).

The doctrine itself is in `.conventions/baseline/doctrine/`. Read the file for the area you are
touching; each rule states its *why* beside it, and its id is what you cite in a PR or an
`#[expect(reason)]`.

| Touching | Read |
|---|---|
| The rule register: every rule, and its status in each consumer | `.conventions/baseline/doctrine/rules.md` |
| The short list everything follows from | `.conventions/baseline/doctrine/tenets.md` |
| Rust: lints, formatting, API shape, unsafe, errors, panics, toolchain | `.conventions/baseline/doctrine/rust.md` |
| Python | `.conventions/baseline/doctrine/python.md` |
| TypeScript | `.conventions/baseline/doctrine/typescript.md` |
| Shell scripts and CI gate scripts | `.conventions/baseline/doctrine/shell.md` |
| Markdown | `.conventions/baseline/doctrine/docs.md` |
| HTTP API JSON and OpenAPI | `.conventions/baseline/doctrine/api.md` |
| Dependencies, advisories, licenses, Actions, tool pins | `.conventions/baseline/doctrine/supply-chain.md` |
| Credentials, redaction, SQL, auth | `.conventions/baseline/doctrine/security.md` |
| Channels, spawned work, locks, database coordination | `.conventions/baseline/doctrine/concurrency.md` |
| Tests and CI shape | `.conventions/baseline/doctrine/testing.md` |
| Writing a tripwire | `.conventions/baseline/doctrine/tripwires.md` |
| Agent guidance | `.conventions/baseline/doctrine/agent-guidance.md` |
| This repository's pin, exceptions and statuses | `.conventions/baseline/doctrine/consuming.md` |

## Before you claim a rule is enforced

Check the status below. `gated: <gate>` means a named check fails on a violation **here**. Anything
else — `partial`, `practiced`, `convention`, `uncovered`, `unexamined` — means nothing here would
catch a violation, and saying otherwise is the defect tenet 1 names. An unlisted rule is
unexamined in this repository, not covered.

Local departures from the baseline, each with its reason, are in `.conventions/exceptions.toml`.

<!-- consumer-status:begin -->

Statuses for **temper-contrib**:

| Rule | Status here |
|---|---|
| AG-1 | uncovered: AGENTS.md holds its content rather than routing to topic files |
| AG-4 | uncovered: AGENTS.md's layout list is not checked against the tree |
| AG-5 | gated: .github/workflows/ci.yml#conventions |
| AG-6 | practiced |
| API-JSON-1 | n/a: no HTTP API |
| API-JSON-2 | n/a: no HTTP API |
| API-JSON-3 | n/a: no HTTP API |
| API-JSON-4 | n/a: no HTTP API |
| API-JSON-5 | n/a: no HTTP API |
| CI-1 | uncovered: every job starts at once; none waits on a cheap stage |
| CI-2 | partial: the CI Success job fans every job in; whether the ruleset requires it is a repository setting, not readable here |
| CI-3 | gated: .github/workflows/ci.yml#conventions |
| CI-4 | practiced |
| CI-5 | uncovered: no merge_group trigger |
| CI-6 | practiced |
| CONC-BOUND-1 | uncovered |
| CONC-DB-1 | n/a: no database |
| CONC-DB-2 | n/a: no database |
| CONC-DB-3 | n/a: no database |
| CONS-1 | gated: .github/workflows/ci.yml#conventions |
| CONS-2 | gated: .github/workflows/ci.yml#conventions |
| CONS-3 | gated: .github/workflows/ci.yml#conventions |
| CONS-4 | gated: .github/workflows/ci.yml#conventions |
| CONS-5 | gated: .github/workflows/ci.yml#conventions |
| CONS-6 | gated: .github/workflows/ci.yml#conventions |
| CONS-7 | gated: .github/workflows/ci.yml#conventions |
| CONS-8 | practiced |
| DOC-1 | uncovered: no Markdown lint |
| DOC-4 | uncovered: no link check |
| PY-DEF-1 | gated: .github/workflows/ci.yml#hygiene |
| PY-ERR-1 | gated: .github/workflows/ci.yml#hygiene |
| PY-ERR-2 | gated: .github/workflows/ci.yml#hygiene |
| PY-GEN-1 | n/a: no generated Python |
| PY-LINT-1 | gated: .github/workflows/ci.yml#hygiene |
| PY-LINT-2 | gated: .github/workflows/ci.yml#conventions, .github/workflows/ci.yml#hygiene |
| PY-LINT-3 | gated: .github/workflows/ci.yml#hygiene |
| PY-LOG-1 | gated: .github/workflows/ci.yml#hygiene |
| PY-TYPE-1 | n/a: no published Python package |
| PY-TYPE-2 | n/a: no native module |
| PY-VER-1 | partial: target-version is the projection's (check A); requires-python in plugins/author-tools/pyproject.toml matches it by hand |
| RUST-API-2 | n/a: nothing is published (publish = false) |
| RUST-API-3 | partial: should_implement_trait, new_without_default, len_without_is_empty and derivable_impls are in the gated table; the rest is review |
| RUST-API-4 | partial: ptr_arg and borrowed_box are in the gated table; Option<&T> over &Option<T> is review |
| RUST-API-5 | partial: wrong_self_convention is in the gated table; the rest is review |
| RUST-DOC-1 | n/a: no library crate |
| RUST-ERR-4 | uncovered |
| RUST-FMT-1 | gated: .github/workflows/ci.yml#desktop |
| RUST-INIT-1 | practiced |
| RUST-LINT-1 | gated: .github/workflows/ci.yml#conventions |
| RUST-LINT-2 | gated: .github/workflows/ci.yml#desktop |
| RUST-LINT-3 | gated: .github/workflows/ci.yml#desktop |
| RUST-LINT-4 | convention: a review practice; adopting the table here fixed every finding |
| RUST-LINT-5 | convention: a review practice |
| RUST-MACRO-1 | practiced |
| RUST-ORG-1 | practiced |
| RUST-PANIC-1 | n/a: no catch_unwind |
| RUST-SQL-1 | n/a: no SQL |
| RUST-TC-1 | uncovered: no rust-version and no rust-toolchain file |
| RUST-TC-2 | n/a: one package; its edition is in its own manifest |
| RUST-TC-3 | gated: .github/workflows/ci.yml#desktop |
| RUST-TYPE-1 | gated: .github/workflows/ci.yml#desktop |
| RUST-UNSAFE-1 | partial: unsafe_code = deny is in the gated table and both crate roots declare #![forbid(unsafe_code)], but no tripwire pins the forbid |
| RUST-UNSAFE-2 | gated: .github/workflows/ci.yml#desktop |
| RUST-UNSAFE-3 | n/a: no FFI |
| SC-ADV-1 | uncovered: no cargo audit |
| SC-ADV-2 | uncovered: no cargo audit |
| SC-DENY-1 | uncovered: no cargo deny |
| SC-DENY-2 | uncovered: no cargo deny |
| SC-DENY-3 | uncovered: no cargo deny |
| SC-GHA-1 | uncovered: every uses: is a tag |
| SC-GHA-2 | practiced |
| SC-GHA-3 | n/a: no release workflow |
| SC-IN-1 | partial: gitleaks and actionlint are version- and checksum-pinned, ruff and bun version-pinned; uv (pip install) and tauri-driver (cargo install) are not |
| SC-IN-2 | partial: dependabot covers github-actions, cargo and bun, not the plugin's uv project |
| SC-IN-3 | partial: bun.lock is gated by bun install --frozen-lockfile; Cargo.lock and uv.lock are not checked |
| SC-SEC-1 | partial: gitleaks gates in the hygiene job; no CodeQL |
| SEC-RPT-1 | uncovered: no SECURITY.md |
| SEC-SQL-1 | n/a: no SQL |
| SEC-SQL-2 | n/a: no SQL |
| SH-1 | practiced |
| SH-2 | partial: every script but tools/setup-claude-web.sh sets -euo pipefail; nothing checks |
| SH-3 | gated: .github/workflows/ci.yml#hygiene |
| SH-4 | gated: .github/workflows/ci.yml#hygiene |
| TEST-1 | partial: every #[ignore] carries a reason; no tripwire pins the set |
| TEST-2 | convention: a review practice |
| TEST-3 | partial: the hand-run witnesses (#[ignore]) and the parked CSP witness do not run on pull requests |
| TEST-5 | uncovered: no coverage measured |
| TS-CFG-1 | gated: .github/workflows/ci.yml#conventions, .github/workflows/ci.yml#desktop |
| TS-CFG-2 | gated: .github/workflows/ci.yml#desktop |
| TS-DOC-1 | n/a: nothing is published |
| TS-ERR-1 | gated: .github/workflows/ci.yml#desktop |
| TS-GEN-1 | n/a: no committed generated TypeScript |
| TS-MOD-1 | gated: .github/workflows/ci.yml#desktop |
| TS-NAME-1 | uncovered |
| TS-SUP-1 | partial: Biome requires a reason on biome-ignore and refuses @ts-ignore; @ts-expect-error is not checked |
| TS-TOOL-1 | gated: .github/workflows/ci.yml#desktop |
| TS-TOOL-2 | partial: the canonical rules are errors; biome.json keeps noUnusedVariables at warn and the recommended set's warnings do not fail |
| TS-TOOL-3 | practiced |
| TS-TYPE-1 | gated: .github/workflows/ci.yml#desktop |
| TS-TYPE-2 | partial: noNonNullAssertion gates in the Biome step; type assertions are not checked |
| TW-5 | gated: .github/workflows/ci.yml#hygiene |

<!-- consumer-status:end -->
