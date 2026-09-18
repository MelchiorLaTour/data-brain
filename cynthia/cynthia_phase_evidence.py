#!/usr/bin/env python3
"""Validate Cynthia phase receipts before they can be accepted."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


REQUIRED = {"phase", "planner", "executor", "auditor", "files", "commands", "tests", "verdict", "risks"}


def validate(receipt: dict) -> None:
    if receipt.get("artifact") == "cynthia_independent_audit_receipt":
        signature = receipt.get("signature")
        if receipt.get("auditor") != "opus-5" or not isinstance(signature, dict):
            raise ValueError("independent audit requires auditor opus-5 and an attestation")
        body = dict(receipt)
        body.pop("signature", None)
        rendered = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if signature.get("algorithm") != "sha256" or signature.get("body_sha256") != hashlib.sha256(rendered).hexdigest():
            raise ValueError("independent audit attestation mismatch")
        return
    missing = REQUIRED - set(receipt)
    if missing:
        raise ValueError("missing receipt fields: " + ", ".join(sorted(missing)))
    if receipt["planner"] != "astra":
        raise ValueError("planner must be astra")
    if receipt["executor"] != "luna":
        raise ValueError("executor must be luna")
    if receipt["auditor"] != "opus-5":
        raise ValueError("auditor must be opus-5")
    if receipt["verdict"] not in {"PASS", "FAIL", "BLOCKED"}:
        raise ValueError("invalid verdict")
    for field in ("files", "commands", "tests", "risks"):
        if not isinstance(receipt[field], list):
            raise ValueError(f"{field} must be a list")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Validate a Cynthia phase evidence receipt")
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args(argv)
    try:
        receipt = json.loads(Path(args.receipt).read_text(encoding="utf-8"))
        validate(receipt)
        result = {"status": receipt["verdict"], "phase": receipt["phase"]}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        result = {"status": "BLOCKED", "issue": str(error)}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
