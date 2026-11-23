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
use File::Basename qw(dirname basename);
use File::Temp qw(tempfile);

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
  'tax(?:es)?', 'tax return', 'w 2 (?:form|wages?|statement|tax|(?:19|20)\\d\\d)', 'form w 2', '1099 (?:form|nec|misc|int|div)', 'form 1099', 'bank', 'banking', 'bank statement', 'iban', 'swift', 'passport',
  'driver s licen[sc]e', 'driving licen[sc]e', 'social security', 'ssn', 'id card', 'identity card', 'medical', 'prescriptions?',
  'pay ?slips?', 'pay ?stubs?', 'payroll', 'salary', 'salaries', 'doctors?', 'doctor s? notes?', 'sick ?notes?', 'passwords?', 'credentials?', 'secrets?', 'private key',
  'seed phrase', 'recovery phrase', 'wallet', 'contracts?', 'lease', 'mortgage', 'insurance',
  'impots?', 'avis d imposition', 'declaration de revenus', 'releve bancaire', 'releve de compte', 'rib', 'banque', 'bancaire',
  'passeport', 'carte d identite', 'carte vitale', 'secu', 'securite sociale', 'mutuelle', 'ordonnances?', 'medecins?', 'arrets? maladie',
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

# Spaces, hyphens, underscores and dots all become one space, so "Pay slip", "pay-slip" and "pay_slip" read the same; the
# word list spells the compound ones with an optional space ('pay ?slips?') so "payslip" matches too.
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

sub card_shape {
  my ($d) = @_;
  my $n = length $d;
  return 1 if $d =~ /^4/ && ($n == 13 || $n == 16 || $n == 19);
  return 1 if $n == 16 && $d =~ /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/;
  return 1 if $n == 15 && $d =~ /^3[47]/;
  return 1 if $n == 16 && $d =~ /^(?:6011|65)/;
  return 0;
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

# The whole text is screened, in windows of 400000 characters that overlap by 10000 (so a number cut by a window edge is still seen):
# databrain_read can reach the end of a long file, so text past the first window must not escape the screen.
# Part 16: the lists behind the "several signs together" rule (accent-folded, lower case, matched as whole words).
our $STATEMENT_WORDS = join '|', 'statements?', 'checking', 'savings', 'balances?', 'deposits?', 'withdrawals?', 'debits?', 'overdrafts?', 'transactions?', 'routing', 'releves?', 'solde', 'virements?', 'decouverts?', 'prelevements?';
our $BANK_NAMES = join '|', 'chase', 'jpmorgan', 'bank of america', 'wells fargo', 'citibank', 'capital one', 'us bank', 'u\.s\. bank', 'pnc', 'td bank', 'hsbc', 'barclays', 'lloyds', 'natwest', 'monzo', 'santander', 'revolut', 'n26', 'ally bank', 'discover bank', 'charles schwab', 'bnp', 'bnp paribas', 'societe generale', 'credit agricole', 'credit mutuel', 'caisse d epargne', 'la banque postale', 'lcl', 'boursorama', 'deutsche bank', 'credit suisse', 'ubs';

sub content_reason {
  my ($text) = @_;
  $text = decode('UTF-8', $text, Encode::FB_DEFAULT) unless utf8::is_utf8($text);
  for (my $at = 0; $at == 0 || $at < length($text); $at += 390000) {
    my $why = content_reason_window(substr($text, $at, 400000));
    return $why if $why;
  }
  return '';
}

sub content_reason_window {
  my ($text) = @_;
  return 'contains a private key' if $text =~ /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
  while ($text =~ /\b([A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,4})?)\b/g) {
    return 'contains an IBAN' if iban_ok($1);
  }
  # A card is held only when it has a real card layout (Visa, Mastercard, Amex, Discover), passes Luhn, AND a card word sits within
  # about 80 characters. Long digit tables pass Luhn by chance one time in ten; without the card word they are just data.
  while ($text =~ /(?<![\d-])((?:\d[ -]?){13,19})(?![\d-])/g) {
    my ($from, $to) = ($-[1], $+[1]);
    (my $d = $1) =~ s/\D//g;
    next unless card_shape($d) && luhn_ok($d);
    my $near = substr($text, $from > 80 ? $from - 80 : 0, ($from > 80 ? 80 : $from) + ($to - $from) + 80);
    return 'contains a card number' if $near =~ /(?<![a-z0-9])(?:cards?|cartes?|visa|master ?card|amex|american express|cb|cvv2?|cvc2?|exp|expiry|expires?|expiration)(?![a-z0-9])/i;
  }
  while ($text =~ /\b([12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2]|[2-9]\d)[ ]?(?:\d{2}|2[AaBb])[ ]?\d{3}[ ]?\d{3}[ ]?\d{2})\b/g) {
    return 'contains a French social security number' if nir_ok($1);
  }
  my $f = fold($text);
  # a password-style label followed by a value on the same line: "password: x", "mot de passe = x", "password is x1", "code wifi 12345678".
  # A note that only talks about passwords has no value after the label and is not held.
  my $label = qr/(?:password|passcode|passwd|mot de passe|mdp|code wifi|wifi code)/;
  # Short account labels count too: "pass: x", "pwd = x", "login: x", "username: x", "identifiant: x", "user id: x", "pin: 4821", "code: x", "temporary pass: x".
  my $wide = qr/(?:pass|pwd|pin|code|login|username|identifiant|user ?id|temporary pass(?:word)?|temp pass(?:word)?)/;
  my @lines = split /\n/, $f;
  for my $line (@lines) {
    return 'contains a password' if $line =~ /\b$label[ \t]*[:=][ \t]*[^\s]*[a-z0-9]\S*/
      || $line =~ /\b$label[ \t]+(?:is|est|-)[ \t]+\S*\d\S*/
      || $line =~ /\b(?:code wifi|wifi code)[ \t]+\S*\d\S*/
      || $line =~ /\b$wide[ \t]*[:=][ \t]*[^\s]*[a-z0-9]\S*/
      || $line =~ /\b$wide[ \t]+(?:is|est)[ \t]+\S*\d\S*/
      || $line =~ /\bpin[ \t]+\d{4,8}\b/;
  }
  # An email address with a short letters-and-digits token (like "c014d1") within 3 lines is a login pair: held. Wide on purpose, so order
  # numbers or ticket codes next to an email are held too (a held file can be released by the user).
  for my $i (0 .. $#lines) {
    (my $bare = $lines[$i]) =~ s/\bhttps?:\/\/\S+//g;
    next unless $bare =~ /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
    my $lo = $i > 3 ? $i - 3 : 0; my $hi = $i + 3 > $#lines ? $#lines : $i + 3;
    for my $j ($lo .. $hi) {
      (my $other = $lines[$j]) =~ s/\bhttps?:\/\/\S+//g;
      $other =~ s/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ /g;
      return 'contains a password' if $other =~ /(?<![a-z0-9])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,16}(?![a-z0-9])/;
    }
  }
  # Part 16b: secrets that must never reach a model. Each rule below holds the file on its own (the file is held for the user's review, never
  # excluded automatically). $f is lower case with accents removed. Labels are English and French.
  # 1. a password-like word followed by "is"/"was"/"est" and a value ("the wifi password is sunshine"), unless the next word only talks ABOUT passwords
  if ($f =~ /\b(?:password|passcode|passphrase|pass phrase|passwd|pw|pwd|pin|mot de passe|mdp|code pin|mot de passe wifi|cle wifi)[ \t]+(?:is|was|est|etait|=)[ \t]+(\S+)/) {
    my $word = $1; $word =~ s/[^a-z0-9]+$//;
    return 'contains a password' unless $word =~ /\A(?:required|too|not|invalid|incorrect|wrong|stored|hashed|encrypted|case|sensitive|expired|changed|reset|saved|set|used|a|an|the|your|my|empty|blank|missing|valid|weak|strong|long|short|secure|safe|private|hidden|shown|visible|obligatoire|trop|invalide|incorrect|faux|stocke|chiffre|expire|change|vide|un|une|le|la|votre|mon|ma)\z/;
  }
  # 2. short and long password labels with a value: pw, passphrase, secret, api key, token, client secret, access key ... (value of 6+ characters, no spaces
  #    needed for a key; a passphrase may be several words)
  for my $line (@lines) {
    return 'contains a password' if $line =~ /\b(?:pw|pwd|passphrase|pass phrase|passcode|passwd|mot de passe|mdp|phrase secrete|phrase de passe|code secret|code d acces)[ \t]*[:=][ \t]*\S{3,}/;
    return 'contains an access key or token' if $line =~ /\b(?:api[ _-]?key|apikey|api[ _-]?secret|secret[ _-]?key|client[ _-]?secret|access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer[ _-]?token|private[ _-]?token|token|cle api|cle secrete|jeton)[ \t]*[:=][ \t]*["']?[a-z0-9_\-\.\/+=]{8,}/;
  }
  # 3. well-known token shapes, with or without a label (matched on the original text, case kept)
  return 'contains an access key or token'
    if $text =~ /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ || $text =~ /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ || $text =~ /\bgithub_pat_[A-Za-z0-9_]{20,}\b/
    || $text =~ /\bsk-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_\-]{16,}\b/ || $text =~ /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/ || $text =~ /\bAIza[0-9A-Za-z_\-]{30,}\b/
    || $text =~ /\bglpat-[A-Za-z0-9_\-]{16,}\b/ || $text =~ /\bnpm_[A-Za-z0-9]{30,}\b/
    || $text =~ /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{5,}/ || $text =~ /\bBearer[ \t]+[A-Za-z0-9._~+\/\-]{20,}=*/;
  # 4. a recovery (seed) phrase: its label, then a colon or an equals sign, then 12 or more short lower-case words in a row
  return 'contains a recovery phrase'
    if $f =~ /\b(?:seed phrase|seed words|recovery phrase|recovery words|mnemonic|secret recovery phrase|phrase de recuperation|phrase secrete|mots de recuperation)[ \t]*[:=][ \t]*\n?[ \t]*(?:\d{1,2}[.)]?[ \t]*)?(?:[a-z]{3,8}(?:[ \t,\n]+(?:\d{1,2}[.)]?[ \t]*)?|\z)){11,}[a-z]{3,8}\b/;
  # 5. US social security number with its label
  return 'contains a social security number'
    if $f =~ /\b(?:ssn|social security(?: number| no\.?)?|numero de securite sociale|n° de securite sociale|numero de secu)\W{0,12}\d{3}[ -]?\d{2}[ -]?\d{4}\b/;
  # 6. passport, driving licence and ID numbers with their label (an optional "number" word between the label and the value)
  return 'contains a passport or ID number'
    if $f =~ /\b(?:passport|passeport|driver'?s? licen[sc]e|driving licen[sc]e|permis de conduire|id number|identity card|carte d identite|national id|numero de piece)(?:[ \t]+(?:number|no\.?|num|numero|n°|#))?[^a-z0-9]{0,25}(?=[a-z0-9]*\d)[a-z0-9]{6,12}\b/;
  # 7. a bank account or routing number with its label: ONE sign is enough
  return 'contains an account or routing number'
    if $f =~ /\b(?:account|acct|compte|routing|aba|rib)[ \t]*(?:number|no\.?|num(?:ber|ero)?|#|n°)?[ \t]*[:=#]?[ \t]*\d[\d -]{6,}\d/;
  # 8. answers to security questions
  return 'contains security answers'
    if $f =~ /\b(?:security|secret|verification)[ \t]+(?:question[ \t]+)?answers?[ \t]*[:=][ \t]*\S{2,}/
    || ($f =~ /\b(?:security|secret|verification) questions?|question (?:secrete|de securite)/ && $f =~ /\b(?:answer|reponse)[ \t]*[:=][ \t]*\S{2,}/);
  # 9. two-factor backup or recovery codes: the label, then at least two code-like groups
  return 'contains backup codes'
    if $f =~ /\b(?:(?:backup|recovery|reset|2fa|one-time|otp|emergency)[ \t]+codes?|codes?[ \t]+de[ \t]+(?:secours|recuperation|sauvegarde))[ \t]*[:=][ \t]*\n?[ \t]*(?=[a-z0-9 \t,\n-]{0,200}\d)[a-z0-9]{4,10}(?:[ \t,\n-]+[a-z0-9]{4,10}){1,}/;
  # Part 16: bank-statement and login SHAPES, held for the user's review (never excluded on their own). Several signs must appear TOGETHER; one sign alone
  # is never enough, so a note that only mentions a bank, or a budget note with a few money words, stays searchable.
  #   sign 1: an account or routing number with its label, or a masked card/account ending (xxxx1234)
  #   sign 2: a bank name AND at least 2 distinct statement words
  #   +1 more sign when the statement shape is strong: at least 2 bank-name mentions AND at least 4 distinct statement words
  #   sign 3: login fields: a user label AND a password label (a value is not needed)
  # Held when 2 or more signs. The word and bank lists are here so they can be reviewed: STATEMENT_WORDS, BANK_NAMES.
  {
    my $signs = 0;
    $signs++ if $f =~ /(?:x{3,}|\*{3,}|\x{2022}{3,})\s?\d{4}\b/;   # a masked ending (xxxx1234); a labelled account or routing number holds on its own (rule 7 above)
    my %stmt; while ($f =~ /\b($STATEMENT_WORDS)\b/g) { (my $word = $1) =~ s/s$//; $stmt{$word} = 1; }   # statement and statements are one word
    my $banks = () = $f =~ /\b(?:$BANK_NAMES)\b/g;
    $signs++ if $banks >= 1 && keys(%stmt) >= 2;
    $signs++ if $banks >= 2 && keys(%stmt) >= 4;
    $signs++ if $f =~ /\b(?:user ?name|login|e-?mail|identifiant|user ?id)\s*[:=]/ && $f =~ /\b(?:password|passcode|passwd|mot de passe)\s*[:=]/;
    return 'looks like a bank statement or login details (several signs together)' if $signs >= 2;
  }
  return 'contains a passport or ID number'
    if $f =~ /(?:passport|passeport|id number|identity card|carte d identite|national id|numero de piece)[^a-z0-9]{0,25}(?=[a-z0-9]*\d)[a-z0-9]{6,9}\b/;
  return '';
}

# --- held list ---
my %status; my %reason;
sub load_priv {
  return unless $PRIV;
  my @st = stat($PRIV);
  return if !@st && $!{ENOENT};
  die "privacy: cannot read $PRIV: $!\n" unless @st;
  open(my $fh, '<:utf8', $PRIV) or die "privacy: cannot read $PRIV: $!\n";
  $! = 0;
  while (defined(my $line = <$fh>)) {
    chomp $line;
    next unless length $line;
    my ($s, $p, $r) = split /\t/, $line, 3;
    die "privacy: malformed held list $PRIV\n"
      unless defined $s && $s =~ /\A(?:held|excluded|allowed)\z/ && defined $p && length $p;
    $status{$p} = $s; $reason{$p} = $r // '';
  }
  die "privacy: cannot read $PRIV: $!\n" if $!;
  close $fh or die "privacy: cannot close $PRIV: $!\n";
}
sub hold {
  my ($path, $why) = @_;
  return unless $PRIV;
  open(my $fh, '>>:utf8', $PRIV) or die "privacy: cannot write $PRIV\n";
  print {$fh} "held\t$path\t$why\n" or die "privacy: cannot write $PRIV: $!\n";
  close $fh or die "privacy: cannot close $PRIV: $!\n";
  $status{$path} = 'held';
}
sub dropped { my ($p) = @_; my $s = $status{$p} // ''; return $s eq 'held' || $s eq 'excluded'; }
sub is_text { my ($p) = @_; return $p =~ /\.(?:md|markdown|txt)$/i; }
sub slurp {
  my ($p) = @_;
  open(my $fh, '<:raw', $p) or die "privacy: cannot read $p: $!\n";
  my $n = read($fh, my $buf, 33554432);   # as much as databrain_read can load (32 MB)
  die "privacy: cannot read $p: $!\n" unless defined $n;
  close $fh or die "privacy: cannot close $p: $!\n";
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
      if (!$why && is_text($p)) {
        if (!-r $line) {
          warn "privacy: unreadable text source; content screening deferred, metadata only\n";
          print "$p\n";
          next;
        }
        $why = content_reason(slurp($line));
      }
      if ($why) { hold($p, $why); next; }
    }
    print "$p\n";
  }
} elsif ($mode eq 'content') {
  my $path = decode('UTF-8', shift(@ARGV) // '', Encode::FB_DEFAULT);
  local $/;
  $! = 0;
  my $text = <STDIN>;
  die "privacy: cannot read screened content: $!\n" if $!;
  $text //= '';
  exit 0 if !$PRIV || ($status{$path} // '') eq 'allowed';
  my $why = content_reason($text);
  if ($why) { hold($path, $why); print "$why\n"; }
} elsif ($mode eq 'prune-index') {
  my $file = shift @ARGV // '';
  exit 0 unless $PRIV;
  die "privacy: index file is missing or not a regular file: $file\n" unless -f $file;
  my @file_stat = stat($file);
  die "privacy: cannot stat $file: $!\n" unless @file_stat;
  my $home = $ENV{HOME} // '';
  open(my $in, '<:utf8', $file) or die "privacy: cannot read $file: $!\n";
  my ($out, $tmp);
  my $ok = eval {
    my $dir = dirname($file);
    my $base = basename($file);
    ($out, $tmp) = tempfile("$base.priv.XXXXXXXX", DIR => $dir, UNLINK => 0);
    chmod($file_stat[2] & 07777, $tmp) or die "privacy: cannot set permissions on $tmp: $!\n";
    binmode($out, ':utf8') or die "privacy: cannot write $tmp: $!\n";
    $! = 0;
    while (defined(my $line = <$in>)) {
      my ($p) = split /\t/, $line, 2;
      if (defined $p && $p !~ /^#/) { (my $abs = $p) =~ s/^~/$home/; next if dropped($abs); }
      print {$out} $line or die "privacy: cannot write $tmp: $!\n";
    }
    die "privacy: cannot read $file: $!\n" if $!;
    close $in or die "privacy: cannot close $file: $!\n";
    close $out or die "privacy: cannot close $tmp: $!\n";
    rename $tmp, $file or die "privacy: cannot replace $file: $!\n";
    undef $tmp;
    1;
  };
  if (!$ok) {
    my $err = $@ || "privacy: failed to prune $file\n";
    close $out if $out;
    close $in if $in;
    unlink $tmp if defined $tmp;
    die $err;
  }
} else {
  die "usage: privacy.pl names|filter|content <path>|prune-index <tsv>\n";
}
