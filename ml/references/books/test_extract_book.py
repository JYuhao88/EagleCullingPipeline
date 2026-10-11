import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from extract_book import BookExtractionError, extract_book, main


def write_epub(path, version=3):
    container = '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    nav_item = ('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
                if version == 3 else '<item id="nav" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
    package = '''<package xmlns:dc="http://purl.org/dc/elements/1.1/">
    <metadata><dc:title>合成摄影书</dc:title><dc:creator>测试作者</dc:creator></metadata>
    <manifest><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>
    <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
    <item id="aside" href="aside.xhtml" media-type="application/xhtml+xml"/>''' + nav_item + '''</manifest>
    <spine><itemref idref="a"/><itemref idref="b"/><itemref idref="aside" linear="no"/></spine></package>'''
    nav = ('<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><a href="a.xhtml#start">第一讲</a><a href="b.xhtml">第二讲</a></nav></body></html>'
           if version == 3 else '<ncx><navMap><navPoint><navLabel><text>第一讲</text></navLabel><content src="a.xhtml#start"/></navPoint><navPoint><navLabel><text>第二讲</text></navLabel><content src="b.xhtml"/></navPoint></navMap></ncx>')
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("OPS/book.opf", package)
        archive.writestr("OPS/nav.xhtml" if version == 3 else "OPS/toc.ncx", nav)
        archive.writestr("OPS/a.xhtml", '<html><head><title>Hidden title</title><style>hidden css</style></head><body><h1>瞬间</h1><p>观察 <em>姿态</em> &amp; 情绪。</p><script>hidden code</script></body></html>')
        archive.writestr("OPS/b.xhtml", '<html><body><h2>构图</h2><p>画面完整性。</p></body></html>')
        archive.writestr("OPS/aside.xhtml", '<p>附带导航</p>')


def write_pdf(path):
    """Tiny two-page PDF with standard-font text, no fixture dependency."""
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    for text in (b'First page', b'Second page'):
        stream = b'BT /F1 12 Tf 30 250 Td (' + text + b') Tj ET'
        objects.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
    result = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f'{number} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(result)
    result.extend(f'xref\n0 {len(objects) + 1}\n'.encode() + b'0000000000 65535 f \n')
    for offset in offsets[1:]:
        result.extend(f'{offset:010d} 00000 n \n'.encode())
    result.extend(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    path.write_bytes(result)


class BookExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"

    def test_epub_spine_titles_text_and_source_unchanged(self):
        for version in (2, 3):
            with self.subTest(version=version):
                source = self.root / f"book-{version}.epub"
                write_epub(source, version)
                before = hashlib.sha256(source.read_bytes()).hexdigest()
                destination, toc = extract_book(source, f"v{version}", self.output)
                self.assertEqual(toc["title"], "合成摄影书")
                self.assertEqual(toc["author"], "测试作者")
                self.assertEqual([chapter["title"] for chapter in toc["chapters"]], ["第一讲", "第二讲"])
                self.assertEqual([chapter["number"] for chapter in toc["chapters"]], [1, 2])
                self.assertEqual((destination / "chapters/01.txt").read_text(), "瞬间\n观察 姿态 & 情绪。\n")
                self.assertEqual(json.loads((destination / "toc.json").read_text()), toc)
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    def test_no_navigation_falls_back_to_heading(self):
        source = self.root / "plain.epub"
        write_epub(source)
        with zipfile.ZipFile(source) as old:
            resources = {name: old.read(name) for name in old.namelist()}
        resources["OPS/book.opf"] = resources["OPS/book.opf"].replace(b' properties="nav"', b'')
        with zipfile.ZipFile(source, "w") as archive:
            for name, content in resources.items():
                archive.writestr(name, content)
        _, toc = extract_book(source, "plain", self.output)
        self.assertEqual(toc["chapters"][0]["title"], "瞬间")

    def test_invalid_slug_and_symlink_output_rejected(self):
        source = self.root / "safe.epub"
        write_epub(source)
        for slug in ("../escape", "/absolute", "..", "", "a/b"):
            with self.subTest(slug=slug), self.assertRaises(BookExtractionError):
                extract_book(source, slug, self.output)
        self.output.mkdir()
        (self.output / "linked").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(BookExtractionError):
            extract_book(source, "linked", self.output)

    def test_epub_resource_traversal_rejected(self):
        source = self.root / "bad.epub"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("META-INF/container.xml", '<container><rootfile full-path="../outside.opf"/></container>')
        with self.assertRaisesRegex(BookExtractionError, "escapes"):
            extract_book(source, "bad", self.output)

    def test_pdf_missing_dependency_has_install_command(self):
        source = self.root / "book.pdf"
        write_pdf(source)
        with patch("extract_book.importlib.import_module", side_effect=ImportError), self.assertRaisesRegex(BookExtractionError, "python -m pip install pypdf"):
            extract_book(source, "pdf", self.output)
        self.assertFalse(self.output.exists())

    @unittest.skipUnless(importlib.util.find_spec("pypdf") or importlib.util.find_spec("pdfplumber"), "Optional PDF parser is not installed")
    def test_synthetic_pdf_preserves_page_numbers(self):
        source = self.root / "book.pdf"
        write_pdf(source)
        before = source.read_bytes()
        destination, toc = extract_book(source, "pdf", self.output)
        self.assertEqual([chapter["page"] for chapter in toc["chapters"]], [1, 2])
        for number, text in ((1, "First page"), (2, "Second page")):
            extracted = (destination / f"chapters/{number:02d}.txt").read_text()
            self.assertTrue(extracted.startswith(f"[p.{number}]\n"))
            self.assertIn(text, extracted)
        self.assertEqual(source.read_bytes(), before)

    def test_cli_friendly_invalid_input(self):
        with patch("sys.stderr") as stderr:
            self.assertEqual(main([str(self.root / "missing.epub")]), 1)
        self.assertIn("Book extraction failed", stderr.write.call_args_list[0].args[0])


if __name__ == "__main__":
    unittest.main()
