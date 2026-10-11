import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('stress_ray', Path(__file__).with_name('stress-ray.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackagingTest(unittest.TestCase):
    def test_code_package_contains_routes_without_data_models_or_dependency_trees(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'code.zip'
            module.package(target)
            with zipfile.ZipFile(target) as archive:
                names = archive.namelist()
                self.assertIn('scripts/stress.mjs', names)
                self.assertIn('scripts/stress-results.mjs', names)
                self.assertIn('src/server/runs-routes.js', names)
                self.assertIn('src/core/capture-metadata.js', names)
                self.assertIn('package.json', names)
                self.assertFalse(any(name.startswith(('node_modules/', 'models/', 'data/', '.git/')) for name in names))
                self.assertLess(target.stat().st_size, 2 * 1024 ** 2)


if __name__ == '__main__':
    unittest.main()
