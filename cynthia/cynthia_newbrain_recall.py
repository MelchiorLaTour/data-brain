#!/usr/bin/env python3
"""Create a metadata-only Cynthia receipt from NewBrain's canonical scorer."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path.home() / "Claude/NewBrain/research/eval-v3"
LINE = re.compile(r"^v3/(easy|medium|hard|xling)\s+(\d+)/(\d+)")
TRAPS = re.compile(r"^TRAP HONESTY\s+(\d+)/(\d+)")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate(run_name: str, *, root: Path = ROOT) -> dict:
    """Run the pinned scorer, retaining only aggregate counts and input digests."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", run_name):
        raise ValueError("invalid run name")
    root = root.resolve()
    required = {
        "queries": root / "queries.tsv", "labels": root / "labels.tsv",
        "run": root / "runs" / f"{run_name}.tsv", "flags": root / "runs" / f"{run_name}.flags",
        "scorer": root / "score.sh", "rule": root / "RULE.md",
    }
    if any(not path.is_file() for path in required.values()):
        raise ValueError("required NewBrain evaluation artifact is missing")
    completed = subprocess.run(["bash", str(required["scorer"]), run_name], cwd=root,
                               text=True, capture_output=True, check=False)
    if completed.returncode:
        raise ValueError("canonical scorer failed")
    strata = {}
    traps = None
    for line in completed.stdout.splitlines():
        match = LINE.match(line)
        if match:
            strata[match.group(1).title() if match.group(1) != "xling" else "XLING"] = {
                "hits": int(match.group(2)), "denominator": int(match.group(3)),
            }
        match = TRAPS.match(line)
        if match:
            traps = {"honest_abstentions": int(match.group(1)), "valid_traps": int(match.group(2))}
    if set(strata) != {"Easy", "Medium", "Hard", "XLING"} or traps is None:
        raise ValueError("canonical scorer did not return the frozen strata")
    return {
        "schema_version": 1, "kind": "newbrain_eval_v3_aggregate", "run_name": run_name,
        "strata": strata, "traps": traps,
        "inputs_sha256": {name: _sha256(path) for name, path in required.items()},
        "privacy": {"raw_queries_returned": False, "raw_paths_returned": False, "external_requests": False},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a metadata-only NewBrain recall receipt")
    parser.add_argument("--run", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        receipt = generate(args.run)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "BLOCKED", "issue": str(error)}))
        return 2
    destination = Path(args.output).expanduser().resolve()
    destination.write_text(json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "run_name": args.run, "raw_paths_returned": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
