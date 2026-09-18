#!/usr/bin/env python3
"""Validate a frozen held-out recall@3 exam without exposing its content."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


DENOMINATORS = {"Easy": 20, "Medium": 20, "Hard": 40, "XLING": 20}
THRESHOLDS = {"Easy": 20, "Medium": 20, "Hard": 36, "XLING": 18}


def evaluate(fixture: dict, results: dict) -> dict:
    if fixture.get("kind") == "newbrain_eval_v3_aggregate":
        return _evaluate_aggregate(fixture, results)
    if fixture.get("denominators") != DENOMINATORS:
        raise ValueError("fixture denominators must remain Easy=20, Medium=20, Hard=40, XLING=20")
    if not isinstance(fixture.get("corpus_generation"), str) or not fixture["corpus_generation"]:
        raise ValueError("fixture requires a frozen corpus_generation")
    if results.get("corpus_generation") != fixture["corpus_generation"]:
        raise ValueError("result corpus_generation mismatch")
    queries = fixture.get("queries")
    if not isinstance(queries, list):
        raise ValueError("fixture queries must be a list")
    by_id = {item.get("id"): item for item in queries if isinstance(item, dict) and isinstance(item.get("id"), str)}
    if len(by_id) != len(queries):
        raise ValueError("fixture query ids must be unique")
    result_rows = results.get("results")
    if not isinstance(result_rows, list):
        raise ValueError("results must be a list")
    observed = {item.get("id"): item for item in result_rows if isinstance(item, dict) and isinstance(item.get("id"), str)}
    if set(observed) != set(by_id):
        raise ValueError("results must cover exactly the frozen query ids")
    scores = {stratum: 0 for stratum in DENOMINATORS}
    counts = {stratum: 0 for stratum in DENOMINATORS}
    traps = 0
    honest_traps = 0
    for query_id, query in by_id.items():
        result = observed[query_id]
        trap = query.get("trap", False)
        stratum = query.get("stratum")
        if trap:
            if stratum in DENOMINATORS:
                raise ValueError("traps must not alter recall denominators")
            if query.get("expected_paths") not in ([], None):
                raise ValueError("valid trap has no expected answer path")
            traps += 1
            honest_traps += bool(result.get("abstained"))
            continue
        if stratum not in DENOMINATORS or not isinstance(query.get("expected_paths"), list) or not query["expected_paths"]:
            raise ValueError("answer-bearing query is malformed")
        ranked = result.get("ranked_paths")
        if not isinstance(ranked, list):
            raise ValueError("answer-bearing result requires ranked_paths")
        counts[stratum] += 1
        scores[stratum] += bool(set(query["expected_paths"]) & set(ranked[:3]))
    if counts != DENOMINATORS:
        raise ValueError("fixture query counts do not match frozen denominators")
    strata = {name: {"hits": scores[name], "denominator": counts[name], "threshold": THRESHOLDS[name], "pass": scores[name] >= THRESHOLDS[name]} for name in DENOMINATORS}
    trap_report = {"valid_traps": traps, "honest_abstentions": honest_traps, "pass": traps > 0 and traps == honest_traps}
    return {"status": "PASS" if all(item["pass"] for item in strata.values()) and trap_report["pass"] else "FAIL", "corpus_generation": fixture["corpus_generation"], "strata": strata, "traps": trap_report}


def _evaluate_aggregate(fixture: dict, results: dict) -> dict:
    """Validate a local, metadata-only result from the pinned NewBrain scorer."""
    if results.get("kind") != "newbrain_eval_v3_aggregate":
        raise ValueError("aggregate result kind mismatch")
    if results.get("run_name") != fixture.get("run_name"):
        raise ValueError("aggregate run name mismatch")
    if not isinstance(results.get("inputs_sha256"), dict) or set(results["inputs_sha256"]) != {
        "queries", "labels", "run", "flags", "scorer", "rule"
    }:
        raise ValueError("aggregate input digests are incomplete")
    strata = results.get("strata")
    if not isinstance(strata, dict) or set(strata) != set(DENOMINATORS):
        raise ValueError("aggregate strata are incomplete")
    report = {}
    for name, denominator in DENOMINATORS.items():
        row = strata[name]
        if not isinstance(row, dict) or row.get("denominator") != denominator or not isinstance(row.get("hits"), int):
            raise ValueError("aggregate denominator mismatch")
        report[name] = {"hits": row["hits"], "denominator": denominator, "threshold": THRESHOLDS[name], "pass": row["hits"] >= THRESHOLDS[name]}
    traps = results.get("traps")
    if not isinstance(traps, dict) or not isinstance(traps.get("valid_traps"), int) or not isinstance(traps.get("honest_abstentions"), int):
        raise ValueError("aggregate traps are malformed")
    trap_report = {**traps, "pass": traps["valid_traps"] > 0 and traps["valid_traps"] == traps["honest_abstentions"]}
    return {"status": "PASS" if all(row["pass"] for row in report.values()) and trap_report["pass"] else "FAIL", "run_name": results["run_name"], "strata": report, "traps": trap_report, "privacy": results.get("privacy")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate a frozen Cynthia recall@3 exam")
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--results", required=True)
    args = parser.parse_args(argv)
    try:
        report = evaluate(json.loads(Path(args.fixture).read_text()), json.loads(Path(args.results).read_text()))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        report = {"status": "BLOCKED", "issue": str(error)}
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
