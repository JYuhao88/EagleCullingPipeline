"""Offline YOLOX + RTMW JSONL worker. Sessions loaded once; no download path.
Raw predictions are retained internally until clipping at the Signals boundary.
"""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
from rtmlib import YOLOX, RTMPose
from pose_runtime import select_providers, cpu_threads

SESSION_FALLBACKS = []


def _coreml_options():
    """Return opt-in CoreML provider options; unset keeps the production path byte-for-byte."""
    raw = os.environ.get('EAGLE_POSE_COREML_OPTIONS')
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f'EAGLE_POSE_COREML_OPTIONS must be JSON: {exc}') from exc
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        raise ValueError('EAGLE_POSE_COREML_OPTIONS must be a JSON object')
    cache = value.setdefault('ModelCacheDirectory', 'data/cache/pose-coreml')
    if not isinstance(cache, str) or not cache:
        raise ValueError('ModelCacheDirectory must be a non-empty string')
    Path(cache).mkdir(parents=True, exist_ok=True)
    return {k: ('1' if v else '0') if isinstance(v, bool) else str(v) for k, v in value.items()}


def session(model):
    if not os.path.isfile(model):
        raise FileNotFoundError(f'Missing local model: {model}')
    available = ort.get_available_providers()
    requested = os.environ.get('EAGLE_POSE_PROVIDER')
    providers = select_providers(available, requested)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    # DirectML requires sequential execution and disabled memory patterns.
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    coreml_options = _coreml_options()
    errors = []
    for index in range(len(providers)):
        try:
            options.intra_op_num_threads = cpu_threads(os.environ.get('EAGLE_POSE_THREADS', '3')) if providers[index] == 'CPUExecutionProvider' else 1
            selected = providers[index:]
            if coreml_options and selected and selected[0] == 'CoreMLExecutionProvider':
                selected = [(selected[0], coreml_options), *selected[1:]]
            created = ort.InferenceSession(model, sess_options=options, providers=selected)
            if errors:
                SESSION_FALLBACKS.extend(errors)
                print('Provider fallback: ' + '; '.join(errors), file=sys.stderr)
            return created
        except Exception as exc:
            errors.append(f'{providers[index]}: {exc}')
    raise RuntimeError('; '.join(errors))


def load_models():
    mode = os.environ.get('EAGLE_POSE_MODE', 'balanced')
    if mode not in ('balanced', 'performance'):
        raise ValueError('EAGLE_POSE_MODE must be balanced or performance')
    size = (192, 256) if mode == 'balanced' else (288, 384)
    detector_path = os.environ.get('EAGLE_POSE_DETECTOR', 'models/pose/yolox_m_8xb8-300e_humanart-c2c7a14a.onnx')
    pose_path = os.environ.get('EAGLE_POSE_MODEL', f'models/pose/rtmw-dw-x-l_simcc-cocktail14_270e-{size[1]}x{size[0]}_20231122.onnx')
    # Use rtmlib preprocess/postprocess with explicitly constructed local sessions.
    # Avoid BaseTool's implicit download and uncontrolled ORT thread pool.
    detector = YOLOX.__new__(YOLOX)
    pose = RTMPose.__new__(RTMPose)
    raw_det_size = os.environ.get('EAGLE_POSE_DET_SIZE', '640')
    try:
        det_size = int(raw_det_size)
    except ValueError as exc:
        raise ValueError('EAGLE_POSE_DET_SIZE must be an integer') from exc
    if det_size < 128 or det_size > 1280:
        raise ValueError('EAGLE_POSE_DET_SIZE must be between 128 and 1280')
    for model, filename, input_size in ((detector, detector_path, (det_size, det_size)), (pose, pose_path, size)):
        model.session = session(filename)
        model.backend = 'onnxruntime'
        if model is detector:
            shape = model.session.get_inputs()[0].shape
            static = shape[-1] if len(shape) == 4 and isinstance(shape[-1], int) else None
            if static is not None and static != det_size:
                raise ValueError(f'EAGLE_POSE_DET_SIZE={det_size} incompatible with detector input {static}x{static}')
        model.model_input_size = input_size
    detector.det_mode, detector.nms_thr, detector.score_thr = 'human', 0.45, 0.7
    pose.mean, pose.std = (123.675, 116.28, 103.53), (58.395, 57.12, 57.375)
    pose.to_openpose = False
    return detector, pose, mode


def analyze(record, detector, pose, mode):
    start = time.perf_counter()
    with Image.open(record['filePath']) as source:
        if source.width * source.height > 16_000_000:
            raise ValueError('Use a bounded, upright proxy')
        image = ImageOps.exif_transpose(source).convert('RGB')
    width, height = image.size
    bgr = np.asarray(image)[:, :, ::-1].copy()
    boxes = detector(bgr)
    detected = time.perf_counter()
    persons = []
    # RTMPose(empty boxes) would hallucinate a full-image person; never call it.
    if len(boxes):
        points, scores = pose(bgr, bboxes=boxes)
        for box, keypoints, confidence in zip(boxes, points, scores):
            normalized = [[float(x / width), float(y / height), float(np.clip(s, 0, 1))]
                          for (x, y), s in zip(keypoints, confidence)]
            bbox = [float(np.clip(v, 0, 1)) for v in box / [width, height, width, height]]
            persons.append({'box': bbox, 'score': float(np.clip(np.mean(confidence[:17]), 0, 1)),
                            'isMain': False, 'keypoints': {'format': 'coco-wholebody-133', 'points': normalized}})
    if persons:
        def salience(person):
            x0, y0, x1, y1 = person['box']
            center = max(0.1, 1 - abs((x0+x1)/2-0.5) - abs((y0+y1)/2-0.5))
            face_support = any(x0 <= (f['box'][0]+f['box'][2])/2 <= x1 and y0 <= (f['box'][1]+f['box'][3])/2 <= y1 for f in record.get('faces', []))
            return (x1-x0)*(y1-y0)*center*person['score']*(1.2 if face_support else 1)
        max(persons, key=salience)['isMain'] = True
    providers = {'detector': detector.session.get_providers(), 'pose': pose.session.get_providers()}
    return {'id': record.get('id'), 'available': True, 'persons': persons,
            'source': {'width': width, 'height': height, 'proxyWidth': width, 'proxyHeight': height, 'kind': 'jpeg'},
            'diagnostics': {'intraOpThreads': {name: model.session.get_session_options().intra_op_num_threads
                            for name, model in [('detector', detector), ('pose', pose)]}},
            'mode': mode, 'provider': providers['pose'][0], 'providers': providers,
            'timingMs': {'detection': (detected-start)*1000, 'total': (time.perf_counter()-start)*1000}}


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    from memory_guard import start_memory_guard
    start_memory_guard()
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        with contextlib.redirect_stdout(sys.stderr):
            detector, pose, mode = load_models()
    except Exception as exc:
        emit({'error': {'code': 'model_unavailable', 'message': str(exc)}})
        return
    fallback_reason = '; '.join(SESSION_FALLBACKS) or None
    for line in sys.stdin:
        if not line.strip():
            continue
        record = {}
        try:
            record = json.loads(line)
            try:
                result = analyze(record, detector, pose, mode)
            except Exception as exc:
                if detector.session.get_providers()[0] == 'CPUExecutionProvider' and pose.session.get_providers()[0] == 'CPUExecutionProvider':
                    raise
                fallback_reason = str(exc)
                detector.session.set_providers(['CPUExecutionProvider'])
                pose.session.set_providers(['CPUExecutionProvider'])
                result = analyze(record, detector, pose, mode)
            if fallback_reason:
                result['fallbackReason'] = fallback_reason
            emit(result)
        except Exception as exc:
            emit({'id': record.get('id'), 'available': False, 'error': {'code': 'inference_error', 'message': str(exc)}})


if __name__ == '__main__':
    main()
