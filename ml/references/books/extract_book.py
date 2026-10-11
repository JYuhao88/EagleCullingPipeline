#!/usr/bin/env python3
"""Read a local EPUB/PDF without modifying it; keep extracted text outside git.

Usage: python ml/references/books/extract_book.py BOOK --slug my-book
PDF support: python -m pip install pypdf  (or pdfplumber)
"""

import argparse
import importlib
import json
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import unicodedata
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile


class BookExtractionError(ValueError):
    """An actionable input or dependency error."""


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def archive_path(base, href):
    """Resolve an EPUB resource, rejecting paths outside the archive."""
    url = urlsplit(href)
    if url.scheme or url.netloc:
        raise BookExtractionError("EPUB contains a non-local resource: " + href)
    path = unquote(url.path)
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(base), path))
    if path.startswith("/") or resolved == ".." or resolved.startswith("../"):
        raise BookExtractionError("EPUB resource escapes the archive: " + href)
    return resolved


class TextParser(HTMLParser):
    BLOCKS = {"p", "div", "section", "article", "li", "blockquote", "br", "hr",
              "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre"}
    SUPPRESSED = {"script", "style", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.suppressed = 0
        self.heading = None
        self.headings = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SUPPRESSED:
            self.suppressed += 1
        if self.suppressed:
            return
        if tag in self.BLOCKS:
            self.parts.append("\n")
        if tag in {"h1", "h2", "h3"}:
            self.heading = []

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.SUPPRESSED:
            self.suppressed = max(0, self.suppressed - 1)
            return
        if self.suppressed:
            return
        if tag in {"h1", "h2", "h3"} and self.heading is not None:
            heading = "".join(self.heading).strip()
            if heading:
                self.headings.append(heading)
            self.heading = None
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(data)
            if self.heading is not None:
                self.heading.append(data)

    @property
    def text(self):
        lines = [re.sub(r"\s+", " ", line).strip()
                 for line in "".join(self.parts).splitlines()]
        return "\n".join(line for line in lines if line)


def read_xml(archive, path):
    try:
        return ET.fromstring(archive.read(path))
    except (KeyError, ET.ParseError) as exc:
        raise BookExtractionError(f"Invalid or missing EPUB XML resource: {path}") from exc


def extract_epub(source):
    with zipfile.ZipFile(source) as archive:
        container = read_xml(archive, "META-INF/container.xml")
        rootfiles = [node for node in container.iter() if local_name(node.tag) == "rootfile"]
        if not rootfiles:
            raise BookExtractionError("EPUB container has no package rootfile")
        package_path = archive_path("", rootfiles[0].get("full-path", ""))
        package = read_xml(archive, package_path)
        manifest = {}
        metadata = {}
        spine = None
        for node in package:
            kind = local_name(node.tag)
            if kind == "metadata":
                for child in node:
                    name = local_name(child.tag)
                    if name in {"title", "creator"} and name not in metadata:
                        metadata[name] = "".join(child.itertext()).strip()
            elif kind == "manifest":
                manifest = {child.get("id"): child.attrib for child in node}
            elif kind == "spine":
                spine = node
        if spine is None:
            raise BookExtractionError("EPUB package has no reading-order spine")

        titles = {}
        # EPUB 3 navigation and EPUB 2 NCX both provide human-readable titles.
        for item in manifest.values():
            is_nav = "nav" in item.get("properties", "").split()
            is_ncx = item.get("media-type") == "application/x-dtbncx+xml"
            if not (is_nav or is_ncx):
                continue
            nav_path = archive_path(package_path, item.get("href", ""))
            nav = read_xml(archive, nav_path)
            if is_nav:
                for node in nav.iter():
                    if local_name(node.tag) != "nav":
                        continue
                    nav_type = node.get("{http://www.idpf.org/2007/ops}type", "")
                    if nav_type and "toc" not in nav_type.split():
                        continue
                    for link in node.iter():
                        if local_name(link.tag) == "a" and link.get("href"):
                            path = archive_path(nav_path, link.get("href"))
                            titles.setdefault(path, "".join(link.itertext()).strip())
            else:
                for point in nav.iter():
                    if local_name(point.tag) != "navPoint":
                        continue
                    label = next((child for child in point if local_name(child.tag) == "navLabel"), None)
                    content = next((child for child in point if local_name(child.tag) == "content"), None)
                    if label is not None and content is not None and content.get("src"):
                        path = archive_path(nav_path, content.get("src"))
                        titles.setdefault(path, "".join(label.itertext()).strip())

        chapters = []
        for ref in spine:
            if ref.get("linear", "yes") == "no":
                continue
            item = manifest.get(ref.get("idref"))
            if item is None:
                raise BookExtractionError("EPUB spine references an unknown manifest item")
            if item.get("media-type") not in {"application/xhtml+xml", "text/html"}:
                continue
            path = archive_path(package_path, item.get("href", ""))
            parser = TextParser()
            try:
                content = archive.read(path)
            except KeyError as exc:
                raise BookExtractionError(f"Missing EPUB chapter resource: {path}") from exc
            parser.feed(content.decode("utf-8-sig"))
            if not parser.text:
                continue
            title = titles.get(path) or next(iter(parser.headings), PurePosixPath(path).stem)
            chapters.append({"title": title, "text": parser.text, "resource": path})
        return metadata.get("title", source.stem), metadata.get("creator", ""), chapters


def extract_pdf(source):
    try:
        pypdf = importlib.import_module("pypdf")
    except ImportError:
        pypdf = None
    if pypdf is not None:
        reader = pypdf.PdfReader(str(source))
        if reader.is_encrypted and not reader.decrypt(""):
            raise BookExtractionError("PDF is encrypted; supply a readable, unlocked local copy")
        metadata = reader.metadata or {}
        title = metadata.get("/Title") or source.stem
        author = metadata.get("/Author") or ""
        pages = [page.extract_text() or "" for page in reader.pages]
    else:
        try:
            pdfplumber = importlib.import_module("pdfplumber")
        except ImportError as exc:
            raise BookExtractionError(
                "PDF extraction needs an optional dependency. Install with: "
                "python -m pip install pypdf (or python -m pip install pdfplumber)"
            ) from exc
        with pdfplumber.open(str(source)) as pdf:
            metadata = pdf.metadata or {}
            title = metadata.get("Title") or source.stem
            author = metadata.get("Author") or ""
            pages = [page.extract_text() or "" for page in pdf.pages]
    chapters = [{"title": f"Page {number}", "page": number,
                 "text": f"[p.{number}]\n{text}"}
                for number, text in enumerate(pages, 1)]
    return title, author, chapters


def safe_slug(value):
    if not value or value in {".", ".."} or not re.fullmatch(r"[\w-]+", value):
        raise BookExtractionError("Slug must contain only letters, numbers, underscores or hyphens")
    return value


def extract_book(source, slug=None, output_dir="/tmp/books"):
    source = Path(source).expanduser().resolve()
    if not source.is_file():
        raise BookExtractionError(f"Book does not exist: {source}")
    extension = source.suffix.lower()
    if extension not in {".epub", ".pdf"}:
        raise BookExtractionError("Supported book formats: .epub and .pdf")
    if slug is None:
        slug = re.sub(r"[^\w-]+", "-", unicodedata.normalize("NFKC", source.stem)).strip("-")
    slug = safe_slug(slug)
    title, author, chapters = (extract_epub(source) if extension == ".epub" else extract_pdf(source))
    if not chapters:
        raise BookExtractionError("No readable chapters found in this book")
    destination = Path(output_dir).expanduser().resolve() / slug
    # Never follow a slug/chapters symlink into another directory.
    if destination.is_symlink() or (destination / "chapters").is_symlink():
        raise BookExtractionError("Output directory must not be a symbolic link")
    chapter_dir = destination / "chapters"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    toc = {"slug": slug, "title": title, "author": author, "format": extension[1:],
           "chapters": []}
    for number, chapter in enumerate(chapters, 1):
        filename = f"{number:02d}.txt"
        target = chapter_dir / filename
        if target.is_symlink() or target.resolve() == source:
            raise BookExtractionError("Unsafe chapter output path")
        target.write_text(chapter["text"].rstrip() + "\n", encoding="utf-8")
        toc["chapters"].append({"number": number, "title": chapter["title"],
                                "file": f"chapters/{filename}",
                                **{key: chapter[key] for key in ("page", "resource") if key in chapter}})
    toc_path = destination / "toc.json"
    if toc_path.is_symlink() or toc_path.resolve() == source:
        raise BookExtractionError("Unsafe table-of-contents output path")
    toc_path.write_text(json.dumps(toc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return destination, toc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("book", help="Local EPUB or PDF (read only)")
    parser.add_argument("--slug", help="Output directory name, e.g. photography-aesthetics-six")
    parser.add_argument("--output-dir", default="/tmp/books", help="Extraction root (default: /tmp/books)")
    args = parser.parse_args(argv)
    try:
        destination, toc = extract_book(args.book, args.slug, args.output_dir)
    except (BookExtractionError, OSError, zipfile.BadZipFile, UnicodeError) as exc:
        print(f"Book extraction failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"output": str(destination), "title": toc["title"],
                      "chapters": len(toc["chapters"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
