#!/usr/bin/env python3
"""Cynthia's deterministic, local-only setup preflight.

This command composes manifest validation, Wardrobe sector resolution, and
the local synthetic safety suites into one machine-readable receipt. It
deliberately does not run a NewBrain refresh or contact any provider: those
operations need their separate freshness and route gates.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

import cynthia_coordinator as coordinator
import cynthia_recall as recall
import cynthia_router as router


ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
WARDROBE = Path.home() / "Claude/sectors/adapters/wear-codex.sh"
VALID_SECTOR = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
NEWBRAIN = Path.home() / "Claude/NewBrain"


def _validation_commands() -> list[tuple[str, list[str], Path]]:
    return [
        ("cynthia", [sys.executable, "-m", "unittest", "discover", "-s", "cynthia/tests", "-p", "test_*.py"], PROJECT),
        ("lifecycle", ["bash", str(NEWBRAIN / "research/cynthia-lifecycle-tests/test_lifecycle.sh")], PROJECT),
        ("inventory", [sys.executable, str(NEWBRAIN / "research/cynthia-inventory-tests/test_inventory.py"), "-v"], PROJECT),
        ("relationships", [sys.executable, str(NEWBRAIN / "research/cynthia-relationship-tests/test_relationships.py"), "-v"], PROJECT),
        ("migration", [sys.executable, str(NEWBRAIN / "research/cynthia-migration-tests/test_migration.py"), "-v"], PROJECT),
    ]


def _run(command: list[str], *, cwd: Path) -> dict[str, Any]:
    completed = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    return {
        "command": command,
        "exit_code": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
        "status": "PASS" if completed.returncode == 0 else "BLOCKED",
    }


def _sectors(manifest: dict[str, Any]) -> list[str]:
    names = [item if isinstance(item, str) else item["name"] for item in manifest["sectors"]]
    invalid = [name for name in names if not VALID_SECTOR.fullmatch(name)]
    if invalid:
        raise ValueError("invalid sector name: " + ", ".join(invalid))
    return names


def _route(manifest: dict[str, Any], workload: str) -> dict[str, Any]:
    approvals = manifest["approvals"]
    task = router.Task(
        task_id=f"setup:{manifest['project_id']}", workload=workload,
        data_class=manifest["data_class"], required_context=(),
        approved=isinstance(approvals, dict) and approvals.get("writing") == "approved",
    )
    return router.as_metadata(router.choose(task))


def _recall(manifest: dict[str, Any], project_root: Path) -> dict[str, Any]:
    declaration = manifest["recall_fixture"]
    if not isinstance(declaration, dict) or not declaration.get("results_path"):
        return {"status": "NOT_RUN", "reason": "recall_results_not_declared"}
    command = declaration.get("command")
    if command is not None:
        generated = _run(command, cwd=project_root)
        if generated["status"] != "PASS":
            return {"status": "BLOCKED", "reason": "recall_generation_failed", "generation": generated}
    fixture = coordinator._resolve(declaration["path"], project_root)
    results = coordinator._resolve(declaration["results_path"], project_root)
    if not fixture.is_file() or not results.is_file():
        return {"status": "BLOCKED", "reason": "recall_fixture_or_results_missing"}
    try:
        return recall.evaluate(json.loads(fixture.read_text(encoding="utf-8")), json.loads(results.read_text(encoding="utf-8")))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return {"status": "BLOCKED", "reason": f"recall_error:{error}"}


def _refresh_approved(manifest: dict[str, Any]) -> bool:
    approvals = manifest["approvals"]
    return isinstance(approvals, dict) and approvals.get("newbrain_refresh") in {True, "approved"}


def setup(manifest_path: str | Path, *, workload: str = "coding", refresh: bool = False) -> dict[str, Any]:
    """Produce a receipt, refreshing only when the caller and manifest both approve it."""
    receipt: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "operation": "cynthia_setup_preflight",
        "external_requests": False,
        "refresh_executed": False,
        "steps": {},
        "status": "BLOCKED",
    }
    manifest, resolved_manifest = coordinator.load_manifest(manifest_path)
    preflight = coordinator.inspect_manifest(resolved_manifest)
    receipt["steps"]["manifest"] = preflight
    receipt["steps"]["project"] = {"project_id": manifest["project_id"], "project_root": preflight.get("project_root"), "status": preflight["states"]["loaded"], "approvals": manifest["approvals"]}
    receipt["steps"]["route"] = _route(manifest, workload)
    if refresh:
        if manifest["newbrain"] is None:
            receipt["steps"]["refresh"] = {"status": "NOT_REQUIRED"}
        elif not _refresh_approved(manifest):
            receipt["steps"]["refresh"] = {"status": "BLOCKED", "reason": "manifest_newbrain_refresh_approval_required"}
            return receipt
        elif preflight["status"] != "PASS" and not all(issue.startswith("newbrain:stale_source") for issue in preflight.get("issues", ())):
            receipt["steps"]["refresh"] = {"status": "BLOCKED", "reason": "preflight_has_non_refreshable_failure"}
            return receipt
        else:
            refresh_result = _run(manifest["refresh_command"], cwd=Path(preflight["project_root"]))
            receipt["steps"]["refresh"] = refresh_result
            receipt["refresh_executed"] = True
            if refresh_result["status"] != "PASS":
                return receipt
            preflight = coordinator.inspect_manifest(resolved_manifest)
            receipt["steps"]["manifest"] = preflight
            receipt["steps"]["project"] = {"project_id": manifest["project_id"], "project_root": preflight.get("project_root"), "status": preflight["states"]["loaded"], "approvals": manifest["approvals"]}
    if preflight["status"] != "PASS":
        return receipt

    equipment = []
    for sector in _sectors(manifest):
        if not WARDROBE.is_file():
            equipment.append({"sector": sector, "status": "BLOCKED", "reason": "wardrobe_resolver_missing"})
            continue
        result = _run(["bash", str(WARDROBE), sector], cwd=PROJECT)
        result["sector"] = sector
        equipment.append(result)
    receipt["steps"]["wardrobe"] = equipment

    validations = []
    for name, command, cwd in _validation_commands():
        result = dict(_run(command, cwd=cwd))
        result["suite"] = name
        validations.append(result)
    receipt["steps"]["tests"] = validations
    recall_report = _recall(manifest, Path(preflight["project_root"]))
    receipt["steps"]["recall"] = recall_report
    preflight["states"]["tested"] = "PASS" if recall_report["status"] == "PASS" else recall_report["status"]
    preflight["states"]["ready"] = "PASS" if all(
        value in {"PASS", "NOT_REQUIRED"} for value in preflight["states"].values()
    ) else "BLOCKED"
    equipment_ok = all(item["status"] == "PASS" for item in equipment)
    tests_ok = all(item["status"] == "PASS" for item in validations)
    receipt["status"] = "PASS" if (
        equipment_ok
        and tests_ok
        and recall_report["status"] == "PASS"
        and preflight["states"]["ready"] == "PASS"
    ) else "BLOCKED"
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Cynthia's local-only setup preflight")
    parser.add_argument("--manifest", required=True, help="universal project manifest")
    parser.add_argument("--workload", choices=("coding", "research", "writing", "bulk"), default="coding")
    parser.add_argument("--refresh", action="store_true", help="run the manifest refresh argv only when it is explicitly approved")
    parser.add_argument("--receipt", help="optional local path for the JSON receipt")
    args = parser.parse_args(argv)
    try:
        receipt = setup(args.manifest, workload=args.workload, refresh=args.refresh)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        receipt = {"schema_version": 1, "operation": "cynthia_setup_preflight", "status": "BLOCKED", "issues": [f"setup_error:{error}"], "external_requests": False, "refresh_executed": False}
    rendered = json.dumps(receipt, sort_keys=True)
    if args.receipt:
        destination = Path(args.receipt).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if receipt["status"] == "PASS" else coordinator.BLOCKED_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
