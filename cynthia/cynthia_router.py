#!/usr/bin/env python3
"""Cynthia's deterministic, fail-closed routing policy.

This module only chooses or rejects a route.  It never sends task content.
All work stays on the native Codex route.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

from cynthia_coordinator import ContextSource, assert_handoff


ROOT = Path(__file__).resolve().parent
LOG = ROOT / "routing.jsonl"
THIRD_PARTY = frozenset()
CONFIDENCE_MODELS = frozenset({"terra", "sol", "opus-4.8", "opus-5"})
PRIVATE_CLASSES = frozenset({"mel_content", "private", "sensitive", "unknown"})


@dataclass(frozen=True)
class Task:
    task_id: str
    workload: str
    data_class: str
    required_context: tuple[str, ...]
    protected_measurement: bool = False
    edge_case: bool = False
    bulk: bool = False
    approved: bool = False


@dataclass(frozen=True)
class Decision:
    orchestrator: str
    status: str
    provider: str | None
    model: str | None
    fallback_model: str | None
    reason: str
    parallel_models: tuple[str, ...] = ()


def choose(task: Task, passed_routes: Iterable[Mapping[str, Any]] = ()) -> Decision:
    """Choose native execution; route records cannot enable third-party work."""
    orchestrator = "terra"
    if task.protected_measurement:
        return Decision(orchestrator, "requires_dual_confidence_grade", None, None, None,
                        "only Terra, Sol, Opus 4.8, and Opus 5 may grade")

    if task.workload == "writing" and not task.approved:
        return Decision(orchestrator, "approval_required", None, None, "luna",
                        "writing work requires explicit manifest approval")

    return Decision(orchestrator, "native_only", "codex", "luna", "terra",
                    "Cynthia is native-only; no task is eligible for third-party routing")


def can_switch(*, cheaper: bool, same_result: bool, edge_case: bool) -> tuple[bool, str]:
    if edge_case:
        return False, "edge_case"
    if not cheaper:
        return False, "not_cheaper"
    if not same_result:
        return False, "result_not_equivalent"
    return True, "eligible"


def log_event(event: dict) -> None:
    """Append metadata only; reject fields that can carry prompts, secrets, or personal paths."""
    allowed = {"fixture_id", "provider", "model", "cost_quota_fraction", "wall_clock_seconds", "pass_fail", "safe_fallback", "failure_class", "task_class", "route_reason", "switch_status"}
    forbidden = {"prompt", "response", "body", "credential", "api_key", "personal_path", "content"}
    overlap = forbidden & set(event)
    if overlap:
        raise ValueError("telemetry refuses: " + ", ".join(sorted(overlap)))
    unexpected = set(event) - allowed
    if unexpected:
        raise ValueError("telemetry refuses unknown fields: " + ", ".join(sorted(unexpected)))
    if any(isinstance(value, (dict, list, tuple, set)) for value in event.values()):
        raise ValueError("telemetry refuses nested values")
    safe = {"timestamp": datetime.now(timezone.utc).isoformat(), **event}
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(safe, sort_keys=True) + "\n")


def as_metadata(decision: Decision) -> dict:
    metadata = asdict(decision)
    metadata["parallel_models"] = list(metadata["parallel_models"])
    return metadata
