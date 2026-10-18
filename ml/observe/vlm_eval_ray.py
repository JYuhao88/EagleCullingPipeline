"""Single-GPU, versioned VLM research tasks; no training or model-service calls."""
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import tempfile
import threading
import time
import traceback


def family_config(config):
    family = config.get('family', 'qwen-vl')
    if family not in ('qwen-vl', 'minicpm', 'qwen3_5_moe'):
        raise ValueError('unsupported VLM family')
    if not re.fullmatch(r'[0-9a-f]{40}', config['revision']):
        raise ValueError('pin a complete model commit revision')
    if config.get('trust_remote_code') and config.get('code_revision') != config['revision']:
        raise ValueError('remote code must use the pinned model revision')
    compression = config.get('compression', 4)
    if compression not in (4, 16) or (family != 'minicpm' and compression != 4):
        raise ValueError('visual compression is only configurable for MiniCPM')
    return family


def prepare_inputs(processor, messages, images, config):
    family = family_config(config)
    if family == 'qwen-vl':
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        return processor(text=[text], images=images, padding=True, return_tensors='pt'), {}
    options = {'tokenize': True, 'add_generation_prompt': True, 'return_dict': True,
               'return_tensors': 'pt', 'enable_thinking': False}
    generation = {}
    if family == 'minicpm':
        generation['downsample_mode'] = f"{config.get('compression', 4)}x"
        options['processor_kwargs'] = {**generation, 'max_slice_nums': 36}
    return processor.apply_chat_template(messages, **options), generation


def load_processor(AutoProcessor, local_model, options, config, model_config):
    if family_config(config) == 'minicpm':
        from transformers import MiniCPMV4_7Processor
        # Quantized cards name a remote image class; the native model config maps its 4.6 implementation.
        return MiniCPMV4_7Processor.from_pretrained(local_model, config=model_config, **options)
    return AutoProcessor.from_pretrained(local_model, **options)


def load_model(Model, local_model, options, config, performance):
    if family_config(config) == 'qwen-vl' and config['quantization'] != 'native':
        return Model.from_pretrained(local_model, **options).eval()
    import transformers.modeling_utils as loading
    fields = ('missing_keys', 'unexpected_keys', 'mismatched_keys', 'error_msgs', 'conversion_errors')
    original = loading.log_state_dict_report

    def record(*args, **kwargs):
        info = kwargs['loading_info']
        details = {key: getattr(info, key) for key in fields}
        performance['loading_info'] = json.loads(json.dumps(details, default=lambda value: sorted(value)))
        return original(*args, **kwargs)

    # The pinned loader omits conversion errors from output_loading_info, including when it raises.
    loading.log_state_dict_report = record
    try:
        model, info = Model.from_pretrained(local_model, **options, output_loading_info=True)
    finally:
        loading.log_state_dict_report = original
    details = performance.setdefault('loading_info', {})
    details.update(json.loads(json.dumps(info, default=lambda value: sorted(value))))
    if any(key not in details for key in fields):
        raise RuntimeError('checkpoint loading diagnostics are incomplete')
    failed = {key: len(details[key]) for key in fields if details[key]}
    if failed:
        raise RuntimeError('checkpoint loading integrity failed: ' + json.dumps(failed, sort_keys=True))
    return model.eval()


def choose_bnb_cuda(torch_cuda, available):
    major, minor = map(int, torch_cuda.split('.')[:2])
    wanted = major * 10 + minor
    compatible = [int(value) for value in available if int(value) // 10 == major and int(value) <= wanted]
    if not compatible:
        raise RuntimeError('no bitsandbytes binary for the CUDA major version')
    return str(max(compatible))


class MemorySampler:
    def __init__(self):
        self.stop = threading.Event()
        self.samples = []
        self.device = os.environ.get('CUDA_VISIBLE_DEVICES', '').split(',')[0]
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            try:
                result = subprocess.run(['nvidia-smi', '-i', self.device, '--query-gpu=memory.used',
                                         '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5)
                values = [int(v.strip()) / 1024 for v in result.stdout.splitlines() if v.strip().isdigit()]
                if len(values) == 1:
                    self.samples.append(values[0])
            except (OSError, subprocess.TimeoutExpired):
                pass
            self.stop.wait(.5)

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=6)
        return {'interval_s': .5, 'samples': len(self.samples), 'device_baseline_gib': self.samples[0] if self.samples else None,
                'device_peak_gib': max(self.samples, default=None),
                'scope': 'assigned physical GPU total, including any other processes; sampled, not continuous peak'}


def emit(name, value):
    raw = value.encode() if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2).encode()
    encoded = base64.b64encode(raw).decode()
    size = 48 * 1024
    chunks = [encoded[i:i + size] for i in range(0, len(encoded), size)] or ['']
    for index, chunk in enumerate(chunks):
        print('VLM_ARTIFACT ' + json.dumps({'name': name, 'index': index, 'count': len(chunks),
                                           'sha256': hashlib.sha256(raw).hexdigest(), 'data': chunk}), flush=True)


def image_path(item, name):
    relative = Path(item['images'][name])
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('image must use a safe relative path')
    root = Path.cwd()
    if item.get('storage') == 'ceph':
        sub = Path(item['imageRoot'])
        if sub.is_absolute() or '..' in sub.parts:
            raise ValueError('unsafe image root')
        root = Path(os.environ['ECP_CEPH_ROOT']) / sub
    file = (root / relative).resolve()
    # Ray can materialize uploaded working-dir assets as links into its content store.
    # Package paths were checked and their actual JPEG bytes validated before upload.
    if item.get('storage') != 'package' and not file.is_relative_to(root.resolve()):
        raise ValueError('image outside permitted root')
    return file


def prompt(item, ask, questions, seed, output_format='plain'):
    rng = random.Random(f"{seed}|{item['id']}|{ask}")
    if item.get('kind') == 'group':
        options = ['左图', '右图', '相当', '看不清']
        rng.shuffle(options)
        return ('两张照片并排，左边是图1，右边是图2。只比较主体表情是否自然、眼睛是否睁开，'
                '哪张更好？不要根据背景或构图判断。看不清就选“看不清”，差不多就选“相当”。'
                '只能从以下选项中原样选一个：' + ' / '.join(options) + '。只输出JSON：{"choice":"选项"}')
    intro = '图是一张人脸照片，主体就是这个人。' if item['set'] == 'celeba' else (
        '图 1 是整张照片；图 2 是从同一张照片裁出的主体人物脸部。' if 'face' in item['images'] else '图是整张照片。')
    lines, order = [], {}
    for key in item['questions']:
        q = questions[key]
        options = list(q['options'].values())
        rng.shuffle(options)
        order[key] = options
        lines.append(f"{key}：{q['text']}。选项：{' / '.join(options)}")
    text = '\n'.join(['你在给照片做标注。只根据图里看得见的内容作答，看不清就选“看不清”，不要猜。', intro,
                      '每个问题只能从列出的选项里原样选一个，输出一个 JSON 对象，键是问题编号。', *lines])
    if output_format == 'schema':
        schema = {'type': 'object', 'additionalProperties': False, 'required': item['questions'],
                  'properties': {key: {'type': 'string', 'enum': order[key]} for key in item['questions']}}
        text += '\n只输出 JSON 对象，不要代码块或其他文字。JSON 结构：' + json.dumps(schema, ensure_ascii=False, separators=(',', ':'))
    return text


def checked_image(file):
    from PIL import Image
    with Image.open(file) as source:
        if (source.format != 'JPEG' or max(source.size) > 768 or source.getexif()
                or any(source.info.get(k) for k in ('exif', 'icc_profile', 'xmp', 'photoshop', 'comment'))
                or any(marker in ('APP1', 'APP2', 'APP13', 'COM') for marker, _ in source.applist)):
            raise ValueError('image exceeds privacy limit or contains metadata')
        return source.convert('RGB')


def select_rows(rows, limit):
    selected, counts = [], {}
    for row in rows:
        key = 'group' if row.get('kind') == 'group' else row['set']
        if not limit or counts.get(key, 0) < limit:
            selected.append(row)
            counts[key] = counts.get(key, 0) + 1
    return selected


def critique_rows(rows, limit=0):
    selected, counts = [], {}
    for row in rows:
        subset = row.get('set')
        if row.get('kind') == 'group' or subset not in ('photos', 'openimages'):
            continue
        if 'full' not in row.get('images', {}):
            raise ValueError('critique requires the sanitized full image')
        if not isinstance(row.get('specialist_facts', []), list):
            raise ValueError('specialist facts must be a list')
        cap = min(limit, 200) if subset == 'openimages' and limit else 200 if subset == 'openimages' else limit
        if not cap or counts.get(subset, 0) < cap:
            selected.append(row)
            counts[subset] = counts.get(subset, 0) + 1
    return selected


def critique_variants(item, config):
    return [variant for variant in config.get('variants', ['A', 'B'])
            if variant == 'A' or item['set'] == 'photos' or item.get('specialist_facts')]


def critique_prediction(item, ask, variant, content, artifact, config):
    from ml.observe.critique import parse_critique, split_statements
    parsed = parse_critique(content, artifact)
    return {'id': item['id'], 'image_id': item['id'], 'set': item['set'], 'split': item.get('split', item['set']),
            'key': f"{item['id']}|{variant}|{ask}", 'ask': ask, 'repeat': ask,
            'variant': variant, 'model': config['model'], 'model_revision': config['revision'],
            'seed': config['seeds'][ask], 'temperature': 0, 'prompt_sha256': artifact['sha256'],
            'prompt_id': artifact['id'], 'prompt_version': artifact['version'],
            'specialist_facts': item.get('specialist_facts', []), 'content': content,
            'critique': parsed, 'statements': split_statements(parsed) if parsed is not None else [],
            'parse_error': None if parsed is not None else 'invalid_critique_json'}


def latency_summary(values):
    ordered = sorted(values)
    return {'n': len(ordered), 'p50_s': statistics.median(ordered) if ordered else None,
            'p95_s': ordered[min(len(ordered) - 1, int(len(ordered) * .95))] if ordered else None}


def critique_report(rows, predictions, config):
    from ml.observe.critique import critique_stability
    by_variant = {}
    for variant in config.get('variants', ['A', 'B']):
        values = [p for p in predictions if p.get('variant') == variant]
        valid = [p for p in values if not p.get('error') and p.get('critique') is not None]
        by_variant[variant] = {'calls': len(values), 'valid_json_calls': len(valid),
                               'failed_calls': sum(bool(p.get('error')) for p in values),
                               'invalid_json_calls': sum(bool(p.get('parse_error')) for p in values),
                               'statements': sum(len(p.get('statements', [])) for p in valid),
                               'stability': critique_stability(values)}
    return {'task': 'critique', 'status': 'awaiting_three_family_judges', 'items': len(rows),
            'calls': len(predictions), 'prompt_sha256': config['prompt_sha256'], 'variants': by_variant,
            'reference_caveat': 'Teachers are references, not truth; style and self-preference bias remain possible.'}


def main():
    config = json.loads(Path('vlm-config.json').read_text())
    family = family_config(config)
    critique = config.get('task') == 'critique'
    manifest = [json.loads(line) for line in Path('manifest.jsonl').read_text().splitlines() if line]
    rows = (critique_rows if critique else select_rows)(manifest, config['limit_per_set'])
    artifact = None
    if critique:
        from ml.observe.critique import load_prompt
        artifact = load_prompt('ml/observe/prompts/critique-v1.md')
        if artifact['sha256'] != config['prompt_sha256'] or config.get('asks') != 2:
            raise ValueError('critique prompt hash or ask count differs from submitted configuration')
    started = time.monotonic()
    predictions = []
    sampler = None
    staged = None
    performance = {'config': config, 'items': len(rows), 'versions': {}, 'warmup_calls': 1}
    try:
        import torch
        from PIL import Image
        from transformers import AutoProcessor, BitsAndBytesConfig
        questions = {} if critique else json.loads(Path('questions.json').read_text())['questions']
        if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
            raise RuntimeError('exactly one assigned CUDA GPU is required')
        torch.set_num_threads(2)
        torch.manual_seed(config['seed'])
        torch.cuda.set_per_process_memory_fraction(min(1, config['vram_limit_gib'] * 1024 ** 3 /
                                                      torch.cuda.get_device_properties(0).total_memory))
        performance['gpu'] = torch.cuda.get_device_name(0)
        performance['gpu_total_gib'] = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
        performance['cuda'] = torch.version.cuda
        sampler = MemorySampler()
        sampler.thread.start()
        for name in ('torch', 'torchvision', 'huggingface_hub', 'transformers', 'accelerate', 'bitsandbytes',
                     'compressed-tensors', 'Pillow', 'numpy'):
            try:
                performance['versions'][name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                pass
        if config['quantization'] == 'bnb4':
            spec = importlib.util.find_spec('bitsandbytes')
            library = Path(spec.origin).parent
            available = [re.fullmatch(r'libbitsandbytes_cuda(\d+)\.so', file.name).group(1)
                         for file in library.glob('libbitsandbytes_cuda*.so')
                         if re.fullmatch(r'libbitsandbytes_cuda(\d+)\.so', file.name)]
            selected = choose_bnb_cuda(torch.version.cuda, available)
            os.environ['BNB_CUDA_VERSION'] = selected
            import bitsandbytes as bnb
            linear = bnb.nn.Linear4bit(64, 64, bias=False, compute_dtype=torch.bfloat16,
                                      quant_type='nf4', compress_statistics=True).to('cuda')
            probe = linear(torch.ones((1, 64), dtype=torch.bfloat16, device='cuda'))
            if not torch.isfinite(probe).all().item():
                raise RuntimeError('bitsandbytes CUDA microprobe returned nonfinite values')
            performance['bitsandbytes_cuda'] = {'torch': torch.version.cuda, 'selected': selected,
                                                'available': available, 'microprobe': 'passed'}
            del linear, probe
            torch.cuda.empty_cache()
            torch.manual_seed(config['seed'])
        model_id = config['model']
        from huggingface_hub import snapshot_download
        snapshot = snapshot_download(model_id, revision=config['revision'], token=False, max_workers=2,
                                     local_files_only=config.get('local_files_only', False),
                                     allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model', '*.jinja',
                                                     'LICENSE*', *(['*.py'] if config.get('trust_remote_code') else [])])
        local_model = Path(snapshot)
        performance['weight_files_bytes'] = sum(file.stat().st_size for file in local_model.rglob('*.safetensors'))
        if config.get('cache', 'shared') == 'shared':
            staged = tempfile.TemporaryDirectory(prefix=config.get('line', 'w34-vlm') + '-')
            local_model = Path(staged.name) / 'model'
            shutil.copytree(snapshot, local_model, symlinks=False)
        performance['download_and_stage_s'] = time.monotonic() - started
        print('VLM_PROGRESS ' + json.dumps({'staged': model_id,
                                           'download_and_stage_s': performance['download_and_stage_s']}), flush=True)
        if family == 'qwen-vl' and 'Qwen3-VL' in model_id:
            from transformers import Qwen3VLForConditionalGeneration as Model
        elif family == 'qwen-vl' and 'Qwen2.5-VL' in model_id:
            from transformers import Qwen2_5_VLForConditionalGeneration as Model
        else:
            from transformers import AutoModelForImageTextToText as Model
        options = {'revision': config['revision'], 'torch_dtype': torch.bfloat16,
                   'device_map': {'': 0}, 'attn_implementation': 'sdpa',
                   'trust_remote_code': config.get('trust_remote_code', False), 'local_files_only': True}
        if config.get('trust_remote_code'):
            options['code_revision'] = config['code_revision']
        if config['quantization'] == 'bnb4':
            options['quantization_config'] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                                                               bnb_4bit_compute_dtype=torch.bfloat16,
                                                               bnb_4bit_use_double_quant=True,
                                                               llm_int8_skip_modules=['visual', 'lm_head'])
            performance['quantization'] = options['quantization_config'].to_dict()
        model = load_model(Model, local_model, options, config, performance)
        if config['quantization'] == 'native':
            native = getattr(model.config, 'quantization_config', None)
            if not native:
                raise RuntimeError('native quantization requires a checkpoint quantization configuration')
            performance['native_quantization'] = native.to_dict() if hasattr(native, 'to_dict') else native
            performance['quantizer_class'] = type(getattr(model, 'hf_quantizer', None)).__name__
        performance['parameter_bytes_by_dtype'] = {}
        for parameter in model.parameters():
            dtype = str(parameter.dtype)
            performance['parameter_bytes_by_dtype'][dtype] = (performance['parameter_bytes_by_dtype'].get(dtype, 0)
                                                              + parameter.numel() * parameter.element_size())
        performance['parameter_devices'] = sorted({parameter.device.type for parameter in model.parameters()})
        if performance['parameter_devices'] != ['cuda']:
            raise RuntimeError('this benchmark requires all parameters on the one assigned GPU')
        quantized = [name for name, module in model.named_modules() if type(module).__name__ == 'Linear4bit']
        performance['quantized_linear_modules'] = len(quantized)
        performance['vision_quantized_linear_modules'] = sum('visual' in name for name in quantized)
        performance['output_head_quantized_linear_modules'] = sum(name.endswith('lm_head') for name in quantized)
        if config['quantization'] == 'bnb4' and (not quantized or performance['vision_quantized_linear_modules']
                                                or performance['output_head_quantized_linear_modules']):
            raise RuntimeError('expected NF4 language linears and unquantized vision/output modules')
        processor_options = {'revision': config['revision'], 'trust_remote_code': config.get('trust_remote_code', False),
                             'local_files_only': True}
        if config.get('trust_remote_code'):
            processor_options['code_revision'] = config['code_revision']
        if family == 'qwen-vl':
            processor_options.update(min_pixels=256 * 28 * 28, max_pixels=768 * 768)
        processor = load_processor(AutoProcessor, local_model, processor_options, config, model.config)
        performance['processor'] = {'class': type(processor).__name__,
                                    'image_class': type(processor.image_processor).__name__,
                                    'image_config': processor.image_processor.to_dict()}
        performance['model_revision'] = getattr(model.config, '_commit_hash', None) or config['revision']
        performance['load_s'] = time.monotonic() - started
        performance['loaded_allocated_gib'] = torch.cuda.memory_allocated() / 1024 ** 3
        print('VLM_PROGRESS ' + json.dumps({'loaded': model_id, 'load_s': performance['load_s'],
                                           'allocated_gib': performance['loaded_allocated_gib']}), flush=True)

        def infer(item, ask, variant=None):
            if critique:
                images = [checked_image(image_path(item, 'full'))]
            elif item.get('kind') == 'group':
                left, right = [checked_image(image_path(item, name)) for name in ('left', 'right')]
                # Each source is already sanitized; the composite also remains <=768 pixels.
                left.thumbnail((380, 736))
                right.thumbnail((380, 736))
                canvas = Image.new('RGB', (768, max(left.height, right.height)), 'white')
                canvas.paste(left, (0, 0))
                canvas.paste(right, (388, 0))
                images = [canvas]
            else:
                images = [checked_image(image_path(item, name)) for name in ('full', 'face') if name in item['images']]
            if critique:
                from ml.observe.critique import build_prompt
                rendered = build_prompt(artifact, facts=item.get('specialist_facts', []), variant=variant)
                text = rendered['user']
                torch.manual_seed(config['seeds'][ask])
            else:
                text = prompt(item, ask, questions, config['seed'], config.get('prompt_format', 'plain'))
            content = [{'type': 'text', 'text': text},
                       *[{'type': 'image', 'image': image} for image in images]]
            messages = ([{'role': 'system', 'content': rendered['system']}] if critique else []) + [
                {'role': 'user', 'content': content}]
            inputs, generation_options = prepare_inputs(processor, messages, images, config)
            inputs = inputs.to('cuda')
            if critique and 'prompt_integrity' not in performance:
                decoded = processor.tokenizer.decode(inputs.input_ids[0], skip_special_tokens=False)
                performance['prompt_integrity'] = {
                    'system_present': rendered['system'] in decoded,
                    'user_present': rendered['user'] in decoded,
                    'input_text_sha256': hashlib.sha256(decoded.encode()).hexdigest()}
                print('VLM_PROGRESS ' + json.dumps({'prompt_integrity': performance['prompt_integrity']}), flush=True)
            input_length = inputs.input_ids.shape[1]
            if input_length + config['max_new_tokens'] > 4096:
                raise ValueError('bounded 4096-token context exceeded')
            torch.cuda.synchronize()
            t0 = time.monotonic()
            with torch.inference_mode():
                output = model.generate(**inputs, do_sample=False, max_new_tokens=config['max_new_tokens'],
                                        use_cache=True, **generation_options)
            torch.cuda.synchronize()
            elapsed = time.monotonic() - t0
            result = processor.batch_decode(output[:, input_length:], skip_special_tokens=True)[0]
            return result, elapsed, int(output.shape[1] - input_length), input_length

        if rows:
            first = next(((row, variant) for row in rows for variant in critique_variants(row, config)), None) if critique else (rows[0], None)
            if first:
                infer(first[0], 0, first[1])
        torch.cuda.reset_peak_memory_stats()
        inference_started = time.monotonic()
        variants = config.get('variants', ['A', 'B']) if critique else [None]
        performance['memory_by_variant'] = {}
        for variant in variants:
            batch = [row for row in rows if not critique or variant in critique_variants(row, config)]
            if critique:
                torch.cuda.reset_peak_memory_stats()
            for index, row in enumerate(batch):
                for ask in range(config['asks']):
                    t0 = time.monotonic()
                    try:
                        content, elapsed, tokens, input_tokens = infer(row, ask, variant)
                        prediction = (critique_prediction(row, ask, variant, content, artifact, config) if critique else
                                      {'id': row['id'], 'ask': ask, 'content': content})
                        prediction.update(elapsed_s=elapsed, output_tokens=tokens, input_tokens=input_tokens,
                                          wall_s=time.monotonic() - t0)
                    except Exception as exc:
                        prediction = (critique_prediction(row, ask, variant, '', artifact, config) if critique else
                                      {'id': row['id'], 'ask': ask, 'content': ''})
                        prediction.update(error=type(exc).__name__, elapsed_s=time.monotonic() - t0)
                        if isinstance(exc, torch.cuda.OutOfMemoryError):
                            predictions.append(prediction)
                            raise
                    predictions.append(prediction)
                    print('VLM_ROW ' + json.dumps(prediction, ensure_ascii=False), flush=True)
                if index % 20 == 0:
                    print('VLM_PROGRESS ' + json.dumps({'items': index + 1, 'total': len(batch), 'variant': variant,
                                                       'elapsed_s': time.monotonic() - inference_started}), flush=True)
            if critique:
                performance['memory_by_variant'][variant] = {
                    'peak_allocated_gib': torch.cuda.max_memory_allocated() / 1024 ** 3,
                    'peak_reserved_gib': torch.cuda.max_memory_reserved() / 1024 ** 3}
        performance['inference_wall_s'] = time.monotonic() - inference_started
        performance['calls'] = len(predictions)
        good = [p for p in predictions if not p.get('error')]
        performance['failed_calls'] = len(predictions) - len(good)
        times = sorted(p['elapsed_s'] for p in good)
        performance['latency_p50_s'] = statistics.median(times) if times else None
        performance['latency_p95_s'] = times[min(len(times) - 1, int(len(times) * .95))] if times else None
        performance['wall_latency'] = latency_summary([p['wall_s'] for p in good])
        sets = {row['id']: row['set'] for row in rows}
        performance['wall_latency_by_set'] = {key: latency_summary([p['wall_s'] for p in good if sets[p['id']] == key])
                                               for key in sorted(set(sets.values()))}
        performance['generation_latency_by_set'] = {key: latency_summary([p['elapsed_s'] for p in good if sets[p['id']] == key])
                                                     for key in sorted(set(sets.values()))}
        if critique:
            performance['wall_latency_by_variant'] = {v: latency_summary([p['wall_s'] for p in good if p['variant'] == v])
                                                      for v in variants}
            performance['generation_latency_by_variant'] = {v: latency_summary([p['elapsed_s'] for p in good if p['variant'] == v])
                                                            for v in variants}
        performance['calls_per_second'] = len(good) / performance['inference_wall_s']
        performance['peak_allocated_gib'] = torch.cuda.max_memory_allocated() / 1024 ** 3
        performance['peak_reserved_gib'] = torch.cuda.max_memory_reserved() / 1024 ** 3
        if critique and performance['memory_by_variant']:
            for key in ('peak_allocated_gib', 'peak_reserved_gib'):
                performance[key] = max(value[key] for value in performance['memory_by_variant'].values())
        memory = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
                                capture_output=True, text=True, timeout=10)
        process_memory = []
        for line in memory.stdout.splitlines():
            parts = [part.strip() for part in line.split(',')]
            if len(parts) == 2 and parts[0] == str(os.getpid()) and parts[1].isdigit():
                process_memory.append(int(parts[1]) / 1024)
        performance['process_gpu_gib_after_inference'] = max(process_memory, default=None)
        performance['memory_caveat'] = 'Allocator peaks exclude CUDA context; process memory is an end sample, not a peak.'
        performance['generated_tokens_per_second'] = sum(p.get('output_tokens', 0) for p in good) / sum(times) if times else None
        performance['within_12_gib_allocator'] = performance['peak_reserved_gib'] <= 12
        performance['within_configured_gib_allocator'] = performance['peak_reserved_gib'] <= config['vram_limit_gib']
        if critique:
            emit('report.json', critique_report(rows, predictions, config))
        elif Path('ml/observe/vlm_eval.py').exists():
            from ml.observe.vlm_eval import evaluate
            emit('report.json', evaluate(rows, predictions))
        else:
            emit('report.json', {'status': 'scoring_deferred', 'items': len(rows), 'calls': len(predictions)})
    except Exception as exc:
        emit('failure.json', {'error': type(exc).__name__, 'message': str(exc), 'traceback': traceback.format_exc()})
        raise
    finally:
        if sampler:
            performance['sampled_memory'] = sampler.finish()
        performance['total_s'] = time.monotonic() - started
        emit('predictions.jsonl', ''.join(json.dumps(p, ensure_ascii=False) + '\n' for p in predictions))
        emit('performance.json', performance)
        if staged:
            staged.cleanup()


if __name__ == '__main__':
    main()
