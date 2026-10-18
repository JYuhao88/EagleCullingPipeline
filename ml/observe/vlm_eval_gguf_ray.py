"""Pinned llama.cpp CUDA evaluation on Ray; only sanitized images reach loopback."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import statistics
import struct
import sys
import subprocess
import tarfile
import tempfile
import time
import traceback
import threading
import urllib.error
import urllib.request

from ml.observe.vlm_eval_ray import (MemorySampler, checked_image, emit, image_path, prompt, select_rows)


def command(args, timeout, env=None, cwd=None):
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError('command failed: ' + json.dumps(args[:3]) + '\n' + output[-18000:])
    return output


def unpack(archive, destination):
    with tarfile.open(archive) as stream:
        for member in stream.getmembers():
            if member.issym() or member.islnk() or not (destination / member.name).resolve().is_relative_to(destination.resolve()):
                raise ValueError('unsafe source archive member')
        stream.extractall(destination)


def build(config, performance, workspace):
    revision = config['llama_revision']
    cache = Path(os.environ['ECP_CEPH_ROOT']) / 'research/w35-vlm-moe/llama-cuda' / revision
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / 'cuda90-server.tar.gz'
    receipt = cache / 'build.json'
    destination = workspace / 'installed'
    destination.mkdir()
    if archive.exists() and receipt.exists():
        unpack(archive, destination)
        performance['build'] = {**json.loads(receipt.read_text()), 'cache_hit': True}
        binary = destination / 'bin/llama-server'
        if hashlib.sha256(binary.read_bytes()).hexdigest() != performance['build']['binary_sha256']:
            raise RuntimeError('cached llama-server binary checksum mismatch')
        return binary
    started = time.monotonic()
    deadline = started + config.get('build_timeout_s', 3600)
    def run(args, cwd=None, env=None):
        return command(args, max(1, deadline - time.monotonic()), env, cwd)
    performance['build'] = {'revision': revision, 'cache_hit': False, 'started_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    nvcc = shutil.which('nvcc')
    if not nvcc:
        nvcc = next((str(p) for p in (Path('/usr/local/cuda/bin/nvcc'),) if p.exists()), None)
    if not nvcc:
        raise RuntimeError('CUDA compiler nvcc is unavailable on the Ray node')
    print('VLM_PROGRESS ' + json.dumps({'build_started': revision, 'build_timeout_s': config.get('build_timeout_s', 3600)}), flush=True)
    performance['build']['nvcc'] = run([nvcc, '--version'])
    performance['build']['cmake'] = run(['cmake', '--version'])
    source_archive = workspace / 'llama-source.tar.gz'
    url = f"https://codeload.github.com/{config.get('llama_repo', 'ggml-org/llama.cpp')}/tar.gz/{revision}"
    with urllib.request.urlopen(url, timeout=min(120, max(1, deadline - time.monotonic()))) as response, source_archive.open('wb') as out:
        shutil.copyfileobj(response, out)
    source_root = workspace / 'source'
    source_root.mkdir()
    unpack(source_archive, source_root)
    source = next(p for p in source_root.iterdir() if p.is_dir())
    target = workspace / 'build'
    flags = ['cmake', '-S', str(source), '-B', str(target), '-DCMAKE_BUILD_TYPE=Release',
             '-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=90', '-DLLAMA_CURL=OFF',
             '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=ON',
             '-DCMAKE_CUDA_COMPILER=' + nvcc]
    performance['build']['flags'] = [arg.replace(str(workspace), '<workspace>') for arg in flags]
    performance['build']['source_archive_sha256'] = hashlib.sha256(source_archive.read_bytes()).hexdigest()
    performance['build']['configure_log'] = run(flags)[-18000:]
    print('VLM_PROGRESS ' + json.dumps({'build_configured': revision, 'elapsed_s': time.monotonic() - started}), flush=True)
    performance['build']['compile_log'] = run(['cmake', '--build', str(target), '--target', 'llama-server', '-j', '2'])[-18000:]
    performance['build']['elapsed_s'] = time.monotonic() - started
    (destination / 'bin').mkdir()
    for file in (target / 'bin').iterdir():
        if file.is_file():
            shutil.copy2(file, destination / 'bin' / file.name)
    binary = destination / 'bin/llama-server'
    if not binary.exists():
        raise RuntimeError('CUDA build did not produce llama-server')
    version = run([str(binary), '--version'])
    performance['build']['version'] = version
    performance['build']['binary_sha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
    temporary = archive.with_suffix('.tmp')
    with tarfile.open(temporary, 'w:gz') as stream:
        stream.add(destination / 'bin', arcname='bin', recursive=True)
    temporary.replace(archive)
    receipt.write_text(json.dumps(performance['build'], indent=2) + '\n')
    return binary


def gguf_metadata(path, inspect_tensors=False):
    formats = {0:'B', 1:'b', 2:'H', 3:'h', 4:'I', 5:'i', 6:'f', 7:'?', 10:'Q', 11:'q', 12:'d'}
    size_bytes = path.stat().st_size
    with path.open('rb') as stream:
        def read(fmt):
            size = struct.calcsize('<' + fmt)
            raw = stream.read(size)
            if len(raw) != size:
                raise ValueError('truncated GGUF metadata')
            return struct.unpack('<' + fmt, raw)[0]
        def string(keep):
            length = read('Q')
            if length > size_bytes - stream.tell():
                raise ValueError('invalid GGUF string length')
            if keep:
                return stream.read(length).decode('utf-8')
            stream.seek(length, 1)
        def value(kind, keep):
            if kind in formats:
                result = read(formats[kind])
                return result if keep else None
            if kind == 8:
                return string(keep)
            if kind == 9:
                subtype, count = read('I'), read('Q')
                if count > 10000000:
                    raise ValueError('unbounded GGUF metadata array')
                if subtype in formats and not keep:
                    stream.seek(count * struct.calcsize('<' + formats[subtype]), 1)
                    return None
                result = [value(subtype, keep) for _ in range(count)]
                return result if keep else None
            raise ValueError('unsupported GGUF metadata type')
        if stream.read(4) != b'GGUF' or read('I') != 3:
            raise ValueError('expected GGUF version 3')
        tensors, count = read('Q'), read('Q')
        if count > 100000:
            raise ValueError('unbounded GGUF metadata count')
        result = {'tensor_count': tensors}
        seen = set()
        for _ in range(count):
            key = string(True)
            if key in seen:
                raise ValueError('duplicate GGUF metadata key')
            seen.add(key)
            keep = key.startswith(('clip.', 'qwen35moe.')) or key in ('general.architecture', 'general.name', 'general.file_type', 'general.quantization_version', 'general.alignment', 'tokenizer.chat_template')
            item = value(read('I'), keep)
            if stream.tell() > size_bytes:
                raise ValueError('truncated GGUF metadata')
            if keep:
                result[key] = item
        if inspect_tensors:
            if tensors > 1000000:
                raise ValueError('unbounded GGUF tensor count')
            descriptors = []
            for _ in range(tensors):
                name, dimensions = string(True), read('I')
                if not 1 <= dimensions <= 4:
                    raise ValueError('unsupported GGUF tensor dimensions')
                shape = [read('Q') for _ in range(dimensions)]
                descriptors.append({'name': name, 'shape': shape, 'type': read('I'), 'offset': read('Q')})
            alignment = result.get('general.alignment', 32)
            if not isinstance(alignment, int) or alignment < 1 or alignment > 1048576:
                raise ValueError('invalid GGUF alignment')
            data_start = ((stream.tell() + alignment - 1) // alignment) * alignment
            ordered = sorted(descriptors, key=lambda row: row['offset'])
            layers = {}
            for index, row in enumerate(ordered):
                end = ordered[index + 1]['offset'] if index + 1 < len(ordered) else size_bytes - data_start
                if row['offset'] < 0 or end <= row['offset'] or data_start + end > size_bytes:
                    raise ValueError('invalid GGUF tensor span')
                match = re.fullmatch(r'blk\.(\d+)\.ffn_(?:gate|up|down)_exps\.weight', row['name'])
                if match:
                    layer = layers.setdefault(match[1], {'serialized_span_bytes': 0, 'tensors': []})
                    span = end - row['offset']
                    layer['serialized_span_bytes'] += span
                    layer['tensors'].append({**row, 'serialized_span_bytes': span})
            result['routed_expert_layers'] = layers
            result['tensor_descriptor_sha256'] = hashlib.sha256(json.dumps(descriptors, sort_keys=True).encode()).hexdigest()
            result['span_scope'] = 'serialized tensor span including alignment until next tensor; static capacity proxy, not CUDA allocation'
        return result


def download(config, performance):
    from huggingface_hub import hf_hub_download
    files = list(dict.fromkeys([*config['model_files'], config['mmproj_file']]))
    result = {}
    records = []
    for name in files:
        projector = name == config['mmproj_file']
        repo = config.get('mmproj_model', config['model']) if projector else config['model']
        revision = config.get('mmproj_revision', config['revision']) if projector else config['revision']
        started = time.monotonic()
        print('VLM_PROGRESS ' + json.dumps({'downloading': name}), flush=True)
        path = Path(hf_hub_download(repo, name, revision=revision, token=False))
        print('VLM_PROGRESS ' + json.dumps({'download_finished': name, 'bytes': path.stat().st_size, 'elapsed_s': time.monotonic() - started}), flush=True)
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 ** 2), b''):
                digest.update(chunk)
        expected = config.get('file_sha256', {}).get(name)
        if expected and digest.hexdigest() != expected:
            raise RuntimeError('GGUF checksum mismatch: ' + name)
        records.append({'name': name, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest(),
                        'metadata': gguf_metadata(path, inspect_tensors=True)})
        result[name] = path
    performance['weight_files'] = records
    if config.get('compression'):
        projector = next(row['metadata'] for row in records if row['name'] == config['mmproj_file'])
        expected = 2 if config['compression'] == 4 else 4
        if (projector.get('clip.projector_type') != 'minicpmv4_7'
                or projector.get('clip.vision.projector.scale_factor') != expected):
            raise ValueError('MiniCPM projector does not match the requested visual compression')
    return result


def server_args(binary, files, config, port):
    return [str(binary), '-m', str(files[config['model_files'][0]]), '--mmproj', str(files[config['mmproj_file']]),
            '--host', '127.0.0.1', '--port', str(port), '-lv', '4', '-ngl', str(config.get('n_gpu_layers', 99)),
            '--n-cpu-moe', str(config.get('n_cpu_moe', 0)), '-c', str(config.get('context_size', 4096)),
            '-b', str(config.get('batch_size', 512)), '-ub', str(config.get('ubatch_size', 128)),
            '-t', str(config.get('threads', 2)), '-tb', str(config.get('threads', 2)),
            '--parallel', '1', '--no-cont-batching', '--jinja', '--reasoning', 'off',
            '--reasoning-format', 'deepseek',
            '--chat-template-kwargs', '{"enable_thinking":false}', '--no-warmup', '--no-context-shift']


def cuda_probe(load_log):
    match = re.search(r'offloaded\s+(\d+)/(\d+)\s+layers to GPU', load_log)
    if not match or int(match[1]) == 0 or match[1] != match[2] or 'CUDA0' not in load_log:
        raise RuntimeError('llama-server did not confirm the full requested CUDA layer placement')
    return {'offloaded_layers': int(match[1]), 'total_layers': int(match[2]), 'cuda_backend': True}


def payload(item, ask, questions, config, image_urls):
    text = prompt(item, ask, questions, config['seed'], config['prompt_format'])
    return {'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': text},
                *[{'type': 'image_url', 'image_url': {'url': url}} for url in image_urls]]}],
            'temperature': 0, 'seed': config['seed'], 'max_tokens': config['max_new_tokens'],
            'stream': False, 'cache_prompt': False, 'top_k': 1, 'repeat_penalty': 1.0,
            'frequency_penalty': 0.0, 'presence_penalty': 0.0,
            'chat_template_kwargs': {'enable_thinking': False}}


def response_record(result, http_s, config):
    message = result['choices'][0]['message']
    content = message['content']
    if not isinstance(content, str):
        raise ValueError('non-text model response')
    reasoning = message.get('reasoning_content')
    if reasoning is not None and (not isinstance(reasoning, str) or reasoning.strip()):
        raise ValueError('unexpected reasoning with thinking disabled')
    timing = result.get('timings', {})
    usage = result.get('usage', {})
    cached = usage.get('prompt_tokens_details', {}).get('cached_tokens')
    if cached != 0:
        raise ValueError('missing zero-cache accounting or unexpected prompt reuse')
    n_prompt = usage.get('prompt_tokens', timing.get('prompt_n'))
    n_output = usage.get('completion_tokens', timing.get('predicted_n'))
    if (not isinstance(n_prompt, int) or not isinstance(n_output, int) or min(n_prompt, n_output) < 0
            or n_prompt + config['max_new_tokens'] > config['context_size']):
        raise ValueError('missing token accounting or bounded context exceeded')
    compute = [timing.get(key) for key in ('prompt_ms', 'predicted_ms')]
    if any(not isinstance(value, (int, float)) or not 0 <= value < float('inf') for value in compute):
        raise ValueError('missing or invalid server compute timing')
    elapsed = sum(compute) / 1000
    return {'content': content, 'elapsed_s': elapsed, 'server_compute_s': elapsed, 'http_s': http_s,
            'input_tokens': n_prompt, 'output_tokens': n_output, 'cached_tokens': cached, 'server_timings': timing,
            'reasoning_content': reasoning, 'finish_reason': result['choices'][0].get('finish_reason')}


def parse_sanity(items, predictions):
    from ml.observe.vlm_eval import parse_answers, parse_group
    index = {item['id']: item for item in items}
    result = {}
    for row in predictions:
        item = index[row['id']]
        counts = result.setdefault(item['set'], {'calls': 0, 'fully_parsed_calls': 0})
        counts['calls'] += 1
        if item.get('kind') == 'group':
            valid = parse_group(row.get('content')) is not None
        else:
            valid = all(value is not None for value in parse_answers(row.get('content'), item['questions']).values())
        counts['fully_parsed_calls'] += int(valid and not row.get('error'))
    return result


def images(item):
    import base64
    from PIL import Image
    if item.get('kind') == 'group':
        left, right = [checked_image(image_path(item, name)) for name in ('left', 'right')]
        left.thumbnail((380, 736))
        right.thumbnail((380, 736))
        canvas = Image.new('RGB', (768, max(left.height, right.height)), 'white')
        canvas.paste(left, (0, 0))
        canvas.paste(right, (388, 0))
        sources = [canvas]
    else:
        sources = [checked_image(image_path(item, name)) for name in ('full', 'face') if name in item['images']]
    urls = []
    for source in sources:
        buffer = io.BytesIO()
        # PNG preserves the decoded sanitized JPEG pixels; transport stays inside the assigned Ray node.
        source.save(buffer, format='PNG')
        urls.append('data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode())
    return urls


def http(opener, endpoint, value=None, timeout=300):
    request = urllib.request.Request(endpoint, data=None if value is None else json.dumps(value).encode(),
                                     headers={'Content-Type': 'application/json'})
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError('llama-server HTTP ' + str(exc.code) + ': ' + exc.read(4096).decode(errors='replace')) from None


def latencies(values):
    values = sorted(values)
    return {'n': len(values), 'p50_s': statistics.median(values) if values else None,
            'p95_s': values[min(len(values) - 1, int(len(values) * .95))] if values else None}


def shard_rows(rows, index, count):
    if count not in (1, 2) or not 0 <= index < count or len({row['id'] for row in rows}) != len(rows):
        raise ValueError('invalid replica partition or duplicate item identity')
    return rows[index::count]


def combine_predictions(rows, partitions, asks):
    predictions = []
    for index, part in enumerate(partitions):
        expected = {(row['id'], ask) for row in shard_rows(rows, index, len(partitions)) for ask in range(asks)}
        identities = [(row['id'], row['ask']) for row in part]
        if any(type(row['ask']) is not int or type(row.get('replica_index')) is not int for row in part):
            raise ValueError('replica and ask identities must be integers')
        if len(set(identities)) != len(identities) or set(identities) != expected:
            raise ValueError('replica predictions do not cover their exact item partition')
        if any(row.get('replica_index') != index for row in part):
            raise ValueError('prediction replica identity mismatch')
        predictions.extend(part)
    order = {row['id']: index for index, row in enumerate(rows)}
    return sorted(predictions, key=lambda row: (order[row['id']], row['ask']))


def prediction_metrics(performance, rows, predictions):
    good = [row for row in predictions if not row.get('error')]
    performance['calls'] = len(predictions)
    performance['failed_calls'] = len(predictions) - len(good)
    performance['generation_latency'] = latencies([row['elapsed_s'] for row in good])
    performance['wall_latency'] = latencies([row['wall_s'] for row in good])
    sets = {row['id']: row['set'] for row in rows}
    for key, field in [('generation', 'elapsed_s'), ('wall', 'wall_s')]:
        performance[key + '_latency_by_set'] = {name: latencies([row[field] for row in good if sets[row['id']] == name]) for name in sorted(set(sets.values()))}
    performance['parse_sanity'] = parse_sanity(rows, predictions)


def kill_replica_groups(processes):
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def replicas_main(config, rows, assigned):
    from ml.observe.vlm_eval import evaluate
    started = time.monotonic()
    performance = {'config': config, 'items': len(rows), 'backend': 'llama.cpp CUDA / isolated loopback replicas',
                   'partition': 'frozen selected-manifest ordinal modulo replicas; all asks stay together', 'replicas': []}
    predictions, processes, readers, progress = [], [], [], [[] for _ in assigned]
    failure = None
    previous_handler = signal.getsignal(signal.SIGTERM)
    def interrupted(_signum, _frame):
        raise RuntimeError('GGUF replica coordinator terminated; partial answers retained')
    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix='w35-gguf-replicas-') as temporary:
        workspace = Path(temporary)
        try:
            binary = build(config, performance, workspace)
            t0 = time.monotonic()
            files = download(config, performance)
            performance['download_s'] = time.monotonic() - t0
            lock = threading.Lock()
            def forward(stream, index):
                for line in stream:
                    with lock:
                        if line.startswith('VLM_ROW '):
                            progress[index].append(json.loads(line[len('VLM_ROW '):]))
                        sys.stdout.write(line)
                        sys.stdout.flush()
            for index, device in enumerate(assigned):
                folder = workspace / ('replica-' + str(index))
                folder.mkdir()
                spec = {**config, 'replicas': 1, '_replica_index': index, '_replica_count': len(assigned),
                        '_result_dir': str(folder), '_staged': {'binary': str(binary),
                        'files': {name: str(path) for name, path in files.items()},
                        'build': performance['build'], 'weight_files': performance['weight_files']}}
                spec_path = folder / 'config.json'
                spec_path.write_text(json.dumps(spec))
                process = subprocess.Popen([sys.executable, '-m', 'ml.observe.vlm_eval_gguf_ray', '--replica-spec', str(spec_path)],
                    env={**os.environ, 'CUDA_VISIBLE_DEVICES': device}, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True, start_new_session=True)
                processes.append(process)
                reader = threading.Thread(target=forward, args=(process.stdout, index), daemon=True)
                reader.start()
                readers.append(reader)
            while any(process.poll() is None for process in processes):
                if any(process.poll() not in (None, 0) for process in processes):
                    kill_replica_groups(processes)
                    break
                time.sleep(.5)
            codes = [process.wait() for process in processes]
            kill_replica_groups(processes)
            for reader in readers:
                reader.join(timeout=2)
                if reader.is_alive():
                    raise RuntimeError('replica log reader did not close after process-group cleanup')
            partitions = []
            for index, code in enumerate(codes):
                folder = workspace / ('replica-' + str(index))
                part = [json.loads(line) for line in (folder / 'predictions.jsonl').read_text().splitlines()] if (folder / 'predictions.jsonl').exists() else progress[index]
                predictions.extend(part)
                child = json.loads((folder / 'performance.json').read_text()) if (folder / 'performance.json').exists() else {}
                performance['replicas'].append({'index': index, 'exit_code': code, **child})
                partitions.append(part)
            if any(codes):
                raise RuntimeError('one or more isolated GGUF replicas failed; partial predictions retained')
            predictions = combine_predictions(rows, partitions, config['asks'])
            children = performance['replicas']
            if not all(child['cuda_placement']['cuda_backend'] for child in children):
                raise RuntimeError('missing per-replica CUDA proof')
            for child in children:
                if (child['build']['binary_sha256'] != performance['build']['binary_sha256']
                        or child['weight_files'] != performance['weight_files']
                        or child['chat_template_sha256'] != children[0]['chat_template_sha256']):
                    raise RuntimeError('replica weights, binary or chat template differ')
            performance['cuda_placement'] = {'cuda_backend': True, 'replicas': len(children)}
            performance['gpu'] = ' / '.join(child['gpu'] for child in children)
            performance['warmup_calls'] = len(children)
            performance['inference_wall_s'] = max(child['inference_ended_monotonic'] for child in children) - min(child['inference_started_monotonic'] for child in children)
            performance['replica_start_skew_s'] = max(child['inference_started_monotonic'] for child in children) - min(child['inference_started_monotonic'] for child in children)
            performance['inference_wall_scope'] = 'two independent GPU replicas, earliest inference start to latest end; throughput only'
            performance['sampled_memory'] = {'device_peak_gib': max(child['sampled_memory']['device_peak_gib'] for child in children),
                'interval_s': .5, 'scope': 'maximum individual replica GPU sampled peak, not sum; per-device samples retained under replicas'}
            prediction_metrics(performance, rows, predictions)
            emit('report.json', evaluate(rows, predictions))
        except Exception as exc:
            failure = {'error': type(exc).__name__, 'message': str(exc), 'traceback': traceback.format_exc()}
            raise
        finally:
            kill_replica_groups(processes)
            for process in processes:
                process.wait(timeout=5)
            for reader in readers:
                reader.join(timeout=2)
            if failure and any(progress):
                predictions = [row for part in progress for row in part]
            signal.signal(signal.SIGTERM, previous_handler)
            performance['total_s'] = time.monotonic() - started
            if failure:
                emit('failure.json', failure)
            emit('predictions.jsonl', ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in predictions))
            emit('performance.json', performance)


def main(replica_spec=None):
    if os.environ.get('ECP_RAY_WORKER') != '1' or sys.platform != 'linux':
        raise RuntimeError('GGUF model execution is restricted to the Linux Ray runtime')
    config = json.loads(Path(replica_spec or 'vlm-config.json').read_text())
    rows = select_rows([json.loads(line) for line in Path('manifest.jsonl').read_text().splitlines() if line], config['limit_per_set'])
    assigned = [v for v in os.environ.get('CUDA_VISIBLE_DEVICES', '').split(',') if v.strip()]
    if len(assigned) != config.get('replicas', 1) or len(set(assigned)) != len(assigned):
        raise RuntimeError('assigned CUDA GPU count must match isolated replicas')
    if config.get('replicas', 1) == 2:
        return replicas_main(config, rows, assigned)
    if replica_spec:
        rows = shard_rows(rows, config['_replica_index'], config['_replica_count'])
    def output(name, value):
        if replica_spec:
            raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
            (Path(config['_result_dir']) / name).write_text(raw)
        else:
            emit(name, value)
    questions = json.loads(Path('questions.json').read_text())['questions']
    predictions = []
    performance = {'config': config, 'items': len(rows), 'backend': 'llama.cpp CUDA / loopback llama-server', 'warmup_calls': 1,
                   'timing_scope': {'elapsed_s': 'server prompt_ms + predicted_ms; includes vision encoding/projection, prefill and decode; excludes HTTP and image decode/tokenize',
                                    'http_s': 'loopback request serialization, server image preparation and compute through response decode',
                                    'wall_s': 'checked image loading and lossless transport preparation plus complete HTTP call'}}
    started = time.monotonic()
    sampler = None
    process = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix='w35-gguf-') as temporary:
        workspace = Path(temporary)
        log = workspace / 'server.log'
        try:
            if len(assigned) != 1:
                raise RuntimeError('exactly one assigned CUDA GPU is required')
            performance['gpu'] = command(['nvidia-smi', '-i', assigned[0], '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], 10).strip()
            if replica_spec:
                performance['replica'] = {'index': config['_replica_index'], 'count': config['_replica_count'],
                    'items': len(rows), 'item_ids_sha256': hashlib.sha256('\n'.join(row['id'] for row in rows).encode()).hexdigest(),
                    'gpu_uuid': command(['nvidia-smi', '-i', assigned[0], '--query-gpu=uuid', '--format=csv,noheader'], 10).strip()}
            sampler = MemorySampler()
            sampler.thread.start()
            staged = config.get('_staged')
            if staged:
                binary = Path(staged['binary'])
                performance.update(build=staged['build'], weight_files=staged['weight_files'])
            else:
                binary = build(config, performance, workspace)
            runtime_env = dict(os.environ)
            runtime_env['LD_LIBRARY_PATH'] = str(binary.parent) + os.pathsep + os.environ.get('LD_LIBRARY_PATH', '')
            performance['build']['verified_binary_version'] = command([str(binary), '--version'], 30, env=runtime_env)
            if config.get('mode') == 'build':
                performance['server_help'] = command([str(binary), '--help'], 30, env=runtime_env)
                output('report.json', {'status': 'build_only', 'quality_evaluated': False})
                return
            t0 = time.monotonic()
            files = {name: Path(path) for name, path in staged['files'].items()} if staged else download(config, performance)
            performance['download_s'] = time.monotonic() - t0
            print('VLM_PROGRESS ' + json.dumps({'downloaded': config['model'], 'download_s': performance['download_s']}), flush=True)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            args = server_args(binary, files, config, port)
            performance['server_args'] = [arg.replace(str(workspace), '<workspace>') for arg in args]
            endpoint = 'http://127.0.0.1:' + str(port)
            with log.open('w') as server_output:
                process = subprocess.Popen(args, stdout=server_output, stderr=subprocess.STDOUT, env=runtime_env)
            deadline = time.monotonic() + config.get('server_start_timeout_s', 300)
            while True:
                if process.poll() is not None:
                    raise RuntimeError('llama-server exited during load: ' + log.read_text()[-18000:])
                try:
                    http(opener, endpoint + '/health', timeout=2)
                    break
                except (OSError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise TimeoutError('llama-server health deadline exceeded')
                    time.sleep(1)
            performance['load_s'] = time.monotonic() - started
            performance['server_properties'] = http(opener, endpoint + '/props')
            performance['chat_template_sha256'] = hashlib.sha256(performance['server_properties']['chat_template'].encode()).hexdigest()
            performance['server_load_log'] = log.read_text()[:500000]
            performance['cuda_placement'] = cuda_probe(performance['server_load_log'])
            print('VLM_PROBE ' + json.dumps(performance['cuda_placement']), flush=True)
            print('VLM_PROGRESS ' + json.dumps({'loaded': config['model'], 'load_s': performance['load_s']}), flush=True)
            def infer(item, ask):
                body = payload(item, ask, questions, config, images(item))
                t0 = time.monotonic()
                result = http(opener, endpoint + '/v1/chat/completions', body)
                elapsed = time.monotonic() - t0
                return response_record(result, elapsed, config)
            if rows:
                infer(rows[0], 0)
            inference_started = time.monotonic()
            performance['inference_started_monotonic'] = inference_started
            for index, item in enumerate(rows):
                for ask in range(config['asks']):
                    if process.poll() is not None:
                        raise RuntimeError('llama-server exited during evaluation')
                    t0 = time.monotonic()
                    try:
                        prediction = {'id': item['id'], 'ask': ask, **infer(item, ask), 'wall_s': time.monotonic() - t0}
                    except Exception as exc:
                        prediction = {'id': item['id'], 'ask': ask, 'content': '', 'error': type(exc).__name__,
                                      'message': str(exc), 'elapsed_s': time.monotonic() - t0}
                    predictions.append(prediction)
                    if replica_spec:
                        prediction['replica_index'] = config['_replica_index']
                    print('VLM_ROW ' + json.dumps(prediction, ensure_ascii=False), flush=True)
                if index % 20 == 0:
                    print('VLM_PROGRESS ' + json.dumps({'items': index + 1, 'total': len(rows), 'elapsed_s': time.monotonic() - inference_started}), flush=True)
            performance['inference_wall_s'] = time.monotonic() - inference_started
            performance['inference_ended_monotonic'] = time.monotonic()
            prediction_metrics(performance, rows, predictions)
            from ml.observe.vlm_eval import evaluate
            output('report.json', evaluate(rows, predictions))
            if config.get('limit_per_set') and any(not counts['fully_parsed_calls'] for counts in performance['parse_sanity'].values()):
                raise RuntimeError('smoke has no fully parsed questionnaire in an included set')
        except Exception as exc:
            output('failure.json', {'error': type(exc).__name__, 'message': str(exc), 'traceback': traceback.format_exc()})
            raise
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            if log.exists():
                performance['server_log_tail'] = log.read_text()[-30000:]
            if sampler:
                performance['sampled_memory'] = sampler.finish()
            performance['total_s'] = time.monotonic() - started
            performance['config'] = {key: value for key, value in config.items() if not key.startswith('_')}
            output('predictions.jsonl', ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in predictions))
            output('performance.json', performance)


if __name__ == '__main__':
    main(sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == '--replica-spec' else None)
