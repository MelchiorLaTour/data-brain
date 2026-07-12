# MAP — the brain, hand-navigable

*TEMPLATE — the INSTALL.md bootstrap generates YOUR MAP.md from your real rooms after the
first index build. This skeleton shows the shape. The map must work with the agent OFF:
a human reading only this file can find any note.*

## The mental model: House → Sector → Book → Room

- **House** — the whole brain: every canonical root listed in `bin/canon.sh`. Notes live ONCE
  in their real homes; the brain copies nothing and never moves/renames a Finder-visible file.
- **Sector** — a life-area grouping of rooms (e.g. *work*, *personal*, *projects*). Sectors are
  navigation prose in this file, not folders.
- **Book** — a compiled room wiki (`moc/wiki/<room>/OVERVIEW.md` + concept pages): on-demand
  synthesis cache over one room. Only compile when synthesis questions recur (see DOCTRINE.md).
- **Room** — a theme label in `moc/index.tsv` (column 3). One note can sit in several rooms
  (multi-label). Room MOCs are derived + rebuildable: `moc/rooms/<room>.md`.

## How to find something (agent off)

1. Skim the room list below → open `moc/rooms/<room>.md` → scan titles → open the note at its
   real path.
2. Or search: `bash bin/fts.sh "<keywords>"` (ranked), `bash bin/search.sh "<exact phrase>"`.

## Rooms (EDIT — the bootstrap fills this from YOUR index)

| Room | What lives here | Example canonical homes |
|---|---|---|
| ideas | raw captures, sparks, half-thoughts | `<your notes root>/Ideas/` |
| projects | active project docs + plans | `~/Documents/GitHub/`, project folders |
| career | CV iterations, applications, work docs | `~/Desktop/Career/` |
| records | admin: IDs, contracts, receipts | `~/Desktop/Personal Records/` |
| writing | essays, letters, drafts | `~/Desktop/Writing/` |
| misc | everything unrouted | (catch-all) |

## Machinery (never notes)

- `moc/index.tsv` — label source of truth: `path · title · themes · keywords`
- `moc/rooms/` + `moc/INDEX.md` — derived maps, redraw with `bin/rebuild.sh`
- `moc/extracted/` — plaintext sidecars for binary/offloaded files (`bin/extract.sh`)
- `moc/wiki/` — compiled room books (on-demand)
- `moc/log.md` — append-only ingest ledger
- `bin/` — the engine (see README.md)
