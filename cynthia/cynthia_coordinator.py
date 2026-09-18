#!/usr/bin/env python3
"""Cynthia project-context coordinator.

This is a local, deterministic preflight.  It reads file bytes only to compute
SHA-256 digests, plus names and timestamps.  It never returns or transmits
context bodies and never sends anything to a model or provider.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Iterable, Mapping


SCHEMA_VERSION = 1
BLOCKED_EXIT = 2


@dataclass(frozen=True)
class ContextSource:
    """A source claim that can be proven without exposing its contents."""

    name: str
    path: str
    sha256: str
    mtime_ns: int
    max_age_seconds: int | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve(path_value: str, base: Path) -> Path:
    expanded = Path(path_value).expanduser()
    return (expanded if expanded.is_absolute() else base / expanded).resolve()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _entry_age(entry: Mapping[str, Any], default: int | None = None) -> int | None:
    value = entry.get("max_age_seconds", default)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("max_age_seconds must be a non-negative integer")
    return value


def _nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    if "\x00" in value:
        raise ValueError(f"{field} contains an invalid NUL character")
    return value


def _command(value: Any, field: str, *, allow_none: bool = False) -> list[str] | None:
    if value is None and allow_none:
        return None
    if isinstance(value, list) and value and all(isinstance(item, str) and item.strip() for item in value):
        return value
    raise ValueError(f"{field} must be a non-empty argv list")


def _source_entry(value: Any, field: str) -> dict[str, Any]:
    if isinstance(value, str) and value.strip():
        return {"name": value, "path": value, "required": True}
    if not isinstance(value, dict):
        raise ValueError(f"{field} entries must be objects or non-empty path strings")
    _nonempty_string(value.get("name"), f"{field}.name")
    _nonempty_string(value.get("path"), f"{field}.path")
    if "required" in value and not isinstance(value["required"], bool):
        raise ValueError(f"{field}.required must be a boolean")
    if "sha256" in value:
        digest = value["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdefABCDEF" for char in digest):
            raise ValueError(f"{field}.sha256 must be a SHA-256 hex digest")
    _entry_age(value)
    return value


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    """Validate the universal project-context contract before touching sources."""
    required_fields = (
        "schema_version", "project_id", "project_root", "context", "required_files",
        "sectors", "newbrain", "refresh_command", "setup_commands", "recall_fixture",
        "allowed_routes", "data_class", "approvals", "receipt_fields",
    )
    missing = [field for field in required_fields if field not in manifest]
    if missing:
        raise ValueError("missing manifest fields: " + ", ".join(missing))
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported schema_version: {manifest.get('schema_version')!r}")
    _nonempty_string(manifest.get("project_id"), "project_id")
    _nonempty_string(manifest.get("project_root"), "project_root")

    context = manifest["context"]
    if not isinstance(context, list) or not context:
        raise ValueError("context must be a non-empty list")
    for index, entry in enumerate(context):
        if not isinstance(entry, dict):
            raise ValueError(f"context[{index}] must be an object")
        _source_entry(entry, f"context[{index}]")

    required_files = manifest["required_files"]
    if not isinstance(required_files, list):
        raise ValueError("required_files must be a list")
    for index, entry in enumerate(required_files):
        _source_entry(entry, f"required_files[{index}]")

    sectors = manifest["sectors"]
    if not isinstance(sectors, list):
        raise ValueError("sectors must be a list")
    for index, sector in enumerate(sectors):
        if isinstance(sector, str) and sector.strip():
            continue
        if not isinstance(sector, dict):
            raise ValueError(f"sectors[{index}] must be an object or non-empty name")
        _nonempty_string(sector.get("name"), f"sectors[{index}].name")
        if "source" in sector:
            _nonempty_string(sector.get("source"), f"sectors[{index}].source")
            if "sha256" in sector:
                _source_entry({"name": sector["name"], "path": sector["source"], "sha256": sector["sha256"]}, f"sectors[{index}]")
            _entry_age(sector)

    brain = manifest["newbrain"]
    if brain is not None:
        if not isinstance(brain, dict):
            raise ValueError("newbrain must be an object or null")
        roots = brain.get("roots", brain.get("root"))
        if isinstance(roots, str) and roots.strip():
            roots = [roots]
        if not isinstance(roots, list) or not roots or not all(isinstance(root, str) and root.strip() for root in roots):
            raise ValueError("newbrain.roots must be a non-empty list of paths")
        for index, root in enumerate(roots):
            _nonempty_string(root, f"newbrain.roots[{index}]")
        freshness = brain.get("freshness", brain.get("freshness_file"))
        if isinstance(freshness, str) and freshness.strip():
            freshness = [freshness]
        if not isinstance(freshness, list) or not freshness or not all(
            (isinstance(item, str) and item.strip()) or
            (isinstance(item, dict) and isinstance(item.get("path"), str) and item["path"].strip())
            for item in freshness
        ):
            raise ValueError("newbrain.freshness must be a non-empty list of paths")
        for index, item in enumerate(freshness):
            if isinstance(item, dict):
                _nonempty_string(item["path"], f"newbrain.freshness[{index}].path")
                _entry_age(item, brain.get("max_age_seconds"))
            else:
                _nonempty_string(item, f"newbrain.freshness[{index}]")
        _entry_age(brain)
        if brain.get("max_age_seconds") is None and not any(
            isinstance(item, dict) and item.get("max_age_seconds") is not None for item in freshness
        ):
            raise ValueError("newbrain freshness requires max_age_seconds")

    _command(manifest["refresh_command"], "refresh_command", allow_none=brain is None)
    setup_commands = manifest["setup_commands"]
    if not isinstance(setup_commands, list) or not all(
        isinstance(command, list) and command and all(isinstance(item, str) and item.strip() for item in command)
        for command in setup_commands
    ):
        raise ValueError("setup_commands must be a list of non-empty argv lists")

    recall = manifest["recall_fixture"]
    if isinstance(recall, str) and recall.strip():
        _nonempty_string(recall, "recall_fixture")
    elif isinstance(recall, dict):
        _nonempty_string(recall.get("path"), "recall_fixture.path")
        if "results_path" in recall:
            _nonempty_string(recall["results_path"], "recall_fixture.results_path")
        if "command" in recall:
            _command(recall["command"], "recall_fixture.command")
        if "sha256" in recall:
            _source_entry({"name": "recall_fixture", "path": recall["path"], "sha256": recall["sha256"]}, "recall_fixture")
        _entry_age(recall)
    else:
        raise ValueError("recall_fixture must be a path or object with a path")

    routes = manifest["allowed_routes"]
    if not isinstance(routes, list) or not routes or not all(isinstance(route, str) and route.strip() for route in routes):
        raise ValueError("allowed_routes must be a non-empty list of route names")
    _nonempty_string(manifest["data_class"], "data_class")
    if not isinstance(manifest["approvals"], (dict, list)):
        raise ValueError("approvals must be an object or list")
    receipt_fields = manifest["receipt_fields"]
    if not isinstance(receipt_fields, list) or not receipt_fields or not all(isinstance(field, str) and field.strip() for field in receipt_fields):
        raise ValueError("receipt_fields must be a non-empty list of field names")


def load_manifest(path: str | Path) -> tuple[dict[str, Any], Path]:
    manifest_path = Path(path).expanduser().resolve()
    with manifest_path.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object")
    _validate_manifest(manifest)
    return manifest, manifest_path


def _check_file(
    *,
    name: str,
    path_value: str,
    root: Path,
    expected_sha256: str | None,
    max_age_seconds: int | None,
    now: datetime,
    kind: str,
) -> tuple[dict[str, Any], ContextSource | None]:
    try:
        path = _resolve(path_value, root)
    except (OSError, ValueError) as exc:
        return {"name": name, "kind": kind, "path": path_value, "status": "BLOCKED", "issues": [f"invalid_source_path:{exc}"]}, None
    result: dict[str, Any] = {"name": name, "kind": kind, "path": str(path), "status": "PASS", "issues": []}
    if not _inside(path, root) and kind in {"context", "required_file", "recall_fixture"}:
        result["status"] = "BLOCKED"
        result["issues"].append("path_outside_project_root")
        return result, None
    try:
        if not path.is_file():
            result["status"] = "BLOCKED"
            result["issues"].append("missing_source")
            return result, None
        stat = path.stat()
        sha256 = _digest(path)
    except (OSError, ValueError) as exc:
        result["status"] = "BLOCKED"
        result["issues"].append(f"unreadable_source:{exc}")
        return result, None
    age_seconds = max(0.0, now.timestamp() - stat.st_mtime)
    result.update({"sha256": sha256, "mtime_ns": stat.st_mtime_ns, "modified": _iso(stat.st_mtime), "age_seconds": age_seconds})
    if expected_sha256 is not None and sha256 != expected_sha256:
        result["status"] = "BLOCKED"
        result["issues"].append("hash_mismatch")
    if max_age_seconds is not None and age_seconds > max_age_seconds:
        result["status"] = "BLOCKED"
        result["issues"].append("stale_source")
    proof = ContextSource(name, str(path), sha256, stat.st_mtime_ns, max_age_seconds) if kind == "context" else None
    return result, proof


def inspect_manifest(path: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    manifest_path = Path(path).expanduser().resolve()
    privacy = {
        "context_bodies_transmitted": False,
        "context_bodies_returned": False,
        "file_bytes_read_for_sha256": False,
        "external_requests": False,
        "disclosure": "Declared files are read locally only to compute SHA-256 digests; context bodies are not returned or transmitted.",
    }
    try:
        manifest, manifest_path = load_manifest(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        privacy["file_bytes_read_for_sha256"] = False
        privacy["disclosure"] = "No declared files were read because manifest loading failed."
        return {
            "status": "BLOCKED",
            "manifest": str(manifest_path),
            "issues": [f"manifest_error:{exc}"],
            "states": {"configured": "BLOCKED", "loaded": "NOT_RUN", "refreshed": "NOT_RUN", "tested": "NOT_RUN", "ready": "BLOCKED"},
            "privacy": privacy,
        }
    now = now or _now()
    project_root = _resolve(manifest["project_root"], manifest_path.parent)
    result: dict[str, Any] = {
        "status": "PASS",
        "project_id": manifest["project_id"],
        "manifest": str(manifest_path),
        "project_root": str(project_root),
        "context": [],
        "required_files": [],
        "sectors": [],
        "newbrain": None,
        "recall_fixture": None,
        "issues": [],
        "states": {"configured": "PASS", "loaded": "NOT_RUN", "refreshed": "NOT_RUN", "tested": "NOT_RUN", "ready": "BLOCKED"},
        "privacy": privacy,
    }
    if not project_root.is_dir():
        result["status"] = "BLOCKED"
        result["issues"].append("missing_project_root")
        result["states"]["loaded"] = "BLOCKED"
        return result

    proofs: list[ContextSource] = []
    all_sources_ok = True
    for index, entry in enumerate(manifest["context"]):
        check, proof = _check_file(
            name=entry["name"], path_value=entry["path"], root=project_root,
            expected_sha256=entry.get("sha256"), max_age_seconds=_entry_age(entry), now=now, kind="context",
        )
        result["context"].append(check)
        if proof:
            proofs.append(proof)
        if check["status"] != "PASS":
            all_sources_ok = False
            result["status"] = "BLOCKED"
            result["issues"].extend(f"{entry['name']}:{issue}" for issue in check["issues"])

    for index, raw_entry in enumerate(manifest["required_files"]):
        entry = _source_entry(raw_entry, f"required_files[{index}]")
        check, _ = _check_file(
            name=entry["name"], path_value=entry["path"], root=project_root,
            expected_sha256=entry.get("sha256"), max_age_seconds=_entry_age(entry), now=now, kind="required_file",
        )
        result["required_files"].append(check)
        if check["status"] != "PASS":
            all_sources_ok = False
            result["status"] = "BLOCKED"
            result["issues"].extend(f"required_file:{entry['name']}:{issue}" for issue in check["issues"])

    for sector in manifest["sectors"]:
        if isinstance(sector, str):
            sector = {"name": sector}
        item: dict[str, Any] = {"name": sector["name"], "status": "PASS", "issues": []}
        source = sector.get("source")
        if source:
            check, _ = _check_file(
                name=sector["name"], path_value=source, root=project_root,
                expected_sha256=sector.get("sha256"), max_age_seconds=_entry_age(sector), now=now, kind="sector",
            )
            item.update({"source": check["path"], "sha256": check.get("sha256"), "status": check["status"], "issues": check["issues"]})
            if check["status"] != "PASS":
                all_sources_ok = False
                result["status"] = "BLOCKED"
                result["issues"].extend(f"sector:{sector['name']}:{issue}" for issue in check["issues"])
        result["sectors"].append(item)

    brain = manifest["newbrain"]
    if brain:
        brain_roots = brain.get("roots", brain.get("root"))
        if isinstance(brain_roots, str):
            brain_roots = [brain_roots]
        brain_root_paths = [_resolve(root, manifest_path.parent) for root in brain_roots]
        freshness_entries = brain.get("freshness", brain.get("freshness_file"))
        if isinstance(freshness_entries, str):
            freshness_entries = [freshness_entries]
        freshness_checks = []
        for freshness_entry in freshness_entries:
            if isinstance(freshness_entry, dict):
                freshness_value = freshness_entry["path"]
                freshness_age = _entry_age(freshness_entry, brain.get("max_age_seconds"))
            else:
                freshness_value = freshness_entry
                freshness_age = _entry_age(brain, None)
            # Relative freshness paths belong to the first declared NewBrain
            # root, while absolute paths remain absolute.
            freshness = _resolve(freshness_value, brain_root_paths[0])
            check, _ = _check_file(
                name="newbrain_freshness", path_value=str(freshness), root=manifest_path.parent,
                expected_sha256=None, max_age_seconds=freshness_age, now=now, kind="newbrain",
            )
            check["roots"] = [str(root) for root in brain_root_paths]
            freshness_checks.append(check)
            if check["status"] != "PASS":
                all_sources_ok = False
                result["status"] = "BLOCKED"
                result["issues"].extend(f"newbrain:{issue}" for issue in check["issues"])
        for root in brain_root_paths:
            if not root.is_dir():
                all_sources_ok = False
                result["status"] = "BLOCKED"
                result["issues"].append(f"newbrain:missing_root:{root}")
        result["newbrain"] = {"status": "PASS" if all(check["status"] == "PASS" for check in freshness_checks) and all(root.is_dir() for root in brain_root_paths) else "BLOCKED", "freshness": freshness_checks, "roots": [str(root) for root in brain_root_paths]}
        result["states"]["refreshed"] = "NOT_RUN" if result["newbrain"]["status"] == "PASS" else "BLOCKED"
    else:
        result["states"]["refreshed"] = "NOT_REQUIRED"

    recall = manifest["recall_fixture"]
    recall_value = recall if isinstance(recall, str) else recall["path"]
    recall_check, _ = _check_file(
        name="recall_fixture", path_value=recall_value, root=project_root,
        expected_sha256=recall.get("sha256") if isinstance(recall, dict) else None,
        max_age_seconds=_entry_age(recall) if isinstance(recall, dict) else None,
        now=now, kind="recall_fixture",
    )
    result["recall_fixture"] = recall_check
    if recall_check["status"] != "PASS":
        all_sources_ok = False
        result["status"] = "BLOCKED"
        result["issues"].extend(f"recall_fixture:{issue}" for issue in recall_check["issues"])

    result["states"]["loaded"] = "PASS" if all_sources_ok else "BLOCKED"
    result["states"]["tested"] = "NOT_RUN" if recall_check["status"] == "PASS" else "BLOCKED"
    result["states"]["ready"] = "PASS" if all(value in {"PASS", "NOT_REQUIRED"} for value in result["states"].values()) else "BLOCKED"

    result["privacy"]["file_bytes_read_for_sha256"] = any(
        check.get("sha256")
        for collection in (result["context"], result["required_files"], result["sectors"], result["newbrain"].get("freshness", []) if result["newbrain"] else [], [result["recall_fixture"]])
        for check in collection
        if isinstance(check, dict)
    )

    result["context_proofs"] = [asdict(proof) for proof in proofs]
    return result


def _as_context_proof(value: ContextSource | Mapping[str, Any] | str) -> ContextSource | str:
    if isinstance(value, ContextSource) or isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return ContextSource(
            name=str(value["name"]), path=str(value["path"]), sha256=str(value["sha256"]),
            mtime_ns=int(value["mtime_ns"]), max_age_seconds=value.get("max_age_seconds"),
        )
    raise TypeError("context entries must be names or source proofs")


def assert_handoff(
    required_context: Iterable[str | ContextSource | Mapping[str, Any]],
    delivered_context: Iterable[str | ContextSource | Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> None:
    """Validate a handoff, retaining legacy name-only behavior.

    When source proofs are supplied, every delivered source must still exist,
    match its claimed digest/mtime, and satisfy its freshness limit.  The
    function reads bytes only to calculate a digest; it never returns content.
    """
    required = [_as_context_proof(item) for item in required_context]
    delivered = [_as_context_proof(item) for item in delivered_context]
    if all(isinstance(item, str) for item in required + delivered):
        missing = set(required) - set(delivered)
        if missing:
            raise ValueError("handoff incomplete: " + ", ".join(sorted(missing)))
        return
    now = now or _now()
    by_name = {item.name: item for item in delivered if isinstance(item, ContextSource)}
    errors: list[str] = []
    for item in required:
        if isinstance(item, str):
            if item not in by_name:
                errors.append(f"missing:{item}")
            continue
        actual = by_name.get(item.name)
        if actual is None:
            errors.append(f"missing:{item.name}")
            continue
        path = Path(actual.path).expanduser()
        if actual.path != item.path:
            errors.append(f"path_mismatch:{item.name}")
        elif not path.is_file():
            errors.append(f"missing_source:{item.name}")
        else:
            stat = path.stat()
            digest = _digest(path)
            if digest != item.sha256 or digest != actual.sha256:
                errors.append(f"hash_mismatch:{item.name}")
            if stat.st_mtime_ns != actual.mtime_ns:
                errors.append(f"changed_since_handoff:{item.name}")
            max_age = item.max_age_seconds if item.max_age_seconds is not None else actual.max_age_seconds
            if max_age is not None and now.timestamp() - stat.st_mtime > max_age:
                errors.append(f"stale:{item.name}")
    if errors:
        raise ValueError("handoff incomplete: " + ", ".join(errors))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Cynthia's local project-context preflight")
    parser.add_argument("--manifest", required=True, help="path to a context manifest JSON file")
    args = parser.parse_args(argv)
    try:
        receipt = inspect_manifest(args.manifest)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        receipt = {
            "status": "BLOCKED",
            "issues": [f"manifest_error:{exc}"],
            "privacy": {
                "context_bodies_transmitted": False,
                "context_bodies_returned": False,
                "file_bytes_read_for_sha256": False,
                "external_requests": False,
                "disclosure": "No declared files were read because manifest loading failed.",
            },
        }
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "PASS" else BLOCKED_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
