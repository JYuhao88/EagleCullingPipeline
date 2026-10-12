import os
import unittest
from unittest.mock import patch

import pose_worker


class SessionTest(unittest.TestCase):
    def test_mac_cpu_session_options_and_no_compiler_cache(self):
        with patch.dict(os.environ, {}, clear=True), patch('pose_runtime.sys.platform', 'darwin'), \
                patch.object(pose_worker.os.path, 'isfile', return_value=True), \
                patch.object(pose_worker.ort, 'get_available_providers',
                             return_value=['CoreMLExecutionProvider', 'CPUExecutionProvider']), \
                patch.object(pose_worker.ort, 'InferenceSession') as create, patch('os.makedirs') as mkdir:
            self.assertIs(pose_worker.session('local.onnx'), create.return_value)
            self.assertEqual(create.call_args.kwargs['providers'], ['CPUExecutionProvider'])
            options = create.call_args.kwargs['sess_options']
            self.assertEqual(options.intra_op_num_threads, 3)
            self.assertEqual(options.inter_op_num_threads, 1)
            self.assertFalse(options.enable_mem_pattern)
            self.assertEqual(options.execution_mode, pose_worker.ort.ExecutionMode.ORT_SEQUENTIAL)
            mkdir.assert_not_called()

    def test_explicit_coreml_remains_available_without_new_cache_side_effects(self):
        with patch.dict(os.environ, {'EAGLE_POSE_PROVIDER': 'CoreMLExecutionProvider', 'EAGLE_POSE_THREADS': '8'}, clear=True), \
                patch.object(pose_worker.os.path, 'isfile', return_value=True), \
                patch.object(pose_worker.ort, 'get_available_providers',
                             return_value=['CoreMLExecutionProvider', 'CPUExecutionProvider']), \
                patch.object(pose_worker.ort, 'InferenceSession') as create, patch('os.makedirs') as mkdir:
            pose_worker.session('local.onnx')
            self.assertEqual(create.call_args.kwargs['providers'], ['CoreMLExecutionProvider', 'CPUExecutionProvider'])
            mkdir.assert_not_called()

    def test_accelerator_options_stay_one_and_cpu_creation_fallback_uses_override(self):
        for accelerator in ('DmlExecutionProvider', 'CUDAExecutionProvider', 'CoreMLExecutionProvider'):
            with self.subTest(accelerator=accelerator), patch.dict(os.environ, {'EAGLE_POSE_PROVIDER': accelerator,
                    'EAGLE_POSE_THREADS': '4'}, clear=True), patch.object(pose_worker.os.path, 'isfile', return_value=True), \
                    patch.object(pose_worker.ort, 'get_available_providers', return_value=[accelerator, 'CPUExecutionProvider']):
                values = []
                def create(model, sess_options, providers):
                    values.append(sess_options.intra_op_num_threads)
                    if providers[0] != 'CPUExecutionProvider':
                        raise RuntimeError('accelerator failed')
                    return object()
                with patch.object(pose_worker.ort, 'InferenceSession', side_effect=create):
                    pose_worker.session('local.onnx')
                self.assertEqual(values, [1, 4])

    def test_coreml_options_are_opt_in_and_create_cache_directory(self):
        options = {'ModelFormat': 'MLProgram', 'MLComputeUnits': 'CPUAndNeuralEngine',
                   'RequireStaticInputShapes': True, 'ModelCacheDirectory': '/tmp/w23-quant-test-cache'}
        with patch.dict(os.environ, {'EAGLE_POSE_PROVIDER': 'CoreMLExecutionProvider',
                                     'EAGLE_POSE_COREML_OPTIONS': __import__('json').dumps(options)}, clear=True), \
                patch.object(pose_worker.os.path, 'isfile', return_value=True), \
                patch.object(pose_worker.ort, 'get_available_providers',
                             return_value=['CoreMLExecutionProvider', 'CPUExecutionProvider']), \
                patch.object(pose_worker.ort, 'InferenceSession') as create, patch.object(pose_worker.Path, 'mkdir') as mkdir:
            pose_worker.session('local.onnx')
            expected = {**options}
            expected['ModelCacheDirectory'] = '/tmp/w23-quant-test-cache'
            expected['RequireStaticInputShapes'] = '1'
            self.assertEqual(create.call_args.kwargs['providers'],
                             [('CoreMLExecutionProvider', expected), 'CPUExecutionProvider'])
            mkdir.assert_called_once_with(parents=True, exist_ok=True)

    def test_missing_model_is_rejected_before_session_creation(self):
        with patch.object(pose_worker.os.path, 'isfile', return_value=False), \
                patch.object(pose_worker.ort, 'InferenceSession') as create:
            with self.assertRaises(FileNotFoundError):
                pose_worker.session('local.onnx')
            create.assert_not_called()


if __name__ == '__main__':
    unittest.main()
