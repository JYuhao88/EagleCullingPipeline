#!/usr/bin/env python3
"""Stream one explicit encoder job's verified artifacts into its bounded cache."""
import argparse
import asyncio
import base64
from collections import deque
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

import aiohttp

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/cache/w33-encoder'
SPEC = importlib.util.spec_from_file_location('encoder_submit', Path(__file__).with_name('observe-encoder-ray.py'))
SUBMIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBMIT)
sys.path.insert(0, str(ROOT))
from ml.common.private_env import jobs_url

REPORT = 'ENCODER_REPORT '
ARTIFACT = 'ENCODER_ARTIFACT '
MAX_LINE = 512 * 1024
MAX_CHUNK = 192 * 1024
SOURCE = re.compile(r'([a-z0-9-]+/(?:fp32|fp16)/(?:oi|panel|p0))\.(?:npz|json)')
MILESTONES = {'materialized', 'verified', 'session', 'model-complete', 'training-complete', 'complete'}


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


class Collector:
    def __init__(self, job, output):
        self.job = SUBMIT.checked_job(job)
        self.output = Path(output).resolve()
        cache = CACHE.resolve()
        if self.output != cache and cache not in self.output.parents:
            raise ValueError('encoder output must remain under data/cache/w33-encoder')
        self.output.mkdir(parents=True, exist_ok=True)
        self.report_name = job + '-reports.jsonl'
        self.reports = self.private_stream(self.report_name, append=True)
        self.pending = ''
        self.discarding = False
        self.active, self.saved, self.latest, self.shown = {}, {}, {}, {}
        self.log_tail = deque(maxlen=32)
        self.final_error = None
        self.report_count, self.expected = 0, None
        self.required = set()

    def path(self, name):
        path = self.output / name
        resolved = path.resolve()
        if self.output not in resolved.parents or path.is_symlink():
            raise ValueError('encoder destination escapes its output directory')
        return path

    def private_stream(self, name, append=False):
        path = self.path(name)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_TRUNC), 0o600)
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, 'a' if append else 'w', encoding='utf-8')

    def emit(self, value):
        print(json.dumps(value, ensure_ascii=False), flush=True)

    def feed(self, text):
        # Ray may split a JSON line across WebSocket messages. Unknown long
        # log lines are discarded without retaining or printing their content.
        parts = text.split('\n')
        for index, part in enumerate(parts):
            ended = index < len(parts) - 1
            if not self.discarding:
                self.pending += part
                if len(self.pending) > MAX_LINE:
                    if self.pending.startswith((REPORT, ARTIFACT)):
                        raise ValueError('encoder log record exceeds its bounded line size')
                    self.log_tail.append('[non-encoder log line exceeded limit]')
                    self.pending, self.discarding = '', True
            if ended:
                if not self.discarding:
                    self.line(self.pending.rstrip('\r'))
                self.pending, self.discarding = '', False

    def line(self, line):
        if line.startswith(REPORT):
            row = json.loads(line[len(REPORT):])
            if not isinstance(row, dict):
                raise ValueError('encoder report must be an object')
            self.reports.write(json.dumps(row, ensure_ascii=False) + '\n')
            self.reports.flush()
            self.report_count += 1
            stage = row.get('stage')
            if stage == 'verified':
                models = row.get('models', [])
                selections = row.get('precisions')
                if selections is not None and (not isinstance(selections, dict) or set(selections) != set(models)):
                    raise ValueError('encoder precision selection differs from the verified models')
                for model in models:
                    if not isinstance(model, str) or not re.fullmatch(r'[a-z0-9-]+', model):
                        raise ValueError('unexpected encoder id in verification report')
                    precisions = ('fp32', 'fp16') if selections is None else selections[model]
                    if (not isinstance(precisions, (list, tuple)) or not precisions
                            or any(p not in ('fp32', 'fp16') for p in precisions) or len(set(precisions)) != len(precisions)):
                        raise ValueError('invalid encoder precision selection')
                    for precision in precisions:
                        self.required.update((f'{model}/model-{precision}.json', f'{model}/training-{precision}.json'))
                        for source in ('oi', 'panel', 'p0'):
                            self.required.update(f'{model}/{precision}/{source}.{suffix}' for suffix in ('npz', 'json'))
            completed, total = row.get('completed'), row.get('total')
            if isinstance(stage, str) and type(completed) is int and type(total) is int:
                self.latest[stage] = row
                if completed >= self.shown.get(stage, 0) + 2000 or completed == total:
                    self.progress(stage)
            elif stage in MILESTONES:
                self.emit({'report': row})
            if stage == 'complete':
                expected = row.get('artifacts')
                if type(expected) is not int or expected < 1:
                    raise ValueError('encoder completion report lacks an artifact count')
                self.expected = expected
        elif line.startswith(ARTIFACT):
            self.artifact(json.loads(line[len(ARTIFACT):]))
        elif line:
            self.log_tail.append(line[-2048:])

    def progress(self, stage):
        row = self.latest.get(stage)
        if row and row['completed'] != self.shown.get(stage):
            self.emit({'report': row})
            self.shown[stage] = row['completed']

    def artifact(self, row):
        if not isinstance(row, dict):
            raise ValueError('encoder artifact must be an object')
        name, index, count = row.get('name'), row.get('index'), row.get('count')
        sha, data = row.get('sha256'), row.get('data')
        if not isinstance(name, str) or not SUBMIT.ARTIFACT.fullmatch(name):
            raise ValueError('unexpected encoder artifact')
        if (type(index) is not int or type(count) is not int or not 0 <= index < count
                or not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{64}', sha)
                or not isinstance(data, str) or len(data) > MAX_CHUNK):
            raise ValueError('invalid encoder artifact metadata')
        if len(data) % 4 or (index < count - 1 and '=' in data):
            raise ValueError('invalid encoder artifact chunk boundary')
        chunk = base64.b64decode(data, validate=True)
        if name not in self.active:
            if index != 0:
                raise ValueError('encoder artifact must start at chunk zero')
            previous = self.saved.get(name)
            if previous and (previous['sha256'] != sha or previous['chunks'] != count):
                raise ValueError('inconsistent replayed encoder artifact metadata')
            target, part = self.path(name), self.path(name + '.part')
            target.parent.mkdir(parents=True, exist_ok=True)
            reused = target.is_file() and digest(target) == sha
            self.active[name] = {'stream': None if reused else part.open('wb'), 'hash': hashlib.sha256(),
                                 'index': 0, 'count': count, 'sha256': sha, 'bytes': 0, 'reused': reused}
        item = self.active[name]
        if index != item['index'] or count != item['count'] or sha != item['sha256']:
            raise ValueError('encoder artifact chunk sequence or metadata mismatch')
        if item['stream'] is not None:
            item['stream'].write(chunk)
        item['hash'].update(chunk)
        item['bytes'] += len(chunk)
        item['index'] += 1
        if item['index'] != count:
            return
        if item['stream'] is not None:
            item['stream'].close()
        if item['hash'].hexdigest() != sha:
            raise ValueError('encoder artifact checksum mismatch')
        if not item['reused']:
            self.path(name + '.part').replace(self.path(name))
        self.saved[name] = {'name': name, 'sha256': sha, 'bytes': item['bytes'], 'chunks': count}
        del self.active[name]
        source = SOURCE.fullmatch(name)
        if source:
            self.progress(source[1])
        self.emit({'saved': name, 'sha256': sha, 'bytes': item['bytes'], 'reused': item['reused']})

    def finish(self, status=None):
        if self.pending and not self.discarding:
            try:
                self.line(self.pending.rstrip('\r'))
            except Exception:
                self.final_error = 'invalid final encoder log record'
        self.pending = ''
        extraction = [name for name in self.saved if '/training-' not in name and '/head-' not in name]
        reasons = [self.final_error] if self.final_error else []
        if self.active:
            reasons.append('incomplete artifact chunks')
        if self.required - self.saved.keys():
            reasons.append('missing required encoder, feature or training artifacts')
        if 'encoder-results.json' not in self.saved or self.expected is None:
            reasons.append('missing encoder completion artifacts or report')
        elif len(extraction) != self.expected:
            reasons.append('encoder artifact count differs from completion report')
        if status != 'SUCCEEDED':
            reasons.append('encoder job has not succeeded')
        error_file = self.job + '-errors.log' if reasons and self.log_tail else None
        if error_file:
            with self.private_stream(error_file) as stream:
                stream.write('\n'.join(self.log_tail) + '\n')
        result = {'job': self.job, 'jobStatus': status, 'complete': not reasons,
                  'artifacts': list(self.saved.values()), 'reportFile': self.report_name, 'reportCount': self.report_count,
                  'errorFile': error_file,
                  'incomplete': [{'name': name, 'received': item['index'], 'expected': item['count']}
                                 for name, item in self.active.items()], 'reasons': reasons}
        part = self.path('collection.json.part')
        part.write_text(json.dumps(result, indent=2) + '\n')
        part.replace(self.path('collection.json'))
        if reasons:
            raise ValueError('incomplete encoder collection; inspect collection.json')
        return result

    def close(self):
        self.reports.close()
        for item in self.active.values():
            if item['stream'] is not None:
                item['stream'].close()


async def fetch(job, output):
    SUBMIT.checked_job(job)
    url = jobs_url() + job
    websocket = url.replace('https://', 'wss://', 1).replace('http://', 'ws://', 1) + '/logs/tail'
    collector = Collector(job, output)
    status = None
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=30)) as session:
            async with session.ws_connect(websocket, max_msg_size=4 * 1024 * 1024) as socket:
                async for message in socket:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        collector.feed(message.data)
                    elif message.type == aiohttp.WSMsgType.ERROR:
                        raise RuntimeError('encoder log WebSocket failed')
                if socket.exception():
                    raise RuntimeError('encoder log WebSocket failed')
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                response.raise_for_status()
                status = (await response.json()).get('status')
        result = collector.finish(status)
        collector.emit({'stage': 'collection-complete', 'artifacts': len(result['artifacts']), 'jobStatus': status})
        return result
    except BaseException:
        try:
            collector.finish(status)
        except Exception:
            pass
        raise
    finally:
        collector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--id', required=True)
    parser.add_argument('--output', type=Path, default=CACHE)
    args = parser.parse_args()
    try:
        asyncio.run(fetch(args.id, args.output))
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'error': type(error).__name__, 'collectionComplete': False}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
