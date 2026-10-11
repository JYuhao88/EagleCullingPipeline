"""Verify remote log-transfer corruption and traversal rejection without network."""
import base64
import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from phototriage import receive


def export(raw=b'example-image', name='images/1.jpg'):
    parts = [raw[:4], raw[4:]]
    records = [{'path': name, 'index': i, 'count': len(parts), 'size': len(raw),
                'sha256': hashlib.sha256(raw).hexdigest(),
                'chunk_sha256': hashlib.sha256(part).hexdigest(),
                'data': base64.b64encode(gzip.compress(part)).decode()}
               for i, part in enumerate(parts)]
    return records


def logs(records, complete=True):
    return '\n'.join(['W2_CHUNK ' + json.dumps(record) for record in records] +
                     (['W2_TRANSFER_DONE'] if complete else []))


class TransferTest(unittest.TestCase):
    def test_out_of_order_validated(self):
        with tempfile.TemporaryDirectory() as destination:
            self.assertEqual(receive(logs(list(reversed(export()))), destination), 1)
            self.assertEqual((Path(destination) / 'images/1.jpg').read_bytes(), b'example-image')

    def test_corruption(self):
        records = export()
        records[0]['chunk_sha256'] = '0' * 64
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'chunk checksum'):
                receive(logs(records), destination)
            self.assertEqual(list(Path(destination).iterdir()), [])

    def test_incomplete(self):
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                receive(logs(export(), complete=False), destination)

    def test_missing_chunk(self):
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'missing chunks'):
                receive(logs(export()[:1]), destination)

    def test_duplicate_chunk(self):
        records = export()
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                receive(logs(records + records[:1]), destination)

    def test_traversal(self):
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'path traversal'):
                receive(logs(export(name='../outside.jpg')), destination)

    def test_file_checksum(self):
        records = export()
        for record in records:
            record['sha256'] = '0' * 64
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaisesRegex(ValueError, 'file checksum'):
                receive(logs(records), destination)


if __name__ == '__main__':
    unittest.main()
