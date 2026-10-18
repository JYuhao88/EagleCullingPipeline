"""Two independent one-GPU critique workers inside one admitted Ray job."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

from ml.observe.vlm_eval_ray import critique_report, critique_rows, critique_variants, emit, latency_summary


def devices(value):
    result = value.split(',') if isinstance(value, str) else []
    if len(result) != 2 or len(set(result)) != 2 or any(not item.strip() or item != item.strip() for item in result):
        raise ValueError('exactly two distinct assigned CUDA devices are required')
    return result


def artifact(chunks, name):
    entry = chunks.get(name)
    if not entry:
        return None
    if set(entry['parts']) != set(range(entry['count'])):
        raise ValueError('incomplete replica artifact')
    raw = base64.b64decode(''.join(entry['parts'][index] for index in range(entry['count'])), validate=True)
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise ValueError('replica artifact checksum mismatch')
    return json.loads(raw)


def merge_performance(config, performances, predictions, elapsed):
    result = dict(performances[0]) if performances else {}
    good = [row for row in predictions if not row.get('error')]
    variants = config['variants']
    memory = ('peak_allocated_gib', 'peak_reserved_gib')
    expected = config.get('replicas', 2)

    def measured(values, operation=max):
        return operation(values) if len(values) == expected and all(
            type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in values) else None

    result.update(config=config, replicas=performances, replica_count=len(performances),
                  execution='independent single-GPU replicas; each photo and both asks stay on one GPU',
                  calls=len(predictions), failed_calls=len(predictions) - len(good), total_s=elapsed,
                  items=sum(row.get('items', 0) for row in performances),
                  warmup_calls=sum(row.get('warmup_calls', 0) for row in performances),
                  load_s=max((row.get('load_s', 0) for row in performances), default=0),
                  inference_wall_s=max((row.get('inference_wall_s', 0) for row in performances), default=0))
    for key in memory:
        values = [row.get(key) for row in performances]
        result[key] = measured(values)
        result['sum_replica_' + key] = measured(values, sum)
    result['memory_by_variant'] = {
        variant: {**{key: measured([row.get('memory_by_variant', {}).get(variant, {}).get(key)
                                   for row in performances]) for key in memory},
                  'sum_replica_peak_reserved_gib': measured([row.get('memory_by_variant', {}).get(variant, {})
                                                           .get('peak_reserved_gib') for row in performances], sum)}
        for variant in variants}
    for prefix, field in (('wall', 'wall_s'), ('generation', 'elapsed_s')):
        result[prefix + '_latency_by_variant'] = {variant: latency_summary([row[field] for row in good
                                                                          if row['variant'] == variant])
                                                  for variant in variants}
        result[prefix + '_latency_by_set'] = {subset: latency_summary([row[field] for row in good if row['set'] == subset])
                                              for subset in sorted({row['set'] for row in predictions})}
    times = latency_summary([row['elapsed_s'] for row in good])
    result.update(latency_p50_s=times['p50_s'], latency_p95_s=times['p95_s'],
                  wall_latency=latency_summary([row['wall_s'] for row in good]),
                  within_12_gib_allocator=None if result['peak_reserved_gib'] is None else result['peak_reserved_gib'] <= 12,
                  within_configured_gib_allocator=None if result['peak_reserved_gib'] is None else result['peak_reserved_gib'] <= config['vram_limit_gib'],
                  process_gpu_gib_after_inference=measured([row.get('process_gpu_gib_after_inference') for row in performances]),
                  process_gpu_scope='maximum single-replica end sample, not a job-wide peak',
                  sampled_memory={'scope': 'per-device independent samples; use replicas for the full samples',
                                  'replicas': [row.get('sampled_memory') for row in performances]},
                  memory_caveat='Allocator peaks are maxima per single-GPU replica; their sum is an upper bound, '
                                'not a simultaneous peak. Process memory is the maximum replica end sample. '
                                'Missing replica measurements remain unknown. Latency is per call.')
    tokens = [row.get('output_tokens') for row in good]
    token_total = sum(tokens) if tokens and all(type(value) is int and value >= 0 for value in tokens) else None
    generation_seconds = sum(row['elapsed_s'] for row in good)
    result['generated_tokens_per_second'] = token_total / generation_seconds if token_total is not None and generation_seconds else None
    result['generated_tokens_per_second_scope'] = 'recorded output tokens / summed per-call generation seconds across replicas; not job throughput'
    result['generated_tokens_per_job_second'] = token_total / elapsed if token_total is not None and elapsed > 0 else None
    result['calls_per_second'] = len(good) / elapsed if elapsed > 0 else None
    result['job_throughput_scope'] = 'recorded successful calls or output tokens / total driver wall time, including model load and warmup'
    result['inference_wall_scope'] = 'maximum independent worker inference duration; workers do not share a start time'
    return result


def run(config, rows, worker_module='ml.observe.vlm_eval_ray'):
    if config.get('task') != 'critique' or config.get('replicas') != 2 or config.get('asks') != 2:
        raise ValueError('replicas require the unchanged two-ask critique task')
    assigned = devices(os.environ.get('CUDA_VISIBLE_DEVICES'))
    root = Path.cwd()
    rows = critique_rows(rows, config['limit_per_set'])
    processes, threads, records, predictions, failures = [], [], [{}, {}], [], []
    lock = threading.Lock()
    started = time.monotonic()

    def consume(index, stream):
        try:
            for line in stream:
                if line.startswith('VLM_ROW '):
                    row = json.loads(line.removeprefix('VLM_ROW '))
                    row['replica'] = index
                    with lock:
                        predictions.append(row)
                        print('VLM_ROW ' + json.dumps(row, ensure_ascii=False), flush=True)
                elif line.startswith('VLM_ARTIFACT '):
                    chunk = json.loads(line.removeprefix('VLM_ARTIFACT '))
                    entry = records[index].setdefault(chunk['name'], {**chunk, 'parts': {}})
                    if entry['count'] != chunk['count'] or entry['sha256'] != chunk['sha256']:
                        raise ValueError('inconsistent replica chunks')
                    entry['parts'][chunk['index']] = chunk['data']
                elif line.startswith('VLM_PROGRESS '):
                    value = json.loads(line.removeprefix('VLM_PROGRESS '))
                    print('VLM_PROGRESS ' + json.dumps({**value, 'replica': index}), flush=True)
        except Exception as exc:
            failures.append({'replica': index, 'error': type(exc).__name__})

    def stop(signum, frame):
        raise InterruptedError('replica job interrupted')

    prior = signal.signal(signal.SIGTERM, stop)
    try:
        with tempfile.TemporaryDirectory(prefix='w36-vlm-replicas-') as temporary:
            for index, device in enumerate(assigned):
                directory = Path(temporary) / str(index)
                directory.mkdir()
                child_rows = rows[index::2]
                child = {**config, 'replicas': 1, 'limit_per_set': 0}
                (directory / 'vlm-config.json').write_text(json.dumps(child))
                (directory / 'manifest.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in child_rows))
                names = {'ml', *[Path(value).parts[0] for row in child_rows if row.get('storage') == 'package'
                                for value in row['images'].values()]}
                for name in names:
                    (directory / name).symlink_to(root / name, target_is_directory=True)
                environment = {**os.environ, 'CUDA_VISIBLE_DEVICES': device}
                process = subprocess.Popen([sys.executable, '-m', worker_module], cwd=directory, env=environment,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                processes.append(process)
                thread = threading.Thread(target=consume, args=(index, process.stdout))
                thread.start()
                threads.append(thread)
            for thread in threads:
                thread.join()
            for index, process in enumerate(processes):
                if process.wait() != 0:
                    failures.append({'replica': index, 'error': 'worker_failed', 'exit_code': process.returncode})
    except Exception as exc:
        failures.append({'error': type(exc).__name__})
    finally:
        signal.signal(signal.SIGTERM, prior)
        for process in processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for thread in threads:
            thread.join(timeout=5)
        expected = {(row['id'], variant, ask) for row in rows for variant in critique_variants(row, config)
                    for ask in range(config['asks'])}
        actual = [(row['id'], row['variant'], row['ask']) for row in predictions]
        if len(set(actual)) != len(actual) or set(actual) != expected:
            failures.append({'error': 'incomplete_or_duplicate_replica_predictions'})
        performances = []
        for index, chunks in enumerate(records):
            try:
                performance = artifact(chunks, 'performance.json')
                failure = artifact(chunks, 'failure.json')
                if performance is None:
                    failures.append({'replica': index, 'error': 'missing_performance'})
                else:
                    performances.append(performance)
                if failure:
                    failures.append({'replica': index, **failure})
            except Exception as exc:
                failures.append({'replica': index, 'error': type(exc).__name__})
        emit('predictions.jsonl', ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in predictions))
        for name, build in [('performance.json', lambda: merge_performance(config, performances, predictions, time.monotonic() - started)),
                            ('report.json', lambda: critique_report(rows, predictions, config))]:
            try:
                emit(name, build())
            except Exception as exc:
                failures.append({'error': 'aggregation_failed', 'artifact': name, 'cause': type(exc).__name__})
                emit(name, {'task': 'critique', 'status': 'aggregation_failed', 'error': type(exc).__name__})
        if failures:
            emit('failure.json', {'error': 'replica_failure', 'replicas': failures})
    return not failures


if __name__ == '__main__':
    config = json.loads(Path('vlm-config.json').read_text())
    rows = [json.loads(line) for line in Path('manifest.jsonl').read_text().splitlines() if line]
    raise SystemExit(0 if run(config, rows) else 1)
