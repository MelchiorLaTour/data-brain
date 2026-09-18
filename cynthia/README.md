# Cynthia — local task control and evidence

Cynthia is the companion control layer for Data Brain. It is deliberately
small and deterministic: it validates project manifests, proves context by
hash, selects a native-only route, enforces approval gates, runs local safety
suites, and emits machine-readable setup and end-to-end receipts.

## Data Brain boundary

The optional `cynthia_newbrain_recall.py` bridge invokes Data Brain's pinned
local scorer and returns only aggregate stratum counts plus SHA-256 digests of
the scorer inputs. It does not return note bodies, raw query text, or note
paths. The default root is intentionally a local example; adapt it to your own
Data Brain checkout and frozen evaluation before using it.

## Included and omitted

This public package includes source, tests, and synthetic fixtures. It omits
machine-specific run results, generated setup/E2E receipts, routing logs, and
independent audit receipts. Those artifacts can identify a private local setup
or its protected evaluation inputs.

Run the source tests from the repository root:

```bash
python3 -m unittest discover -s cynthia/tests -p 'test_*.py'
```
