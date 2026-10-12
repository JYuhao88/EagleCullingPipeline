import os
import unittest
from unittest.mock import patch, MagicMock
import memory_guard


class GuardTest(unittest.TestCase):
    def test_self_rss_is_available(self):
        self.assertGreater(memory_guard.rss_bytes(), 0)

    def test_normal_mode_does_not_start_watchdog(self):
        with patch.dict(os.environ, {}, clear=True), patch('threading.Thread') as thread:
            memory_guard.start_memory_guard()
            thread.assert_not_called()

    def test_command_above_budget_is_killed_and_reaped(self):
        child = MagicMock()
        child.poll.side_effect = [None, 0]
        child.pid = 123
        with patch('subprocess.Popen', return_value=child), patch('signal.signal'), \
                patch.object(memory_guard, 'windows_job', return_value=lambda: None), \
                patch.object(memory_guard, 'rss_bytes', return_value=200):
            self.assertEqual(memory_guard.guarded_command(100, ['owned-command']), 75)
        child.kill.assert_called_once()
        self.assertGreaterEqual(child.wait.call_count, 1)
