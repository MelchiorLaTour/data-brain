#!/bin/bash
# cloud-scan.sh — list online-only (dataless) files of supported types in the approved folders, and Google Docs shortcut files.
# Nothing is read or downloaded: it only looks at file flags and sizes. Writes:
#   $MOC/cloud-pending.tsv    path<TAB>size_bytes   (online-only files)
#   $MOC/cloud-shortcuts.tsv  path                  (.gdoc/.gsheet/.gslides: links, not documents)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ ! -f "$ROOT/bin/compat.sh" ] || source "$ROOT/bin/compat.sh"   # Linux / Windows WSL: BSD stat/date forms
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
mkdir -p "$MOC"
tmpd="$(mktemp -d "$MOC/.cloud-scan.XXXXXX")"; trap 'rm -rf "$tmpd"' EXIT
: > "$tmpd/all"; : > "$tmpd/shortcuts"
# ONE walk per folder (documents and Google shortcut files together), then split by name. The old version walked every folder twice and, for each
# online-only file, started about eight programs (two hashes, two cuts, a grep, a stat): minutes on a large iCloud.
: > "$tmpd/walked"
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  selected_root_find0 "$root" "${PRUNE_DIRS[@]}" -type f \( \
       -iname '*.md' -o -iname '*.txt' -o -iname '*.pdf' \
    -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.pages' -o -iname '*.rtf' \
    -o -name '*.gdoc' -o -name '*.gsheet' -o -name '*.gslides' \) \
    "${PRUNE_FIND[@]}" | tr '\0' '\n' >> "$tmpd/walked"
done
grep -E '\.(gdoc|gsheet|gslides)$' "$tmpd/walked" > "$tmpd/shortcuts" || true
grep -viE '\.(gdoc|gsheet|gslides)$' "$tmpd/walked" | sort -u > "$tmpd/all" || true
nb_dataless_paths < "$tmpd/all" | sort -u > "$tmpd/cloud"
# A file that was indexed with text while it was on this Mac and has since gone online-only is not waiting for anything: its text is
# already searchable (extract.sh reports it as cloud_only, same test). Listing it would inflate "not indexed" and queue a pointless download.
: > "$tmpd/has-text"
[ -s "$MOC/fts.db" ] && /usr/bin/sqlite3 -readonly "$MOC/fts.db" "SELECT path FROM notes WHERE length(body) > 0;" > "$tmpd/has-text" 2>/dev/null
# Two more groups that are never queued, because downloading them would be pointless or unwanted (listed in cloud-skipped.tsv: path TAB reason):
#   excluded / held  the user excluded the file at the privacy review, or it still waits for that decision: never downloaded
#   no_text          an earlier extraction ended with no text layer or a read/extract failure, and the file's size and mtime are the same now
# privacy.tsv uses absolute paths and extract-report.tsv the ~ spelling: both are matched. ctime is ignored (iCloud moves it alone).
# One perl process for all online-only files: skip a file that has an extract sidecar (sha1 of its path, first 16 hex, either spelling: absolute or ~)
# or a search row with text; print "path TAB size" for the rest. stat() of a dataless file reads the flag only; nothing is downloaded.
/usr/bin/perl -e '
  use strict; use Digest::SHA qw(sha1_hex);
  my ($moc, $home, $hastext, $privfile, $skipout) = @ARGV;
  my %priv; my %nameonly;
  if (open(my $no, "<", "$moc/name-only.tsv")) { while (my $l = <$no>) { chomp $l; my ($pp) = split /\t/, $l; $nameonly{$pp} = 1 if defined $pp } close $no }
  if ($privfile ne "" && open(my $pv, "<", $privfile)) { while (my $l = <$pv>) { chomp $l; my ($st, $pp) = split /\t/, $l; next unless defined $pp; $priv{$pp} = $st } close $pv }
  my (%final, %finalfp, $reportmtime);
  if (open(my $rp, "<", "$moc/extract-report.tsv")) {
    $reportmtime = (stat($rp))[9];
    while (my $l = <$rp>) { chomp $l; next if $l =~ /^#/; my ($pp, $st, $fp) = split /\t/, $l; next unless defined $st;
      if ($st eq "no_text_layer" || $st eq "read_failed" || $st eq "extraction_failed") { $final{$pp} = $st; $finalfp{$pp} = defined $fp ? $fp : "" } else { delete $final{$pp}; delete $finalfp{$pp} } }
    close $rp;
  }
  open(my $sk, ">", $skipout) or die "cannot write $skipout";
  my %has; if (open(my $h, "<", $hastext)) { while (my $l = <$h>) { chomp $l; $has{$l} = 1 } close $h }
  while (my $f = <STDIN>) {
    chomp $f; next if $f eq "";
    my $tilde = (index($f, $home . "/") == 0) ? "~" . substr($f, length($home)) : $f;
    my $done = 0;
    if ($nameonly{$f} || $nameonly{$tilde}) { print $sk "$f\tname_only\n"; next }
    my ($ps) = grep { defined } map { $priv{$_} } ($f, $tilde);
    if (defined $ps && ($ps eq "excluded" || $ps eq "held")) { print $sk "$f\t$ps\n"; next }
    for my $p ($f, $tilde) {
      my $side = "$moc/extracted/" . substr(sha1_hex($p), 0, 16) . ".txt";
      if ((-s $side) || $has{$p}) { $done = 1; last }
    }
    next if $done;
    my @st = stat($f);
    for my $p ($f, $tilde) {
      next unless exists $final{$p};
      my $same = $finalfp{$p} ne "" ? (@st && "$st[7]:$st[9]" eq $finalfp{$p}) : (@st && defined $reportmtime && $st[9] <= $reportmtime);
      if ($same) { print $sk "$f\tno_text\n"; $done = 1 }
      last;
    }
    next if $done;
    print "$f\t", (@st ? $st[7] : 0), "\n";
  }' "$MOC" "$HOME" "$tmpd/has-text" "${NB_PRIVACY_FILE:-}" "$tmpd/skipped" < "$tmpd/cloud" > "$tmpd/pending" || { echo 'cloud-scan: could not list the online-only files' >&2; exit 2; }
mv -f -- "$tmpd/pending" "$MOC/cloud-pending.tsv"
sort -u "$tmpd/skipped" > "$MOC/cloud-skipped.tsv"
sort -u "$tmpd/shortcuts" > "$MOC/cloud-shortcuts.tsv"
echo "cloud-scan: $(wc -l < "$MOC/cloud-pending.tsv" | tr -d ' ') online-only file(s), $(wc -l < "$MOC/cloud-shortcuts.tsv" | tr -d ' ') shortcut(s)"
