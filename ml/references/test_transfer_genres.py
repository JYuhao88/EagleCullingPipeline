"""Genre exports preserve checksums and separate QA images from text exports."""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO
import transfer_genres
from transfer_rules import receive

class GenreTransferTests(unittest.TestCase):
    def logs(self, root, qa=None):
        with patch.object(transfer_genres, 'CEPH', str(root.parent)):
            source = transfer_genres.export_source(root.name, qa)
        output = StringIO()
        with redirect_stdout(output): exec(compile(source, 'test-export', 'exec'), {})
        return output.getvalue()

    def test_text_round_trip_and_never_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'wuxiaolong';(root/'topics').mkdir(parents=True);(root/'frames').mkdir()
            raw=(json.dumps({'topic':'light','synthetic':True})+'\n').encode()*2000
            (root/'topics/episode.jsonl').write_bytes(raw)
            (root/'frames/secret.jpg').write_bytes(b'not exported')
            logs=self.logs(root); destination=Path(tmp)/'received'
            self.assertEqual(receive(logs,destination),1)
            self.assertEqual((destination/'topics/episode.jsonl').read_bytes(),raw)
            self.assertFalse((destination/'frames').exists())
            lines=logs.splitlines()
            with self.assertRaisesRegex(ValueError,'missing chunks'):receive('\n'.join(lines[1:]),destination)
            changed=json.loads(lines[1][9:]);changed['count']+=1
            with self.assertRaisesRegex(ValueError,'inconsistent'):receive('\n'.join([lines[0],'W2_CHUNK '+json.dumps(changed),*lines[2:]]),destination)
            with self.assertRaisesRegex(ValueError,'incomplete'):receive(logs.replace('W2_TRANSFER_DONE',''),destination)
            chunk=json.loads(logs.splitlines()[0][9:]);chunk['chunk_sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'checksum'):receive('W2_CHUNK '+json.dumps(chunk)+'\nW2_TRANSFER_DONE',destination)

    def test_explicit_three_qa_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'wulin';(root/'qa').mkdir(parents=True)
            ids=['BVOne','BVTwo','BVThree']
            for b in ids:(root/'qa'/f'{b}.html').write_text('synthetic QA '+b)
            logs=self.logs(root,ids)
            self.assertEqual(receive(logs,Path(tmp)/'received'),3)
            with self.assertRaises(ValueError):transfer_genres.export_source('wulin',['BVOne'])
            with self.assertRaises(ValueError):transfer_genres.export_source('wuxiaolong',ids)
            with self.assertRaises(ValueError):transfer_genres.export_source('unknown')


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':unittest.main()
