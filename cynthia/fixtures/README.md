# Cynthia Phase 0 — frozen baseline fixtures

**Status:** FROZEN; Phase 0 gate is not yet passed.

`manifest.jsonl` is the frozen fixture index and `fixture-inputs.json` is the frozen input corpus.
Every fixture is synthetic or public, contains no Mel content, and is immutable once a native
baseline begins. A changed task, rubric, or model version creates a new fixture ID; it never
overwrites this corpus.

Phase 0 can pass only after every fixture records its native baseline run: exact provider/model,
effort, returned token counts, wall-clock seconds, complete reproducible output, and the stated
deterministic or human rubric. Protected (`P`) fixtures additionally require two distinct graders
from Terra, Sol, Opus 4.8, and Opus 5. Until then, protected acceptance is blocked.

The `newbrain_embedding_exclusion` fixture is a negative policy test: it proves that a personal
archive remains native-only. It is not an embedding evaluation. `routing-policy.json` freezes the
native-only, private-work, grading, handoff, and switch-rule policy. Local tests prove the
structural boundary; they do not replace protected acceptance evidence.

## Project-context preflight

`../context-manifest.template.json` is the machine-readable manifest format. A manifest declares
the project root, required context files, sector source files, and (optionally) a Data Brain file
whose modification time represents freshness. `cynthia_coordinator.py` emits a metadata-only JSON
receipt: `PASS` means every required declaration is proven; `BLOCKED` identifies the failed gate.
The coordinator does not send content anywhere. `context-manifest.json` is a synthetic, runnable
example used by the coordinator tests.
