#!/usr/bin/env python3
"""Produce Cynthia's fail-closed end-to-end use-case receipt."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cynthia_phase_evidence as phase_evidence
import cynthia_setup


REQUIRED_CASES = (
    "new_project_setup", "coding", "research", "writing_approval", "stale_refresh_abstention",
    "recall_easy_medium_hard_xling", "public_bulk_and_personal_block", "verified_handoff",
    "obsidian_migration", "lifecycle_add_change_move_delete_failed_refresh", "phase_0",
)


def _case(status: str, evidence: str, reason: str | None = None) -> dict[str, str]:
    result = {"status": status, "evidence": evidence}
    if reason and status != "PASS":
        result["reason"] = reason
    return result


def _phase(path: str | None) -> dict[str, str]:
    if not path:
        return _case("BLOCKED", "no phase receipt", "opus-5 acceptance receipt is required")
    try:
        receipt = json.loads(Path(path).read_text(encoding="utf-8"))
        phase_evidence.validate(receipt)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return _case("BLOCKED", "invalid phase receipt", str(error))
    return _case(receipt["verdict"], "validated phase receipt")


def run(manifest: str, *, phase_receipt: str | None = None) -> dict[str, Any]:
    setup = cynthia_setup.setup(manifest)
    writing_setup = cynthia_setup.setup(manifest, workload="writing")
    suites = {item["suite"]: item["status"] for item in setup.get("steps", {}).get("tests", [])}
    route = setup.get("steps", {}).get("route", {})
    recall = setup.get("steps", {}).get("recall", {})
    local = lambda suite: suites.get(suite) == "PASS"
    cases = {
        "new_project_setup": _case("PASS" if setup.get("steps", {}).get("project", {}).get("status") == "PASS" else "BLOCKED", "manifest project preflight"),
        "coding": _case("PASS" if route.get("provider") == "codex" else "BLOCKED", "native route selection"),
        "research": _case("PASS" if route.get("provider") == "codex" else "BLOCKED", "native route selection"),
        "writing_approval": _case("PASS" if writing_setup.get("steps", {}).get("route", {}).get("status") == "native_only" else "BLOCKED", "explicit writing route selection"),
        "stale_refresh_abstention": _case("PASS" if local("lifecycle") else "BLOCKED", "synthetic stale/failed-refresh suite"),
        "recall_easy_medium_hard_xling": _case("PASS" if recall.get("status") == "PASS" else "BLOCKED", "frozen held-out report", recall.get("reason")),
        "public_bulk_and_personal_block": _case("PASS" if local("cynthia") and route.get("provider") == "codex" else "BLOCKED", "native-only public bulk and personal-data boundary"),
        "verified_handoff": _case("PASS" if local("cynthia") else "BLOCKED", "source-proof handoff unit tests"),
        "obsidian_migration": _case("PASS" if local("migration") else "BLOCKED", "synthetic non-destructive migration suite"),
        "lifecycle_add_change_move_delete_failed_refresh": _case("PASS" if local("lifecycle") else "BLOCKED", "synthetic lifecycle suite"),
        "phase_0": _phase(phase_receipt),
    }
    assert set(cases) == set(REQUIRED_CASES)
    return {"status": "PASS" if all(item["status"] == "PASS" for item in cases.values()) and setup["status"] == "PASS" else "BLOCKED", "setup": setup, "use_cases": cases}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Cynthia's end-to-end receipt")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase-receipt")
    args = parser.parse_args(argv)
    try:
        receipt = run(args.manifest, phase_receipt=args.phase_receipt)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        receipt = {"status": "BLOCKED", "issue": str(error)}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
