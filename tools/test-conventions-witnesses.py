#!/usr/bin/env python3
"""Witnesses for the conventions baseline as this repository adopts it.

`conventions.py check` (the projected checker, run in the `conventions` CI job) is what refuses a
divergence from the pinned baseline. This harness is its bite test here: each case seeds one
violation into a copy of this repository's tracked tree, runs the projected checker against the
copy, and requires a red verdict whose message names what was seeded. A green verdict, or a red
one for some other reason, fails the harness.

The unseeded copy runs first, through the real (online) check in an emptied environment: no token,
no credential helper, no git configuration. It must be green. That is the control: it proves each
red below comes from its seed, and it is the witness that the check needs nothing an outsider (a
fork's pull request) lacks.

    python3 -I tools/test-conventions-witnesses.py        # exit 1 and name each failed case

Cases, by what they guard:
  - the pin: a branch for `revision`; a projected file edited, added or removed     (check B)
  - adopted config: a canonical key overridden in each adopted file; `extends` gone   (check A)
  - exceptions: one without a reason; one matching nothing; one that covers a
    divergence (green: the reasoned path works)                                       (check A)
  - lag: pinned one commit behind the baseline's main, the run names the lag          (check C)
  - guidance: the projected skill hand-edited; a status changed without re-rendering;
    AGENTS.md no longer linking the skill                                             (check E)
  - statuses: a `gated:` status naming a job that does not exist                      (check D)

NOT CHECKED:
  - that a named gate fails on a violation of its rule: each gate owes its own bite test;
  - a real fork pull request: the emptied environment stands in for one, and the conventions job's
    text is read for any `secrets.` reference;
  - that this repository's own guidance does not restate or contradict the doctrine (review).

Every case's seed must find what it edits: a seed whose target moved fails the harness rather than
passing vacuously. Standard library only.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / ".conventions" / "baseline" / "tools" / "conventions.py"
SKILL = ".claude/skills/tasker-systems-conventions"

# What survives into the emptied environment: where programs are, and (when a network proxy is in
# use) how to reach the network. No token, no credential, no git configuration.
PASSED_THROUGH = ("PATH", "HTTPS_PROXY", "https_proxy", "SSL_CERT_FILE", "GIT_SSL_CAINFO")


class SeedMissed(Exception):
    """A seed did not find what it edits: the case would pass without testing anything."""


def edit(copy: Path, rel: str, old: str, new: str) -> None:
    path = copy / rel
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SeedMissed(f"{rel}: expected exactly one {old!r}, found {text.count(old)}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def append(copy: Path, rel: str, text: str) -> None:
    path = copy / rel
    if not path.is_file():
        raise SeedMissed(f"{rel} does not exist")
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def tracked_copy(dest: Path) -> None:
    listed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode()
    names = [n for n in listed.split("\0") if n]
    if not names:
        raise SeedMissed("git ls-files listed nothing to copy")
    for name in names:
        source = ROOT / name
        if source.is_file():
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def emptied_env(home: Path) -> dict[str, str]:
    env = {k: os.environ[k] for k in PASSED_THROUGH if k in os.environ}
    env.update(
        HOME=str(home),
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_TERMINAL_PROMPT="0",
    )
    return env


def check(copy: Path, *, offline: bool, env: dict[str, str]) -> tuple[int, str]:
    args = [sys.executable, "-I", str(TOOL), "check", "--root", str(copy)]
    if offline:
        args.append("--offline")
    result = subprocess.run(args, capture_output=True, text=True, env=env, check=False)
    return result.returncode, result.stdout + result.stderr


def consumer_key(copy: Path, key: str) -> str | None:
    """A top-level string key of consumer.toml. Read by pattern rather than tomllib, which this
    repository's Python floor (3.10) does not have."""
    text = (copy / ".conventions" / "consumer.toml").read_text(encoding="utf-8")
    match = re.search(rf'^{key}\s*=\s*"([^"]*)"', text, re.MULTILINE)
    return match.group(1) if match else None


def pinned_revision(copy: Path) -> str:
    revision = consumer_key(copy, "revision")
    if revision is None:
        raise SeedMissed("consumer.toml names no revision")
    return revision


def baseline_url(copy: Path) -> str:
    return consumer_key(copy, "baseline") or "https://github.com/tasker-systems/conventions"


def parent_on_main(copy: Path, env: dict[str, str], scratch: Path) -> str:
    """The pin's first parent: a commit on the baseline's main, one behind the pin."""
    clone = scratch / "baseline-git"
    clone.mkdir()
    steps = (
        ["git", "init", "-q"],
        [
            "git",
            "fetch",
            "-q",
            "--no-tags",
            baseline_url(copy),
            "+refs/heads/main:refs/remotes/baseline/main",
        ],
    )
    for step in steps:
        subprocess.run(step, cwd=clone, env=env, check=True, capture_output=True)
    parent = subprocess.run(
        ["git", "rev-parse", f"{pinned_revision(copy)}^1"],
        cwd=clone,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", parent):
        raise SeedMissed(f"the pin has no parent on the baseline's main (got {parent!r})")
    return parent


def pin_behind(copy: Path, env: dict[str, str], scratch: Path) -> None:
    parent = parent_on_main(copy, env, scratch)
    subprocess.run(
        [sys.executable, "-I", str(TOOL), "bump", "--root", str(copy), "--revision", parent],
        env=env,
        check=True,
        capture_output=True,
    )
    if pinned_revision(copy) != parent:
        raise SeedMissed("bump did not move the pin")


def add_exception(copy: Path, key: str, reason: str | None) -> None:
    entry = f'\n[[exception]]\npath = "ruff.toml"\nkey = "{key}"\n'
    if reason is not None:
        entry += f'reason = "{reason}"\n'
    append(copy, ".conventions/exceptions.toml", entry)


Seed = Callable[[Path], None]

# (case, seed, offline, expected): `expected` is the text the red verdict must contain, or None
# for a case that must stay green.
CASES: list[tuple[str, Seed, bool, str | None]] = [
    # --- the pin (check B, and the config check before it) ---
    (
        "the pin names a branch, not a commit",
        lambda c: edit(
            c,
            ".conventions/consumer.toml",
            f'revision = "{pinned_revision(c)}"',
            'revision = "main"',
        ),
        True,
        "`revision` must be a full 40-character commit SHA",
    ),
    (
        "a projected doctrine file is edited",
        lambda c: append(c, ".conventions/baseline/doctrine/tenets.md", "\nA local amendment.\n"),
        False,
        "B: .conventions/baseline/doctrine/tenets.md differs from the pinned commit",
    ),
    (
        "a file is added to the projection",
        lambda c: (c / ".conventions/baseline/doctrine/local.md").write_text("# Local\n"),
        False,
        "B: .conventions/baseline/doctrine/local.md is not in the baseline at the pin",
    ),
    (
        "a file is removed from the projection",
        lambda c: (c / ".conventions/baseline/rust/deny.toml").unlink(),
        False,
        "B: .conventions/baseline/rust/deny.toml is missing from the projection",
    ),
    # --- adopted config (check A) ---
    (
        "ruff.toml overrides a canonical key",
        lambda c: append(c, "ruff.toml", "line-length = 120\n"),
        True,
        "A: ruff.toml: line-length (canonical 100, here 120)",
    ),
    (
        "ruff.toml stops extending the projection",
        lambda c: edit(c, "ruff.toml", 'extend = ".conventions/baseline/python/ruff.toml"\n', ""),
        True,
        "A: ruff.toml: extend (does not reference",
    ),
    (
        "biome.json loosens a canonical rule",
        lambda c: edit(
            c,
            "apps/desktop/biome.json",
            '"style": {\n\t\t\t\t"useConst": "error"\n\t\t\t}',
            '"style": {\n\t\t\t\t"useConst": "error"\n\t\t\t},\n'
            '\t\t\t"suspicious": {\n\t\t\t\t"noExplicitAny": "warn"\n\t\t\t}',
        ),
        True,
        "A: apps/desktop/biome.json: linter.rules.suspicious.noExplicitAny",
    ),
    (
        "tsconfig.json turns a canonical flag off",
        lambda c: edit(
            c,
            "apps/desktop/tsconfig.json",
            '"compilerOptions": {',
            '"compilerOptions": {\n\t\t"noUncheckedIndexedAccess": false,',
        ),
        True,
        "A: apps/desktop/tsconfig.json: compilerOptions.noUncheckedIndexedAccess",
    ),
    (
        "tsconfig.json stops extending the projection",
        lambda c: edit(
            c,
            "apps/desktop/tsconfig.json",
            ', "../../.conventions/baseline/typescript/tsconfig.base.json"',
            "",
        ),
        True,
        "A: apps/desktop/tsconfig.json: extends (does not reference",
    ),
    (
        "the crate's [lints] relaxes a canonical lint",
        lambda c: edit(
            c, "apps/desktop/src-tauri/Cargo.toml", 'dbg_macro = "warn"', 'dbg_macro = "allow"'
        ),
        True,
        "A: apps/desktop/src-tauri/Cargo.toml: lints.clippy.dbg_macro",
    ),
    (
        "the crate's [lints] adds a lint the baseline does not hold",
        lambda c: edit(
            c,
            "apps/desktop/src-tauri/Cargo.toml",
            'dbg_macro = "warn"',
            'dbg_macro = "warn"\ntodo = "allow"',
        ),
        True,
        "A: apps/desktop/src-tauri/Cargo.toml: lints.clippy.todo (not in canonical)",
    ),
    # --- exceptions (check A) ---
    (
        "an exception covers the divergence it records",
        lambda c: (
            append(c, "ruff.toml", "line-length = 120\n"),
            add_exception(c, "line-length", "a seeded, reasoned divergence"),
        ),
        True,
        None,
    ),
    (
        "an exception carries no reason",
        lambda c: (
            append(c, "ruff.toml", "line-length = 120\n"),
            add_exception(c, "line-length", None),
        ),
        True,
        "has no reason",
    ),
    (
        "an exception matches no difference",
        lambda c: add_exception(c, "line-length", "a divergence that does not exist"),
        True,
        "exception ruff.toml:line-length matches no difference",
    ),
    # --- guidance (check E) ---
    (
        "the projected skill is hand-edited",
        lambda c: append(c, f"{SKILL}/SKILL.md", "\nA local rule.\n"),
        True,
        f"E: {SKILL} is not the skill rendered from the projection and status.toml",
    ),
    (
        "a status changes without the skill being re-rendered",
        lambda c: edit(c, ".conventions/status.toml", 'TEST-5 = "uncovered', 'TEST-5 = "practiced'),
        True,
        f"E: {SKILL} is not the skill rendered from the projection and status.toml",
    ),
    (
        "AGENTS.md stops linking the skill",
        lambda c: edit(
            c,
            "AGENTS.md",
            f"[`{SKILL}`]({SKILL}/SKILL.md)",
            "the conventions skill",
        ),
        True,
        "E: AGENTS.md does not link the projected skill",
    ),
    # --- statuses (check D) ---
    (
        "a gated status names a job that does not exist",
        lambda c: edit(
            c,
            ".conventions/status.toml",
            'TEST-5 = "uncovered: no coverage measured"',
            'TEST-5 = "gated: .github/workflows/ci.yml#coverage"',
        ),
        True,
        "D: status.toml: TEST-5 names gate '.github/workflows/ci.yml#coverage', which does not exist",
    ),
]


def privileged_lines_in_conventions_job() -> list[int]:
    """Line numbers (in ci.yml) of the conventions job that reach for a repository secret or token.
    Numbers, not text: the harness never echoes what such a line holds."""
    lines = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index("  conventions:")
    except ValueError as error:
        raise SeedMissed(".github/workflows/ci.yml has no `conventions` job") from error
    found: list[int] = []
    for number, line in enumerate(lines[start + 1 :], start=start + 2):
        if line and not line.startswith("    "):
            break
        if re.search(r"secrets\.|TOKEN", line):
            found.append(number)
    return found


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="conventions-witness-") as tmp:
        scratch = Path(tmp)
        home = scratch / "home"
        home.mkdir()
        env = emptied_env(home)
        pristine = scratch / "pristine"
        tracked_copy(pristine)

        def fresh(name: str) -> Path:
            copy = scratch / name
            shutil.copytree(pristine, copy)
            return copy

        # The control, and the outsider's run: the real check, online, with nothing private.
        code, out = check(fresh("control"), offline=False, env=env)
        if code != 0:
            failures.append("the unseeded tree is not green in an emptied environment")
            print(out)
        elif "C: temper-contrib is" not in out:
            failures.append("the unseeded run names no lag line")
            print(out)
        else:
            print("  PASS: the unseeded tree is green, online, with no credential")
        privileged = privileged_lines_in_conventions_job()
        if privileged:
            lines = ", ".join(map(str, privileged))
            failures.append(f"the conventions job reaches for a secret (ci.yml line {lines})")
        else:
            print("  PASS: the conventions job references no secret")

        for index, (case, seed, offline, expected) in enumerate(CASES):
            copy = fresh(f"case-{index}")
            try:
                seed(copy)
            except (SeedMissed, OSError) as error:
                failures.append(f"{case}: the seed did not apply ({error})")
                continue
            code, out = check(copy, offline=offline, env=env)
            if expected is None:
                ok = code == 0
                verdict = "stays green" if ok else "was refused"
            else:
                ok = code != 0 and expected in out
                verdict = (
                    "is refused"
                    if ok
                    else "was accepted"
                    if code == 0
                    else f"was refused without naming {expected!r}"
                )
            print(f"  {'PASS' if ok else 'FAIL'}: {case} {verdict}")
            if not ok:
                failures.append(f"{case} {verdict}")
                print("\n".join("      " + line for line in out.splitlines()))

        copy = fresh("lag")
        try:
            pin_behind(copy, env, scratch)
            _, out = check(copy, offline=False, env=env)
            if re.search(r"C: temper-contrib is [1-9][0-9]* commit\(s\)", out):
                print("  PASS: a pin behind the baseline's main is named as lag")
            else:
                failures.append("a pin behind the baseline's main produced no lag line")
                print(out)
        except (SeedMissed, subprocess.CalledProcessError) as error:
            failures.append(f"the lag seed did not apply ({error})")

    if failures:
        for failure in failures:
            print(f"FAIL  {failure}", file=sys.stderr)
        return 1
    print(f"conventions witnesses: {len(CASES) + 3} cases held")
    return 0


if __name__ == "__main__":
    sys.exit(main())
