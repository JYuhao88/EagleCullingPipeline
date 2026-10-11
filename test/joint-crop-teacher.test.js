import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('joint crop teacher validation, reconciliation, CLI caching and attempt budget', () => {
  const program = String.raw`
import copy, importlib.util, json, pathlib, subprocess, sys, tempfile, unittest
from PIL import Image
sys.dont_write_bytecode = True
SCRIPT = pathlib.Path('ml/teacher/joint_crop_teacher.py').resolve()
spec = importlib.util.spec_from_file_location('teacher', SCRIPT)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
def answer():
    return {j: dict(status='safe', edges=[], confidence=.9, reason='visible') for j in t.JOINTS}
class TeacherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source, self.out = self.root / 'input', self.root / 'output'
        self.source.mkdir()
        self.proxy = self.source / 'proxy.jpg'
        Image.new('RGB', (80, 120), 'gray').save(self.proxy)
        self.write(self.source / 'labels-template.json', [dict(unitId='one', name='one', previewPath=str(self.proxy))])
        self.write(self.source / 'all-results.json', dict(results=[dict(unitId='one')]))
        self.write(self.source / 'raw-poses.json', [dict(id='one', persons=[dict(isMain=True, box=[.1,.1,.9,.9])])])
        self.counter = self.root / 'count'
        self.mock = self.root / 'codex'
        self.mock.write_text('#!' + sys.executable + '\n' +
            'import json, pathlib, sys\n' +
            'count = pathlib.Path(' + repr(str(self.counter)) + ')\n' +
            'count.write_text(str(int(count.read_text()) + 1) if count.exists() else "1")\n' +
            'request = sys.stdin.read()\n' +
            'assert "只根据附图" in request\n' +
            'json.dump(' + repr(answer()) + ', open(sys.argv[sys.argv.index("-o") + 1], "w"))\n')
        self.mock.chmod(0o755)
    def write(self, path, data):
        path.write_text(json.dumps(data))
    def cli(self, *extra, expected=0):
        result = subprocess.run(['nice', '-n', '10', sys.executable, str(SCRIPT), '--input', str(self.source),
            '--out', str(self.out), '--codex', str(self.mock), *extra], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        filename = 'prepare-summary.json' if '--prepare-only' in extra else 'summary.json'
        return json.loads((self.out / filename).read_text())
    def count(self):
        return int(self.counter.read_text()) if self.counter.exists() else 0
    def test_reconcile(self):
        a, b = answer(), answer()
        for labels in (a, b):
            labels['wrist'].update(status='crop', edges=['right', 'bottom'])
        b['wrist']['edges'].reverse()
        verdict = t.reconcile(a, b)
        self.assertEqual(verdict['overall'], 'crop')
        self.assertEqual(verdict['joints']['wrist']['edges'], ['bottom', 'right'])
        b['ankle']['confidence'] = .69
        self.assertEqual(t.reconcile(a, b)['overall'], 'uncertain')
        self.assertEqual(t.reconcile(a, b)['joints']['wrist']['status'], 'crop')
        b['wrist']['edges'] = ['left']
        self.assertEqual(t.reconcile(a, b)['joints']['wrist']['status'], 'uncertain')
        a, b = answer(), answer()
        b['ankle']['confidence'] = .69
        self.assertEqual(t.reconcile(a, b)['overall'], 'uncertain')
        b['ankle'].update(status='uncertain', confidence=.99)
        self.assertFalse(t.reconcile(b, b)['joints']['ankle']['agreed'])
        self.assertNotEqual(t.prompt(False), t.prompt(True))
    def test_validation(self):
        for field, value in [('confidence', float('nan')), ('confidence', float('inf')), ('confidence', True),
                ('confidence', 1.1), ('status', 'pass'), ('edges', ['bottom']), ('edges', 'bottom'), ('reason', 1)]:
            with self.subTest(field=field, value=value):
                labels = answer(); labels['wrist'][field] = value
                with self.assertRaises(ValueError): t.validate(labels)
        labels = answer(); labels.pop('neck')
        with self.assertRaises(ValueError): t.validate(labels)
        labels = answer(); labels['wrist'].update(status='crop', edges=['bottom', 'bottom'])
        with self.assertRaises(ValueError): t.validate(labels)
    def test_two_calls_and_resume(self):
        summary = self.cli()
        self.assertEqual((self.count(), summary['calls'], summary['completedCalls']), (2, 2, 2))
        self.assertEqual(summary['distribution']['safe'], 1)
        self.assertTrue(summary['complete'])
        self.assertEqual(self.cli()['calls'], 2)
        self.assertEqual(self.count(), 2)
        ledger = json.loads((self.out / 'calls.json').read_text())
        self.assertEqual([row['swapped'] for row in ledger], [False, True])
        self.assertTrue(all(row['elapsedSeconds'] >= 0 for row in ledger))
    def test_prepare_only(self):
        summary = self.cli('--prepare-only')
        self.assertEqual((summary['calls'], self.count()), (0, 0))
        self.assertFalse(summary['complete'])
        self.assertEqual(len(list(self.out.glob('*/annotation.jpg'))), 1)
        self.cli()
        previous = (self.out / 'labels.json').read_text()
        self.cli('--prepare-only')
        self.assertEqual((self.out / 'labels.json').read_text(), previous)
        self.assertEqual(self.count(), 2)
    def test_failure_stops_and_counts(self):
        self.mock.write_text('#!' + sys.executable + '\nimport sys\nsys.exit(7)\n')
        summary = self.cli(expected=1)
        self.assertEqual((summary['calls'], summary['completedCalls']), (1, 0))
        summary = self.cli('--max-calls', '1', expected=1)
        self.assertEqual(summary['calls'], 1)
        self.assertEqual(summary['blocked'], 'Call budget exhausted')
    def test_budget_includes_attempts_and_hard_cap(self):
        summary = self.cli('--max-calls', '1', expected=1)
        self.assertEqual((summary['calls'], self.count(), summary['outputSamples']), (1, 1, 0))
        self.assertFalse(summary['complete'])
        self.out.joinpath('calls.json').write_text(json.dumps([
            dict(status='failed', elapsedSeconds=.1) for _ in range(150)]))
        summary = self.cli('--max-calls', '999', expected=1)
        self.assertEqual((summary['calls'], self.count()), (150, 1))
    def test_cache_invalidation(self):
        self.cli()
        Image.new('RGB', (80, 120), 'red').save(self.proxy)
        self.assertEqual(self.cli()['calls'], 4)
        self.assertEqual(self.cli('--model', 'another-model')['calls'], 6)
        self.assertEqual(self.count(), 6)
unittest.main(argv=['teacher-tests'], verbosity=2)
`;
  const result = spawnSync('python3', ['-c', program], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
