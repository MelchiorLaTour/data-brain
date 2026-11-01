#!/usr/bin/env bash
# build-fts-fr.sh — derive moc/fts_fr.db, a French-only shadow of the main FTS index (moc/fts.db).
# Why a separate table rather than a language column: BM25's IDF is a statistic over whichever corpus it is computed on. A short
# French note sitting in a corpus that is mostly English is rare on every one of its terms and still loses, because the surrounding
# English mass sets the scale. Given its own corpus it competes against comparable documents. Rebuilt from the main index, so it can
# never disagree with it about content; a failure here never touches the main index.
# Language test: DENSITY of French function words per 1000 characters, not a raw count (a raw count is length-biased: a three-line
# French note could never reach it). NB_FR_DENS tunes the threshold.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
SRC="${NB_FTS_DB:-$MOC/fts.db}"
DST="$(dirname "$SRC")/fts_fr.db"
[ -f "$SRC" ] || { echo "build-fts-fr: no source index at $SRC" >&2; exit 1; }
DST_TMP="$(mktemp "${DST}.tmp.XXXXXX")"
trap 'rm -f "$DST_TMP"' EXIT
rm -f "$DST_TMP"
# how many French function words one body holds (each ' mot ' counted by the length it removes)
MK="(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' les ','')))/5
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' des ','')))/5
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' une ','')))/5
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' pour ','')))/6
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' dans ','')))/6
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' est ','')))/5
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' le ','')))/4
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' la ','')))/4
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' du ','')))/4
  +(length(lower(' '||body||' ')) - length(replace(lower(' '||body||' '),' et ','')))/4"
sqlite3 "$DST_TMP" "
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, tokenize='porter unicode61 remove_diacritics 2');
ATTACH DATABASE '$SRC' AS m;
INSERT INTO notes(path,title,themes,keywords,body)
  SELECT path,title,themes,keywords,body FROM (SELECT path,title,themes,keywords,body,($MK) AS mk FROM m.notes WHERE length(body) > 0)
  WHERE mk >= 2 AND 1000.0 * mk / length(body) >= ${NB_FR_DENS:-4};
" || { echo "build-fts-fr: could not build the French index; the main index is untouched." >&2; exit 1; }
mv -f "$DST_TMP" "$DST"
echo "fts_fr.db: $(sqlite3 "$DST" 'SELECT count(*) FROM notes;') French notes of $(sqlite3 -readonly "$SRC" 'SELECT count(*) FROM notes;')"
