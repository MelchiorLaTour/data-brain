#!/usr/bin/env python3
"""Render the maintained DataBrain setup HTML guides to searchable PDFs.

This dependency-free renderer supports the small, semantic HTML subset used by
the guides. It deliberately requires an explicit output path.
"""

from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import unicodedata


class Node:
    def __init__(self, tag, attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []


class GuideParser(HTMLParser):
    VOID = {"br", "img", "meta", "link", "hr", "input"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]
        self.in_head = False

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
            return
        if self.in_head:
            return
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False
            return
        if self.in_head:
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.in_head and data:
            self.stack[-1].children.append(data)


def ascii_text(value):
    replacements = {
        "→": " -> ", "←": " <- ", "·": " / ", "•": "-",
        "—": "-", "–": "-", "…": "...", "“": '"', "”": '"',
        "‘": "'", "’": "'", " ": " ",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    # PDF's built-in Helvetica uses WinAnsi. Reject characters outside that
    # encoding instead of silently emitting a missing-glyph replacement.
    value.encode("cp1252", errors="strict")
    return value


def inline_runs(node, href=None):
    if isinstance(node, str):
        value = ascii_text(node)
        return [(value, href)] if value else []
    own_href = node.attrs.get("href") if node.tag == "a" else href
    if node.tag == "br":
        return [("\n", None)]
    result = []
    for child in node.children:
        result.extend(inline_runs(child, own_href))
    if node.tag == "q" and result:
        if len(result) == 1:
            text, target = result[0]
            return [(f'"{text}"', target)]
        first_text, first_target = result[0]
        last_text, last_target = result[-1]
        result[0] = (f'"{first_text}', first_target)
        result[-1] = (f'{last_text}"', last_target)
    if node.tag == "a" and own_href and "__VERIFIED_" in own_href:
        result.append((f" [{own_href}]", None))
    return result


def gather_blocks(node, result):
    """Collect only semantic blocks; recurse through layout-only containers."""
    for child in node.children:
        if isinstance(child, str):
            continue
        if child.tag in {"h1", "h2", "h3", "p", "pre"}:
            result.append((child.tag, inline_runs(child)))
        elif child.tag in {"ul", "ol"}:
            for number, item in enumerate(
                (part for part in child.children
                 if isinstance(part, Node) and part.tag == "li"), 1
            ):
                result.append(("li", [(f"{number}. " if child.tag == "ol" else "- ", None)]
                               + inline_runs(item)))
        else:
            inline_tags = {"a", "strong", "b", "em", "i", "q", "code", "span"}
            if child.children and all(
                isinstance(part, str) or
                isinstance(part, Node) and part.tag in inline_tags
                for part in child.children
            ):
                result.append(("p", inline_runs(child)))
            else:
                gather_blocks(child, result)


def width(text, size, mono=False):
    # Adobe's standard Helvetica widths in 1/1000 em; Courier is fixed-width.
    if mono:
        return len(text) * size * 0.60
    metrics = {
        " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889,
        "&": 667, "'": 191, "(": 333, ")": 333, "*": 389, "+": 584,
        ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278,
        "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015, "[": 278,
        "\\": 278, "]": 278, "^": 469, "_": 556, "`": 333, "{": 334,
        "|": 260, "}": 334, "~": 584,
    }
    upper = [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
             833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
             667, 611]
    lower = [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222,
             833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500,
             500, 500]
    for i, ch in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
        metrics[ch] = upper[i]
    for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz"):
        metrics[ch] = lower[i]
    for ch in "0123456789":
        metrics[ch] = 556
    return sum(size * metrics.get(c, 556) / 1000 for c in text)


def wrapped_lines(runs, max_width, size, mono=False):
    lines = []
    current, current_width = [], 0.0
    pending_space = False
    for text, href in runs:
        chunks = re.findall(r"\n|[^\s]+|\s+", text)
        for chunk in chunks:
            if chunk == "\n":
                lines.append(current)
                current, current_width = [], 0.0
                pending_space = False
                continue
            if chunk.isspace():
                pending_space = True
                continue
            word = chunk
            gap = " " if current and pending_space else ""
            pending_space = False
            piece_width = width(gap + word, size, mono)
            if current and current_width + piece_width > max_width:
                lines.append(current)
                current, current_width = [], 0.0
                gap = ""
                piece_width = width(word, size, mono)
            # Long paths/tokens are split so they cannot run off the page.
            if piece_width > max_width:
                if current:
                    lines.append(current)
                    current, current_width = [], 0.0
                pieces, piece = [], ""
                for char in word:
                    if piece and width(piece + char, size, mono) > max_width:
                        pieces.append(piece)
                        piece = ""
                    piece += char
                if piece:
                    pieces.append(piece)
                for segment in pieces[:-1]:
                    lines.append([(segment, href)])
                word = pieces[-1]
                piece_width = width(word, size, mono)
                gap = ""
            current.append((gap + word, href))
            current_width += piece_width
    if current or not lines:
        lines.append(current)
    return lines


def pdf_string(value):
    return "<" + value.encode("cp1252").hex().upper() + ">"


def pdf_color(value):
    return " ".join(f"{int(value[i:i + 2], 16) / 255:.3f}" for i in (0, 2, 4))


class Layout:
    W, H = 612, 792
    LEFT, RIGHT, TOP, BOTTOM = 54, 558, 744, 38
    WHITE = "FFFFFF"
    MUTED = "A8B5BC"
    TEAL = "55CFC4"

    def __init__(self):
        self.pages = []
        self.new_page()

    def new_page(self):
        self.ops, self.links = [], []
        self.y = self.TOP
        self.pages.append((self.ops, self.links))

    def ensure(self, height):
        if self.y - height < self.BOTTOM:
            self.new_page()

    def paragraph(self, runs, size, leading, color="FFFFFF", mono=False,
                  indent=0, gap=7, bold=False):
        # PDF font widths can be slightly wider than the Helvetica metrics
        # table above; keep a small safety margin so rendered words never
        # touch or cross the page's right text boundary.
        lines = wrapped_lines(runs, self.RIGHT - self.LEFT - indent - 24,
                              size, mono=mono)
        self.ensure(len(lines) * leading + gap)
        for line in lines:
            x = self.LEFT + indent
            line_text = "".join(text for text, _ in line)
            has_link = any(href for _, href in line)
            ink = self.TEAL if has_link else color
            font = "F2" if bold else "F3" if mono else "F1"
            self.ops.append(
                f"BT /{font} {size:.2f} Tf {pdf_color(ink)} rg 1 0 0 1 {x:.2f} {self.y:.2f} Tm "
                f"{pdf_string(line_text)} Tj ET"
            )
            for text, href in line:
                span = width(text, size, mono)
                if href:
                    self.links.append((x - 1, self.y - 2, x + span + 1,
                                       self.y + size + 2, href))
                x += span
            self.y -= leading
        self.y -= gap

    def render(self, kind, runs):
        plain = "".join(text for text, _ in runs).strip()
        if kind == "h1":
            self.y -= 4
            self.paragraph(runs, 23, 26, color=self.WHITE, gap=8, bold=True)
            self.ops.append(f"{pdf_color(self.TEAL)} rg {self.LEFT} {self.y:.2f} 58 2 re f")
            self.y -= 8
        elif kind in {"h2", "h3"}:
            self.y -= 4
            self.paragraph(runs, 14 if kind == "h2" else 11.5,
                           16 if kind == "h2" else 13,
                           color=self.TEAL, gap=3, bold=True)
        elif kind == "pre":
            self.paragraph(runs, 8.5, 11, color=self.MUTED, mono=True,
                           indent=7, gap=5)
        elif kind == "li":
            self.paragraph(runs, 9.6, 13, color=self.MUTED, indent=9, gap=2)
        else:
            self.paragraph(runs, 9.6, 13, color=self.WHITE, gap=5)

    def pdf(self):
        # Fixed font objects occupy IDs 3-6; page/content/annotation objects
        # are allocated after them so all links remain valid PDF annotations.
        objects = [None, b"<< /Type /Catalog /Pages 2 0 R >>", None]
        page_data = []
        for ops, links in self.pages:
            body = ["q 0 0 0 rg 0 0 612 792 re f Q",
                    f"q {pdf_color(self.TEAL)} rg 0 0 5 792 re f Q",
                    *ops]
            page_data.append(("\n".join(body).encode("ascii"), links))
        next_id = 7
        refs = []
        for _, links in page_data:
            refs.append(next_id)
            next_id += 2 + len(links)
        objects[2] = (f"<< /Type /Pages /Count {len(refs)} /Kids [" +
                      " ".join(f"{ref} 0 R" for ref in refs) + "] >>").encode()
        fonts = ["Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"]
        for font in fonts:
            objects.append(f"<< /Type /Font /Subtype /Type1 /BaseFont /{font} /Encoding /WinAnsiEncoding >>".encode())
        for (stream, links), page_id in zip(page_data, refs):
            stream_id = page_id + 1
            annots = [stream_id + 1 + i for i in range(len(links))]
            annots_part = (" /Annots [" + " ".join(f"{n} 0 R" for n in annots) + "]") if annots else ""
            last_id = annots[-1] if annots else stream_id
            while len(objects) <= last_id:
                objects.append(None)
            objects[page_id] = (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> "
                f"/Contents {stream_id} 0 R{annots_part} >>"
            ).encode()
            objects[stream_id] = f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"
            for annot_id, (x0, y0, x1, y1, href) in zip(annots, links):
                uri = href.encode("cp1252").hex().upper()
                objects[annot_id] = (
                    f"<< /Type /Annot /Subtype /Link /Rect [{x0:.2f} {y0:.2f} {x1:.2f} {y1:.2f}] "
                    f"/Border [0 0 0] /A << /S /URI /URI <{uri}> >> >>"
                ).encode()
        # Drop only trailing allocation placeholders; all populated objects
        # must remain contiguous for a conventional xref table.
        if any(item is None for item in objects[1:]):
            raise RuntimeError("internal PDF object allocation gap")
        data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for number, body in enumerate(objects[1:], 1):
            offsets.append(len(data))
            data.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
        xref = len(data)
        data.extend(f"xref\n0 {len(objects)}\n0000000000 65535 f \n".encode())
        for offset in offsets[1:]:
            data.extend(f"{offset:010d} 00000 n \n".encode())
        data.extend(f"trailer\n<< /Size {len(objects)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        return bytes(data)


def render(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output:
        raise ValueError("output must not replace the HTML source")
    if not source.is_file() or not output.parent.is_dir():
        raise ValueError("input must exist and output parent directory must already exist")
    parser = GuideParser()
    parser.feed(source.read_text(encoding="utf-8"))
    blocks = []
    gather_blocks(parser.root, blocks)
    layout = Layout()
    for kind, runs in blocks:
        layout.render(kind, runs)
    output.write_bytes(layout.pdf())
    return len(layout.pages)


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: render-guides.py INPUT.html OUTPUT.pdf")
    try:
        count = render(argv[1], argv[2])
    except (OSError, UnicodeError, ValueError, RuntimeError) as exc:
        raise SystemExit(f"render-guides: {exc}") from exc
    print(f"Rendered {count} page(s): {argv[2]}")


if __name__ == "__main__":
    main(sys.argv)
