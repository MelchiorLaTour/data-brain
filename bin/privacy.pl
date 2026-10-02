#!/usr/bin/perl
# privacy.pl — local privacy screen for DataBrain. Nothing here talks to the network.
#   names    < paths   flag file/folder NAMES that look private (no file is opened); append to the held list
#   filter   < paths   drop held/excluded paths; for undecided ones check the name, then (md/txt only) the text
#   content  <path>    read text on stdin, print a reason if it holds a clear private pattern
#   prune-index <tsv>  remove held/excluded rows from an index.tsv
# The held list is $NB_PRIVACY_FILE, lines: status<TAB>path<TAB>reason (held | excluded | allowed; last line wins).
# With NB_PRIVACY_FILE unset every mode lets everything through, so terminal and Codex use are unchanged.
use strict;
use warnings;
use utf8;
use Encode qw(decode);
use Unicode::Normalize qw(NFD);

binmode(STDOUT, ':utf8');
my $mode = shift @ARGV // '';
my $PRIV = $ENV{NB_PRIVACY_FILE} // '';

sub fold {
  my ($s) = @_;
  $s = decode('UTF-8', $s, Encode::FB_DEFAULT) unless utf8::is_utf8($s);
  $s = NFD(lc $s);
  $s =~ s/\p{Mn}//g;
  return $s;
}

# --- name rules, English and French. Matched on accent-stripped lowercase words. ---
my @FILE_WORDS = (
  'tax(?:es)?', 'tax return', 'w ?2', '1099', 'bank', 'banking', 'bank statement', 'iban', 'swift', 'passport',
  'driver s licen[sc]e', 'driving licen[sc]e', 'social security', 'ssn', 'id card', 'identity card', 'medical', 'prescription',
  'diagnosis', 'payslip', 'pay stub', 'paystub', 'payroll', 'passwords?', 'credentials?', 'secrets?', 'private key',
  'seed phrase', 'recovery phrase', 'wallet', 'contracts?', 'lease', 'mortgage', 'insurance',
  'impots?', 'avis d imposition', 'declaration de revenus', 'releve bancaire', 'releve de compte', 'rib', 'banque', 'bancaire',
  'passeport', 'carte d identite', 'carte vitale', 'secu', 'securite sociale', 'mutuelle', 'ordonnance',
  'bulletins? de (?:paie|paye|salaire)', 'fiche de (?:paie|paye)', 'mots? de passe', 'mdp', 'identifiants', 'cle privee',
  'contrats?', 'bail', 'assurance', 'hypotheque', 'titre de sejour', 'acte de naissance', 'casier judiciaire',
);
my @FOLDER_WORDS = (
  'banque', 'bank', 'banking', 'sante', 'health', 'medical', 'medicale', 'impots?', 'taxes?', 'tax', 'ids?', 'identite', 'identity',
  'documents officiels', 'official documents', 'passeports?', 'passports?', 'assurances?', 'insurance', 'contrats?', 'contracts?',
  'prives?', 'private', 'confidentiel', 'confidential', 'sensitive', 'passwords?', 'mots de passe', 'payslips?', 'bulletins de paie',
  'fiches de paie', 'mutuelle', 'bail', 'lease', 'etat civil',
);
my $file_re   = join '|', @FILE_WORDS;
my $folder_re = join '|', @FOLDER_WORDS;

sub words { my ($s) = @_; $s = fold($s); $s =~ s/[^a-z0-9]+/ /g; $s =~ s/^ +| +$//g; return " $s "; }

my @ROOTS;
if ($ENV{NB_CANON_ROOTS_FILE} && open(my $rf, '<:utf8', $ENV{NB_CANON_ROOTS_FILE})) {
  chomp(@ROOTS = <$rf>); close $rf;
  @ROOTS = sort { length($b) <=> length($a) } grep { length } @ROOTS;
}

sub name_reason {
  my ($path) = @_;
  $path = decode('UTF-8', $path, Encode::FB_DEFAULT) unless utf8::is_utf8($path);
  my $rel = $path;
  for my $r (@ROOTS) { if (index($rel, "$r/") == 0) { $rel = substr($rel, length($r) + 1); last; } }
  my @parts = split m{/}, $rel;
  my $file = pop @parts;
  for my $dir (@parts) {
    my $w = words($dir);
    return "folder \"$dir\" looks private" if $w =~ / (?:$folder_re) /;
  }
  (my $stem = $file) =~ s/\.[^.]*$//;
  my $w = words($stem);
  return "name \"$1\" looks private" if $w =~ / ($file_re) /;
  return '';
}

# --- content rules: clear patterns with real checksums where one exists ---
sub iban_ok {
  my ($s) = @_;
  $s =~ s/\s+//g; $s = uc $s;
  return 0 unless $s =~ /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
  my $r = substr($s, 4) . substr($s, 0, 4);
  $r =~ s/([A-Z])/ord($1) - 55/ge;
  my $rem = 0;
  $rem = ($rem * 10 + $_) % 97 for split //, $r;
  return $rem == 1;
}

sub luhn_ok {
  my ($d) = @_;
  my ($sum, $alt) = (0, 0);
  for my $c (reverse split //, $d) { my $n = $c; if ($alt) { $n *= 2; $n -= 9 if $n > 9; } $sum += $n; $alt = !$alt; }
  return $sum % 10 == 0;
}

sub nir_ok {
  my ($s) = @_;
  $s =~ s/\s+//g; $s = uc $s;
  return 0 unless $s =~ /^([12]\d{2}(?:0[1-9]|1[0-2]|[2-9]\d)(?:\d{2}|2[AB])\d{6})(\d{2})$/;
  my ($body, $key) = ($1, $2);
  $body =~ s/2A/19/; $body =~ s/2B/18/;
  my $rem = 0;
  $rem = ($rem * 10 + $_) % 97 for split //, $body;
  return (97 - $rem) == $key;
}

sub content_reason {
  my ($text) = @_;
  $text = decode('UTF-8', $text, Encode::FB_DEFAULT) unless utf8::is_utf8($text);
  $text = substr($text, 0, 400000);
  return 'contains a private key' if $text =~ /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
  while ($text =~ /\b([A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,4})?)\b/g) {
    return 'contains an IBAN' if iban_ok($1);
  }
  while ($text =~ /(?<![\d-])((?:\d[ -]?){13,19})(?![\d-])/g) {
    (my $d = $1) =~ s/\D//g;
    return 'contains a card number' if length($d) >= 13 && length($d) <= 19 && $d =~ /^[3-6]/ && luhn_ok($d);
  }
  while ($text =~ /\b([12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2]|[2-9]\d)[ ]?(?:\d{2}|2[AaBb])[ ]?\d{3}[ ]?\d{3}[ ]?\d{2})\b/g) {
    return 'contains a French social security number' if nir_ok($1);
  }
  my $f = fold($text);
  return 'contains a passport or ID number'
    if $f =~ /(?:passport|passeport|id number|identity card|carte d identite|national id|numero de piece)[^a-z0-9]{0,25}(?=[a-z0-9]*\d)[a-z0-9]{6,9}\b/;
  return '';
}

# --- held list ---
my %status; my %reason;
sub load_priv {
  return unless $PRIV && -f $PRIV;
  open(my $fh, '<:utf8', $PRIV) or return;
  while (my $line = <$fh>) {
    chomp $line;
    my ($s, $p, $r) = split /\t/, $line, 3;
    next unless defined $p && length $p;
    $status{$p} = $s; $reason{$p} = $r // '';
  }
  close $fh;
}
sub hold {
  my ($path, $why) = @_;
  return unless $PRIV;
  open(my $fh, '>>:utf8', $PRIV) or die "privacy: cannot write $PRIV\n";
  print $fh "held\t$path\t$why\n";
  close $fh;
  $status{$path} = 'held';
}
sub dropped { my ($p) = @_; my $s = $status{$p} // ''; return $s eq 'held' || $s eq 'excluded'; }
sub is_text { my ($p) = @_; return $p =~ /\.(?:md|markdown|txt)$/i; }
sub slurp {
  my ($p) = @_;
  open(my $fh, '<:raw', $p) or return '';
  read($fh, my $buf, 400000);
  close $fh;
  return $buf // '';
}

load_priv();
if ($mode eq 'names') {
  my %seen;
  while (my $line = <STDIN>) {
    chomp $line;
    next unless length $line;
    $line = decode('UTF-8', $line, Encode::FB_DEFAULT);
    next if exists $status{$line};
    my $why = name_reason($line);
    hold($line, $why) if $why;
  }
} elsif ($mode eq 'filter') {
  while (my $line = <STDIN>) {
    chomp $line;
    next unless length $line;
    my $p = decode('UTF-8', $line, Encode::FB_DEFAULT);
    if (!$PRIV) { print "$p\n"; next; }
    next if dropped($p);
    if (!exists $status{$p}) {
      my $why = name_reason($p);
      $why = content_reason(slurp($line)) if !$why && is_text($p);
      if ($why) { hold($p, $why); next; }
    }
    print "$p\n";
  }
} elsif ($mode eq 'content') {
  my $path = decode('UTF-8', shift(@ARGV) // '', Encode::FB_DEFAULT);
  local $/; my $text = <STDIN> // '';
  exit 0 if !$PRIV || ($status{$path} // '') eq 'allowed';
  my $why = content_reason($text);
  if ($why) { hold($path, $why); print "$why\n"; }
} elsif ($mode eq 'prune-index') {
  my $file = shift @ARGV // '';
  exit 0 unless $PRIV && -f $file;
  my $home = $ENV{HOME} // '';
  open(my $in, '<:utf8', $file) or exit 0;
  my @keep;
  while (my $line = <$in>) {
    my ($p) = split /\t/, $line, 2;
    if (defined $p && $p !~ /^#/) { (my $abs = $p) =~ s/^~/$home/; if (dropped($abs)) { next; } }
    push @keep, $line;
  }
  close $in;
  open(my $out, '>:utf8', "$file.priv") or exit 0;
  print $out @keep;
  close $out;
  rename "$file.priv", $file;
} else {
  die "usage: privacy.pl names|filter|content <path>|prune-index <tsv>\n";
}
