#!/usr/bin/env python3
"""Check and move a consuming repository's pin on the tasker-systems conventions baseline.

Doctrine: doctrine/consuming.md (CONS-*). Run from the consumer's *projected* copy, never from the
baseline's main, so that the verdict a consumer gets is the one its pin chose:

    python3 -I .conventions/baseline/tools/conventions.py check [--offline]
    python3 -I .conventions/baseline/tools/conventions.py bump --revision <sha|main> [--init --name N]

`check` runs five checks and exits non-zero if any fails:

  A  adopted config matches the projection, apart from recorded exceptions   (CONS-3, CONS-4)
  B  the projection matches the pinned commit, byte for byte                 (CONS-1, CONS-2)
  C  lag behind the baseline's main is reported; it never fails              (CONS-7)
  D  every `gated:` status names a gate that exists                          (CONS-5)
  E  the agent entry files link the projected skill, and the skill is current (CONS-6)

B and C fetch the baseline (it is public; no credential is used or needed). A fetch failure fails
B: the projection being hand-edited is exactly what B guards, so it never passes unchecked.
`--offline` runs A, D and E only, and says so.

NOT CHECKED, by design:
  - that a `gated:` gate actually fails on a violation (that is each consumer's bite test, TW-5);
  - that a consumer's own guidance does not restate or contradict the doctrine (judged in review);
  - formatting of adopted files: comparison is over parsed TOML/JSON, so comments and layout are
    the consumer's own.

Standard library only; Python 3.11+ (tomllib).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_BASELINE = "https://github.com/tasker-systems/conventions"
CONVENTIONS_DIR = ".conventions"
BASELINE_DIR = f"{CONVENTIONS_DIR}/baseline"

# What a consumer's projection holds. Kept here, in the projected tool, so that check B and the
# projection it checks always agree on the set: both come from the same pinned revision.
PROJECTED = (
    "README.md",
    "LICENSE",
    "doctrine",
    "rust",
    "python",
    "typescript",
    "skill",
    "tools/conventions.py",
    "tools/slots.toml",
)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
RULE_ROW_RE = re.compile(r"^\|\s*([A-Z]+(?:-[A-Z]+)*-[0-9]+)\s*\|(.*)$")
STATUS_WORDS = ("gated", "partial", "practiced", "convention", "uncovered", "unexamined", "n/a")
MODES = ("exact", "extends", "table", "superset")
SKILL_BEGIN = "<!-- consumer-status:begin -->"
SKILL_END = "<!-- consumer-status:end -->"


# --------------------------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------------------------


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)

    def fail(self, check: str, message: str) -> None:
        self.errors.append(f"{check}: {message}")

    def note(self, check: str, message: str) -> None:
        self.notices.append(f"{check}: {message}")

    def emit(self) -> int:
        in_actions = os.environ.get("GITHUB_ACTIONS") == "true"
        for line in self.notices:
            print(f"::notice::{line}" if in_actions else f"note  {line}")
        for line in self.errors:
            print(f"::error::{line}" if in_actions else f"FAIL  {line}", file=sys.stderr)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write("## Conventions baseline\n\n")
                for line in self.notices:
                    handle.write(f"- {line}\n")
                for line in self.errors:
                    handle.write(f"- **FAIL** {line}\n")
                if not self.errors:
                    handle.write("- all checks passed\n")
        if not self.errors:
            print("conventions: all checks passed")
        return 1 if self.errors else 0


class UsageError(Exception):
    """A malformed consumer: the checks cannot run, so this is a failure, not a skip."""


# --------------------------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------------------------


def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas outside strings (tsconfig, biome)."""
    out: list[str] = []
    i, n = 0, len(text)
    in_string = False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
        elif c == '"':
            in_string = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_structured(path: Path) -> dict[str, Any] | None:
    """Parse a TOML or JSON(C) file; None for any other format (compared as bytes)."""
    if path.suffix == ".toml":
        with path.open("rb") as handle:
            return tomllib.load(handle)
    if path.suffix == ".json":
        loaded = json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise UsageError(f"{path}: top level is not an object")
        return loaded
    return None


def flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    """Tables become dotted key paths; arrays and scalars are leaves."""
    if isinstance(value, dict) and value:
        flat: dict[str, Any] = {}
        for key, child in value.items():
            flat.update(flatten(child, f"{prefix}.{key}" if prefix else str(key)))
        return flat
    return {prefix: value}


def subtable(data: dict[str, Any], dotted: str) -> Any:
    node: Any = data
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def rule_rows(rules_md: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    for line in rules_md.read_text(encoding="utf-8").splitlines():
        match = RULE_ROW_RE.match(line)
        if match:
            rows[match.group(1)] = match.group(2).strip()
    return rows


# --------------------------------------------------------------------------------------------
# The consumer
# --------------------------------------------------------------------------------------------


@dataclass
class Adopted:
    canonical: str
    path: str
    mode: str
    table: str
    canonical_table: str
    key: str


@dataclass
class Consumer:
    root: Path
    name: str
    revision: str
    baseline: str
    adopted: list[Adopted]
    entries: list[str]
    skill: str

    @property
    def baseline_dir(self) -> Path:
        return self.root / BASELINE_DIR


def load_consumer(root: Path) -> Consumer:
    config_path = root / CONVENTIONS_DIR / "consumer.toml"
    if not config_path.is_file():
        raise UsageError(f"{config_path} not found; this repository has not adopted the baseline")
    with config_path.open("rb") as handle:
        config = tomllib.load(handle)

    name = config.get("name")
    revision = config.get("revision")
    if not isinstance(name, str) or not name:
        raise UsageError("consumer.toml: `name` is required")
    if not isinstance(revision, str) or not SHA_RE.match(revision):
        raise UsageError(
            "consumer.toml: `revision` must be a full 40-character commit SHA; a branch or tag "
            f"can move underneath the consumer (got {revision!r})"
        )

    adopted: list[Adopted] = []
    for index, entry in enumerate(config.get("adopted", [])):
        where = f"consumer.toml adopted[{index}]"
        mode = entry.get("mode")
        if mode not in MODES:
            raise UsageError(f"{where}: `mode` must be one of {', '.join(MODES)}")
        for required in ("canonical", "path"):
            if not isinstance(entry.get(required), str):
                raise UsageError(f"{where}: `{required}` is required")
        if mode == "table" and not isinstance(entry.get("table"), str):
            raise UsageError(f"{where}: `table` mode needs `table` (the consumer's table path)")
        adopted.append(
            Adopted(
                canonical=entry["canonical"],
                path=entry["path"],
                mode=mode,
                table=entry.get("table", ""),
                canonical_table=entry.get("canonical_table", ""),
                key=entry.get("key", ""),
            )
        )

    guidance = config.get("guidance", {})
    entries = guidance.get("entry", [])
    skill = guidance.get("skill", "")
    if not entries or not isinstance(skill, str) or not skill:
        raise UsageError("consumer.toml: [guidance] needs `entry` (files) and `skill` (a path)")

    return Consumer(
        root=root,
        name=name,
        revision=revision,
        baseline=config.get("baseline", DEFAULT_BASELINE),
        adopted=adopted,
        entries=list(entries),
        skill=skill,
    )


@dataclass
class LocalException:
    path: str
    key: str
    reason: str
    used: bool = False

    def covers(self, path: str, key: str) -> bool:
        return self.path == path and (key == self.key or key.startswith(self.key + "."))


def load_exceptions(consumer: Consumer, report: Report) -> list[LocalException]:
    path = consumer.root / CONVENTIONS_DIR / "exceptions.toml"
    if not path.is_file():
        return []
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    out: list[LocalException] = []
    for index, entry in enumerate(data.get("exception", [])):
        reason = entry.get("reason", "")
        if not isinstance(reason, str) or not reason.strip():
            report.fail("A", f"exceptions.toml exception[{index}] has no reason")
        if not isinstance(entry.get("path"), str) or not isinstance(entry.get("key"), str):
            report.fail("A", f"exceptions.toml exception[{index}] needs `path` and `key`")
            continue
        out.append(LocalException(entry["path"], entry["key"], str(reason)))
    return out


def load_statuses(consumer: Consumer) -> dict[str, str]:
    path = consumer.root / CONVENTIONS_DIR / "status.toml"
    if not path.is_file():
        return {}
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    rules = data.get("rules", {})
    return {str(k): str(v) for k, v in rules.items()}


# --------------------------------------------------------------------------------------------
# Check A — adopted config matches the projection, modulo exceptions
# --------------------------------------------------------------------------------------------


def local_slots(consumer: Consumer, canonical: str) -> list[str]:
    path = consumer.baseline_dir / "tools" / "slots.toml"
    if not path.is_file():
        return []
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    return list(data.get(canonical, {}).get("slots", []))


def differences(adopted: Adopted, consumer: Consumer) -> list[str]:
    canonical_path = consumer.baseline_dir / adopted.canonical
    local_path = consumer.root / adopted.path
    if not canonical_path.is_file():
        return [f"(canonical file {adopted.canonical} is not in the projection)"]
    if not local_path.is_file():
        return ["(file missing)"]

    canon = load_structured(canonical_path)
    local = load_structured(local_path)
    if canon is None or local is None:
        if adopted.mode != "exact":
            raise UsageError(f"{adopted.path}: `{adopted.mode}` mode needs a TOML or JSON file")
        same = canonical_path.read_bytes() == local_path.read_bytes()
        return [] if same else ["(content differs)"]

    if adopted.mode == "table":
        canon = subtable(canon, adopted.canonical_table) if adopted.canonical_table else canon
        local = subtable(local, adopted.table)
        if local is None:
            return [f"{adopted.table} (table missing)"]
        prefix = adopted.table
    else:
        prefix = ""

    if adopted.mode == "extends":
        key = adopted.key or ("extend" if adopted.path.endswith(".toml") else "extends")
        refs = local.get(key)
        refs = [refs] if isinstance(refs, str) else refs or []
        target = canonical_path.resolve()
        base = local_path.parent
        if not any((base / ref).resolve() == target for ref in refs if isinstance(ref, str)):
            return [f"{key} (does not reference {BASELINE_DIR}/{adopted.canonical})"]
        local = {k: v for k, v in local.items() if k != key}

    flat_canon = flatten(canon)
    flat_local = flatten(local)
    slots = local_slots(consumer, adopted.canonical) if adopted.mode == "superset" else []
    found: list[str] = []
    for key, value in flat_canon.items():
        if key not in flat_local:
            if adopted.mode != "extends":
                found.append(_join(prefix, key) + " (missing)")
        elif not _same(flat_local[key], value) and not _in_slot(key, slots):
            found.append(_join(prefix, key) + f" (canonical {value!r}, here {flat_local[key]!r})")
    if adopted.mode in ("exact", "table"):
        for key in flat_local.keys() - flat_canon.keys():
            found.append(_join(prefix, key) + " (not in canonical)")
    if adopted.mode == "superset":
        for key in flat_local.keys() - flat_canon.keys():
            if not _in_slot(key, slots):
                found.append(key + " (not in canonical, and not a declared local slot)")
    return sorted(found)


def _same(left: Any, right: Any) -> bool:
    """Equal values; arrays of scalars compare as sets of items, since neither a lint selection
    nor a license allow-list means anything by its order."""
    scalar = (str, int, float, bool)
    if (
        isinstance(left, list)
        and isinstance(right, list)
        and all(isinstance(item, scalar) for item in [*left, *right])
    ):
        return sorted(map(repr, left)) == sorted(map(repr, right))
    return left == right


def _join(prefix: str, key: str) -> str:
    return f"{prefix}.{key}" if prefix and key else prefix or key


def _in_slot(key: str, slots: list[str]) -> bool:
    return any(key == slot or key.startswith(slot + ".") for slot in slots)


def check_adopted(consumer: Consumer, report: Report) -> None:
    exceptions = load_exceptions(consumer, report)
    for adopted in consumer.adopted:
        for diff in differences(adopted, consumer):
            key = diff.split(" (", 1)[0]
            match = next((e for e in exceptions if e.covers(adopted.path, key)), None)
            if match:
                match.used = True
            else:
                report.fail("A", f"{adopted.path}: {diff} — not a recorded exception")
    for exception in exceptions:
        if not exception.used:
            report.fail(
                "A",
                f"exception {exception.path}:{exception.key} matches no difference; remove it "
                "(a dead exception reads as a known divergence that no longer exists)",
            )


# --------------------------------------------------------------------------------------------
# Checks B and C — the projection against the pinned commit; lag behind main
# --------------------------------------------------------------------------------------------


def git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=False)


class Fetched:
    """A temporary clone of the baseline's main. Only main is fetched, so a revision that resolves
    here is, by construction, a commit on main: a pin to a side branch cannot be found at all."""

    def __init__(self, url: str) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="conventions-")
        self.path = Path(self._dir.name)
        steps = (
            ["init", "-q"],
            ["fetch", "-q", "--no-tags", url, "+refs/heads/main:refs/remotes/baseline/main"],
        )
        for step in steps:
            result = git(step, self.path)
            if result.returncode != 0:
                self.close()
                message = result.stderr.decode(errors="replace").strip()
                raise OSError(f"git {step[0]} {url} failed: {message}")

    def resolve(self, revision: str) -> str | None:
        ref = "refs/remotes/baseline/main" if revision == "main" else f"{revision}^{{commit}}"
        result = git(["rev-parse", "--verify", "-q", ref], self.path)
        return result.stdout.decode().strip() or None if result.returncode == 0 else None

    def files(self, revision: str) -> dict[str, bytes]:
        listed = git(["ls-tree", "-r", "-z", "--name-only", revision, "--", *PROJECTED], self.path)
        out: dict[str, bytes] = {}
        for name in filter(None, listed.stdout.decode().split("\0")):
            out[name] = git(["show", f"{revision}:{name}"], self.path).stdout
        return out

    def lag(self, revision: str) -> tuple[int, int]:
        main = "refs/remotes/baseline/main"
        count = git(["rev-list", "--count", f"{revision}..{main}"], self.path).stdout.decode()
        stamps = git(["log", "-1", "--format=%ct", revision], self.path).stdout.decode()
        main_stamp = git(["log", "-1", "--format=%ct", main], self.path).stdout.decode()
        days = (int(main_stamp.strip()) - int(stamps.strip())) // 86400
        return int(count.strip() or 0), max(days, 0)

    def close(self) -> None:
        self._dir.cleanup()


def projected_on_disk(consumer: Consumer) -> dict[str, bytes]:
    base = consumer.baseline_dir
    out: dict[str, bytes] = {}
    if base.is_dir():
        for path in sorted(base.rglob("*")):
            if path.is_file():
                out[path.relative_to(base).as_posix()] = path.read_bytes()
    return out


def check_pin(consumer: Consumer, report: Report, url: str) -> None:
    try:
        fetched = Fetched(url)
    except OSError as error:
        report.fail("B", f"could not fetch the baseline to compare the projection: {error}")
        report.note("C", "lag unknown: the baseline could not be fetched")
        return
    try:
        if not fetched.resolve(consumer.revision):
            report.fail("B", f"revision {consumer.revision} is not a commit on the baseline's main")
            return
        expected = fetched.files(consumer.revision)
        actual = projected_on_disk(consumer)
        for name in sorted(expected.keys() - actual.keys()):
            report.fail("B", f"{BASELINE_DIR}/{name} is missing from the projection")
        for name in sorted(actual.keys() - expected.keys()):
            report.fail("B", f"{BASELINE_DIR}/{name} is not in the baseline at the pin")
        for name in sorted(expected.keys() & actual.keys()):
            if expected[name] != actual[name]:
                report.fail("B", f"{BASELINE_DIR}/{name} differs from the pinned commit")
        behind, days = fetched.lag(consumer.revision)
        if behind:
            report.note(
                "C", f"{consumer.name} is {behind} commit(s), {days} day(s) behind the baseline"
            )
        else:
            report.note("C", f"{consumer.name} is on the baseline's current main")
    finally:
        fetched.close()


# --------------------------------------------------------------------------------------------
# Check D — statuses name rules that exist, and `gated:` names a gate that exists
# --------------------------------------------------------------------------------------------


def gate_exists(root: Path, ref: str) -> bool:
    path_part, _, job = ref.partition("#")
    path = root / path_part.strip()
    if not path_part.strip() or not path.is_file():
        return False
    if not job:
        return True
    text = path.read_text(encoding="utf-8")
    jobs = re.search(r"^jobs:\s*$(.*)", text, re.MULTILINE | re.DOTALL)
    return bool(jobs and re.search(rf"^  {re.escape(job.strip())}:\s*$", jobs.group(1), re.M))


def check_statuses(consumer: Consumer, report: Report) -> None:
    rules_md = consumer.baseline_dir / "doctrine" / "rules.md"
    known = rule_rows(rules_md) if rules_md.is_file() else {}
    for rule_id, status in load_statuses(consumer).items():
        if known and rule_id not in known:
            report.fail("D", f"status.toml: {rule_id} is not a rule in the pinned baseline")
            continue
        word, _, rest = status.partition(":")
        word = word.strip()
        if word not in STATUS_WORDS:
            report.fail("D", f"status.toml: {rule_id} = {status!r} uses an unknown status word")
        elif word == "gated":
            refs = [r.strip() for r in rest.split(",") if r.strip()]
            if not refs:
                report.fail("D", f"status.toml: {rule_id} is `gated` but names no gate")
            for ref in refs:
                if not gate_exists(consumer.root, ref):
                    report.fail(
                        "D", f"status.toml: {rule_id} names gate {ref!r}, which does not exist"
                    )


# --------------------------------------------------------------------------------------------
# Check E — the projected skill is current and the entry guidance links it
# --------------------------------------------------------------------------------------------


def render_skill(
    baseline_dir: Path, consumer_name: str, statuses: dict[str, str]
) -> dict[str, bytes]:
    source = baseline_dir / "skill"
    out: dict[str, bytes] = {}
    if not source.is_dir():
        return out
    rows = ["| Rule | Status here |", "|---|---|"]
    rows += [f"| {rule} | {status} |" for rule, status in sorted(statuses.items())]
    table = "\n".join(rows) if statuses else "_No statuses recorded yet: every rule is unexamined._"
    block = f"{SKILL_BEGIN}\n\nStatuses for **{consumer_name}**:\n\n{table}\n\n{SKILL_END}"
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if path.name == "SKILL.md":
            text = data.decode("utf-8")
            pattern = re.compile(re.escape(SKILL_BEGIN) + ".*?" + re.escape(SKILL_END), re.DOTALL)
            text = pattern.sub(lambda _: block, text)
            data = text.encode("utf-8")
        out[path.relative_to(source).as_posix()] = data
    return out


def check_guidance(consumer: Consumer, report: Report) -> None:
    expected = render_skill(consumer.baseline_dir, consumer.name, load_statuses(consumer))
    skill_dir = consumer.root / consumer.skill
    actual: dict[str, bytes] = {}
    if skill_dir.is_dir():
        for path in sorted(skill_dir.rglob("*")):
            if path.is_file():
                actual[path.relative_to(skill_dir).as_posix()] = path.read_bytes()
    if not expected:
        report.fail("E", "the projection has no skill/ to project")
    elif actual != expected:
        report.fail(
            "E",
            f"{consumer.skill} is not the skill rendered from the projection and status.toml; "
            "re-run `conventions.py bump` (statuses changed, or the skill was hand-edited)",
        )
    for entry in consumer.entries:
        path = consumer.root / entry
        if not path.is_file():
            report.fail("E", f"guidance entry {entry} does not exist")
        elif consumer.skill.rstrip("/") not in path.read_text(encoding="utf-8"):
            report.fail("E", f"{entry} does not link the projected skill ({consumer.skill})")


# --------------------------------------------------------------------------------------------
# bump
# --------------------------------------------------------------------------------------------


def write_tree(target: Path, files: dict[str, bytes]) -> None:
    if target.exists():
        shutil.rmtree(target)
    for name, data in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def bump(root: Path, revision: str, url: str | None, init_name: str | None) -> int:
    config_path = root / CONVENTIONS_DIR / "consumer.toml"
    if init_name:
        if config_path.exists():
            print(f"{config_path} already exists; drop --init", file=sys.stderr)
            return 2
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(INIT_CONSUMER.format(name=init_name, sha="0" * 40), encoding="utf-8")
        (root / CONVENTIONS_DIR / "status.toml").write_text(INIT_STATUS, encoding="utf-8")
        (root / CONVENTIONS_DIR / "exceptions.toml").write_text(INIT_EXCEPTIONS, encoding="utf-8")
    try:
        consumer = load_consumer(root)
    except UsageError as error:
        print(f"conventions: {error}", file=sys.stderr)
        return 2
    url = url or consumer.baseline
    old_rules_md = consumer.baseline_dir / "doctrine" / "rules.md"
    old_rules = rule_rows(old_rules_md) if old_rules_md.is_file() else {}

    fetched = Fetched(url)
    try:
        sha = fetched.resolve(revision)
        if not sha:
            print(
                f"conventions: {revision} is not a commit on the baseline's main", file=sys.stderr
            )
            return 2
        write_tree(consumer.baseline_dir, fetched.files(sha))
    finally:
        fetched.close()

    text = config_path.read_text(encoding="utf-8")
    text = re.sub(r"^revision\s*=.*$", f'revision = "{sha}"', text, count=1, flags=re.MULTILINE)
    config_path.write_text(text, encoding="utf-8")
    consumer = load_consumer(root)
    write_tree(
        root / consumer.skill,
        render_skill(consumer.baseline_dir, consumer.name, load_statuses(consumer)),
    )

    new_rules = rule_rows(consumer.baseline_dir / "doctrine" / "rules.md")
    print(f"pinned {consumer.name} to {sha}")
    if not old_rules:
        print(
            f"  first projection: {len(new_rules)} rules. Each is unexamined here until you record"
            " its status in .conventions/status.toml"
        )
        return 0
    for label, ids in (
        ("added", sorted(new_rules.keys() - old_rules.keys())),
        ("removed", sorted(old_rules.keys() - new_rules.keys())),
        (
            "changed",
            sorted(k for k in new_rules.keys() & old_rules.keys() if new_rules[k] != old_rules[k]),
        ),
    ):
        for rule in ids:
            print(f"  rule {label}: {rule}")
    print("record each changed rule's status in .conventions/status.toml, in this commit")
    return 0


INIT_CONSUMER = """\
# This repository's pin on the tasker-systems conventions baseline. Doctrine: CONS-* in
# .conventions/baseline/doctrine/consuming.md. `revision` is written by `conventions.py bump`.
name = "{name}"
revision = "{sha}"

# Each adopted canonical file: where it lives here, and how it is compared (exact, extends,
# table, superset). Example:
# [[adopted]]
# canonical = "python/ruff.toml"
# path = "ruff.toml"
# mode = "extends"

[guidance]
# Agent entry files that must link the projected skill, and where the skill is projected.
entry = ["AGENTS.md"]
skill = ".claude/skills/tasker-systems-conventions"
"""

INIT_STATUS = """\
# This repository's status for each baseline rule, in the register's vocabulary:
# gated: <path>[#job], partial: …, practiced, convention: …, uncovered, unexamined, n/a.
[rules]
"""

INIT_EXCEPTIONS = """\
# Every local departure from the pinned baseline, one entry each, with its reason.
# [[exception]]
# path = "ruff.toml"
# key = "target-version"
# reason = "the plugin's declared floor is py39"
"""


# --------------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="conventions.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="run checks A-E against the consumer at --root")
    check.add_argument("--root", type=Path, default=Path.cwd())
    check.add_argument("--offline", action="store_true", help="run A, D and E only, and say so")
    check.add_argument("--baseline-repo", help="override the baseline URL (tests)")
    move = sub.add_parser("bump", help="move the pin and rewrite the projection and skill")
    move.add_argument("--root", type=Path, default=Path.cwd())
    move.add_argument(
        "--revision", required=True, help="a commit SHA on the baseline's main, or `main`"
    )
    move.add_argument("--baseline-repo", help="override the baseline URL (tests)")
    move.add_argument("--init", metavar="NAME", help="create .conventions/ for consumer NAME first")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    if args.command == "bump":
        return bump(root, args.revision, args.baseline_repo, args.init)

    report = Report()
    try:
        consumer = load_consumer(root)
        check_adopted(consumer, report)
        if args.offline:
            report.note("B", "not run (--offline): the projection was not compared with the pin")
            report.note("C", "not run (--offline): lag is unknown")
        else:
            check_pin(consumer, report, args.baseline_repo or consumer.baseline)
        check_statuses(consumer, report)
        check_guidance(consumer, report)
    except UsageError as error:
        report.fail("config", str(error))
    return report.emit()


if __name__ == "__main__":
    sys.exit(main())
