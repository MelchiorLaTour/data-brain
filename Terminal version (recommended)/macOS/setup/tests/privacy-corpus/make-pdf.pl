#!/usr/bin/perl
# Part 40 corpus helper: turn a UTF-8 text file into a small PDF shaped like a Google Docs export (Producer "Skia/PDF m131 Google Docs Renderer",
# a Title, Helvetica, lines wrapped at 90 characters, 48 lines a page). Usage: make-pdf.pl in.txt out.pdf
use strict; use warnings;
use Encode qw(decode encode);
my ($in, $out) = @ARGV;
die "usage: make-pdf.pl in.txt out.pdf\n" unless $in && $out;
open(my $fh, '<:raw', $in) or die "cannot read $in\n";
my @src = split /\n/, decode('UTF-8', do { local $/; <$fh> });
close $fh;
my @lines;
for my $line (@src) {
  my $rest = $line;
  while (length $rest > 90) { my $cut = rindex($rest, ' ', 90); $cut = 90 if $cut < 20; push @lines, substr($rest, 0, $cut); $rest = substr($rest, $cut); $rest =~ s/^ //; }
  push @lines, $rest;
}
my $title = $src[0] // 'Untitled document'; $title =~ s/^#+\s*//;
sub pdfstr { my ($s) = @_; my $b = encode('cp1252', $s, sub { '?' }); $b =~ s/([\\()])/\\$1/g; return "($b)"; }
my @pages;
while (@lines) { push @pages, [splice(@lines, 0, 48)]; }
@pages = ([]) unless @pages;
my @obj;   # object bodies, numbered from 1
push @obj, '<< /Type /Catalog /Pages 2 0 R >>';
push @obj, 'PAGES';
push @obj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
push @obj, '<< /Producer (Skia/PDF m131 Google Docs Renderer) /Title ' . pdfstr($title) . ' /Creator (Google Docs) >>';
my @kids;
for my $page (@pages) {
  my $stream = "BT /F1 10 Tf 14 TL 56 790 Td\n" . join('', map { pdfstr($_) . " Tj T*\n" } @$page) . "ET\n";
  push @obj, '<< /Length ' . length($stream) . " >>\nstream\n$stream" . "endstream";
  my $content = scalar @obj;
  push @obj, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents $content 0 R >>";
  push @kids, scalar(@obj) . ' 0 R';
}
$obj[1] = '<< /Type /Pages /Kids [' . join(' ', @kids) . '] /Count ' . scalar(@kids) . ' >>';
my $pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
my @off;
for my $i (0 .. $#obj) { push @off, length $pdf; $pdf .= ($i + 1) . " 0 obj\n$obj[$i]\nendobj\n"; }
my $xref = length $pdf;
$pdf .= "xref\n0 " . (@obj + 1) . "\n0000000000 65535 f \n" . join('', map { sprintf("%010d 00000 n \n", $_) } @off);
$pdf .= "trailer\n<< /Size " . (@obj + 1) . " /Root 1 0 R /Info 4 0 R >>\nstartxref\n$xref\n%%EOF\n";
open(my $o, '>:raw', $out) or die "cannot write $out\n";
print {$o} $pdf; close $o or die "cannot write $out\n";
