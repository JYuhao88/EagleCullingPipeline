import unittest
from pose_runtime import select_providers, cpu_threads


class ProviderPolicyTest(unittest.TestCase):
    available = ['CoreMLExecutionProvider', 'CPUExecutionProvider']

    def test_threads_range(self):
        for value in ('1', '3', '8'):
            self.assertEqual(cpu_threads(value), int(value))
        for value in ('0', '9', '1.5', '03', '', 3):
            with self.assertRaises(ValueError):
                cpu_threads(value)

    def test_mac_defaults_to_cpu(self):
        self.assertEqual(select_providers(self.available, platform='darwin'), ['CPUExecutionProvider'])

    def test_explicit_coreml_keeps_cpu_fallback(self):
        self.assertEqual(select_providers(self.available, 'CoreMLExecutionProvider', 'darwin'), self.available)

    def test_unavailable_override_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'Unavailable provider'):
            select_providers(self.available, 'CUDAExecutionProvider', 'darwin')

    def test_windows_order_unchanged(self):
        providers = ['CPUExecutionProvider', 'CUDAExecutionProvider', 'DmlExecutionProvider']
        self.assertEqual(select_providers(providers, platform='win32'),
                         ['DmlExecutionProvider', 'CUDAExecutionProvider', 'CPUExecutionProvider'])

    def test_linux_order_unchanged(self):
        self.assertEqual(select_providers(['CPUExecutionProvider', 'CUDAExecutionProvider'], platform='linux'),
                         ['CUDAExecutionProvider', 'CPUExecutionProvider'])



if __name__ == '__main__':
    unittest.main()
