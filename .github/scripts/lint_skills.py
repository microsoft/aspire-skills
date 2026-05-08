#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
Structural lint for aspire-skills.

Runs in the `lint` GitHub Actions workflow on every PR. No LLM calls, no waza,
no auth — safe to run on fork PRs.

Checks (all are blocking; exits non-zero on any failure):
  1. Every `skills/<skill>/` has SKILL.md with required frontmatter
     (name, description, license).
  2. Every skill has `evals/eval.yaml` and `evals/trigger_tests.yaml`.
  3. Task IDs are unique within a skill's `evals/tasks/`.
  4. No prompt appears in both `should_trigger_prompts` and
     `should_not_trigger_prompts` of the same trigger_tests.yaml
     (AUTHORING.md rule).
  5. SKILL.md frontmatter `name:` matches the directory name.

Usage:
  python .github/scripts/lint_skills.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"

REQUIRED_FRONTMATTER_KEYS = ("name", "description", "license")

errors: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def parse_frontmatter(skill_md: Path) -> dict | None:
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        fail(f"{skill_md.relative_to(REPO_ROOT)}: missing YAML frontmatter")
        return None
    end = text.find("\n---", 3)
    if end == -1:
        fail(f"{skill_md.relative_to(REPO_ROOT)}: unterminated frontmatter")
        return None
    try:
        return yaml.safe_load(text[3:end])
    except yaml.YAMLError as e:
        fail(f"{skill_md.relative_to(REPO_ROOT)}: invalid YAML frontmatter: {e}")
        return None


def lint_skill(skill_dir: Path) -> None:
    rel = skill_dir.relative_to(REPO_ROOT)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        fail(f"{rel}: SKILL.md not found")
        return

    fm = parse_frontmatter(skill_md)
    if fm is None:
        return

    for key in REQUIRED_FRONTMATTER_KEYS:
        if key not in fm or fm[key] in (None, ""):
            fail(f"{rel}/SKILL.md: frontmatter missing required key '{key}'")

    if fm.get("name") and fm["name"] != skill_dir.name:
        fail(
            f"{rel}/SKILL.md: frontmatter name='{fm['name']}' does not match "
            f"directory '{skill_dir.name}'"
        )

    eval_yaml = skill_dir / "evals" / "eval.yaml"
    trigger_yaml = skill_dir / "evals" / "trigger_tests.yaml"
    if not eval_yaml.is_file():
        fail(f"{rel}: missing evals/eval.yaml")
    if not trigger_yaml.is_file():
        fail(f"{rel}: missing evals/trigger_tests.yaml")

    tasks_dir = skill_dir / "evals" / "tasks"
    if tasks_dir.is_dir():
        ids: dict[str, str] = {}
        for task_file in sorted(tasks_dir.glob("*.yaml")):
            try:
                task = yaml.safe_load(task_file.read_text(encoding="utf-8"))
            except yaml.YAMLError as e:
                fail(f"{task_file.relative_to(REPO_ROOT)}: invalid YAML: {e}")
                continue
            if not isinstance(task, dict):
                fail(f"{task_file.relative_to(REPO_ROOT)}: top-level not a mapping")
                continue
            tid = task.get("id")
            if not tid:
                fail(f"{task_file.relative_to(REPO_ROOT)}: missing 'id'")
                continue
            if tid in ids:
                fail(
                    f"{task_file.relative_to(REPO_ROOT)}: duplicate task id "
                    f"'{tid}' (also in {ids[tid]})"
                )
            else:
                ids[tid] = str(task_file.relative_to(REPO_ROOT))

    if trigger_yaml.is_file():
        try:
            triggers = yaml.safe_load(trigger_yaml.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as e:
            fail(f"{trigger_yaml.relative_to(REPO_ROOT)}: invalid YAML: {e}")
            return
        should = {
            (p.get("prompt") or "").strip().lower()
            for p in (triggers.get("should_trigger_prompts") or [])
            if isinstance(p, dict)
        }
        should_not = {
            (p.get("prompt") or "").strip().lower()
            for p in (triggers.get("should_not_trigger_prompts") or [])
            if isinstance(p, dict)
        }
        overlap = (should & should_not) - {""}
        for prompt in sorted(overlap):
            fail(
                f"{trigger_yaml.relative_to(REPO_ROOT)}: prompt appears in both "
                f"should_trigger_prompts and should_not_trigger_prompts: "
                f"{prompt!r}"
            )


def main() -> int:
    if not SKILLS_DIR.is_dir():
        print(f"FATAL: {SKILLS_DIR} not found", file=sys.stderr)
        return 2

    skill_dirs = sorted(p for p in SKILLS_DIR.iterdir() if p.is_dir())
    if not skill_dirs:
        print(f"FATAL: no skills under {SKILLS_DIR}", file=sys.stderr)
        return 2

    print(f"Linting {len(skill_dirs)} skill(s) under {SKILLS_DIR.relative_to(REPO_ROOT)}/")
    for skill_dir in skill_dirs:
        print(f"  - {skill_dir.name}")
        lint_skill(skill_dir)

    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(f"\n❌ {len(errors)} lint error(s)", file=sys.stderr)
        return 1

    print(f"\n✅ {len(skill_dirs)} skill(s) passed structural lint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
