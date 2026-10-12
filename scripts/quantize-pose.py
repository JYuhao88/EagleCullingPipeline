#!/usr/bin/env python3
"""Optional, local-only QDQ quantization probe for pose models.

The script never uploads images and writes only below data/cache/w23-quant.
It exits with a useful dependency/model-shape message when the optional ONNX
toolchain is absent; quantized models are intentionally not repository assets.
"""
import argparse
import json
import sys
from pathlib import Path


class SyntheticReader:
    def __init__(self, input_name, shape, count):
        import numpy as np
        self.name, self.shape, self.remaining = input_name, shape, count
        self.rng = np.random.default_rng(20261012)

    def get_next(self):
        if self.remaining <= 0:
            return None
        import numpy as np
        self.remaining -= 1
        shape = [1 if not isinstance(v, int) or v <= 0 else v for v in self.shape]
        return {self.name: self.rng.integers(0, 256, size=shape, dtype=np.uint8).astype(np.float32)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model')
    parser.add_argument('--output', required=True)
    parser.add_argument('--samples', type=int, default=8)
    parser.add_argument('--mode', choices=('static', 'dynamic'), default='static')
    args = parser.parse_args()
    try:
        import onnxruntime as ort
        from onnxruntime.quantization import (CalibrationDataReader, QuantFormat, QuantType,
                                               quantize_dynamic, quantize_static)
    except ImportError as exc:
        print(json.dumps({'status': 'blocked', 'reason': 'missing optional onnx/onnxruntime quantization toolchain',
                          'error': str(exc)}))
        return 2
    model = Path(args.model)
    if not model.is_file():
        print(json.dumps({'status': 'blocked', 'reason': f'missing model: {model}'}))
        return 2
    if args.mode == 'dynamic':
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        quantize_dynamic(str(model), str(out), weight_type=QuantType.QInt8, per_channel=True)
        print(json.dumps({'status': 'ok', 'mode': args.mode, 'model': str(model), 'output': str(out)}))
        return 0
    session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]
    shape = inp.shape
    # Dynamic batch is safe for calibration; spatial dimensions must remain fixed.
    if any((not isinstance(v, int) or v <= 0) and i != 0 for i, v in enumerate(shape)):
        print(json.dumps({'status': 'blocked', 'reason': f'dynamic spatial input shape unsupported: {shape}'}))
        return 2
    class Reader(CalibrationDataReader):
        def __init__(self): self.reader = SyntheticReader(inp.name, shape, args.samples)
        def get_next(self): return self.reader.get_next()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    quantize_static(str(model), str(out), Reader(), quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8,
                    per_channel=False, reduce_range=False)
    print(json.dumps({'status': 'ok', 'mode': args.mode, 'model': str(model), 'output': str(out), 'samples': args.samples}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
