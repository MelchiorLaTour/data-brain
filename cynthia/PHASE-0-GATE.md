# Cynthia Phase 0 gate

**Verdict: BLOCKED — protected acceptance evidence is incomplete; routing is native-only.**

## Evidence recorded

- PASS — `fixtures/manifest.jsonl` freezes one synthetic/public, non-personal fixture for each
  workload in the Phase 0 plan, plus the separate Data Brain data-boundary negative test.
- PASS — every fixture declares class, integrity, provenance, `data_class`, task, rubric,
  and `native_baseline: pending`.
- PASS — the protected grading fixture pins two distinct confidence-set graders: Terra and Opus
  4.8.
- PASS — `newbrain_embedding_exclusion` is a negative data-boundary fixture: a `mel_content`
  payload must be rejected before any third-party route or request.
- PASS — deterministic policy fixtures prove Terra orchestration, Luna-only private/sensitive
  execution, native-only routing for every workload, grading restrictions, complete handoff
  enforcement, and the switch rule.
- PASS — public synthetic native probes returned the frozen response from `gpt-5.6-terra` and
  `gpt-5.6-luna`; their metadata is in `routing.jsonl`. Returned subscription-quota fraction was
  unavailable, so it is explicitly `unknown`, not estimated.
- PASS — Vertex/Gemini and NVIDIA have been removed from Cynthia. No third-party route can be
  selected, so provider access is not an operational dependency.

## Evidence still required before PASS

- Native execution records with exact model, effort, returned token counts, wall-clock seconds,
  complete reproducible output, and rubric result for every remaining fixture.
- A successful no-request proof for the `mel_content` rejection fixture.
- Protected-fixture grades from the two named, distinct confidence models and a recorded
  agreement or Mel escalation.
- No provider evidence is required: third-party routing is permanently disabled.

Until protected grading records exist, Phase 0 remains BLOCKED. The checked-in policy is native-only.

## Context-control implementation slice — 2026-09-17

**PASS (local only)** — `cynthia_coordinator.py` now provides a deterministic, machine-readable
preflight for a project context manifest. It verifies declared project files, optional sector
source files, and an optional Data Brain freshness marker using existence, modification time, and
SHA-256 metadata only. It reads no context bodies for reporting and makes no external requests.

**PASS (local only)** — `assert_handoff` now accepts the existing name-only form for compatibility
and a source-proof form that rejects missing, invented, moved, changed, or stale context before
execution. Existing routing tests remain green.

**PASS (local only)** — 15 unit tests cover clean, missing, stale, changed/invented handoffs, and
Data Brain freshness-marker checks. This slice does not change model/provider routing, refresh the
personal corpus, migrate Obsidian, or lift the Phase 0 external-route block.

Usage:

```bash
python3 cynthia/cynthia_coordinator.py --manifest cynthia/context-manifest.template.json
```

The command exits `0` for `PASS` and `2` for `BLOCKED`, and prints one JSON receipt to stdout.
