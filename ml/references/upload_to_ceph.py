#!/usr/bin/env python3
"""Serial, resumable local-to-Ceph transfer using CPU-only Ray Jobs packages."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, require_path, dashboard_url, merge_private_env
import argparse
import base64
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

CEPH = require_path('ECP_CEPH_ROOT') + '/references'
CAP = 90 * 1024 * 1024
# The write job's entrypoint carries the batch entries; Linux caps one argument at 128 KiB.
MAX_ENTRIES = 40
TEMP = Path('/tmp/ceph-upload')
TERMINAL = {'SUCCEEDED', 'FAILED', 'STOPPED'}


def digest(path, length=None):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        remaining = length
        while remaining is None or remaining > 0:
            data = handle.read(1024 * 1024 if remaining is None else min(1024 * 1024, remaining))
            if not data:
                break
            result.update(data)
            if remaining is not None:
                remaining -= len(data)
    return result.hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def state_identity(files):
    # Local paths are excluded so files can be reorganised on disk without losing resume state.
    keys = ('source', 'remote_rel', 'size', 'sha256')
    return hashlib.sha256(json.dumps([{k: item.get(k) for k in keys} for item in files], sort_keys=True).encode()).hexdigest()


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or '\\' in value or value.endswith('.part'):
        raise ValueError('unsafe remote_rel: ' + value)
    return str(path)


def validate_files(files):
    seen = set()
    for item in files:
        if not re.fullmatch(r'[a-z][a-z0-9-]*', item['source']):
            raise ValueError('invalid source')
        item['remote_rel'] = safe_relative(item['remote_rel'])
        key = (item['source'], item['remote_rel'])
        if key in seen:
            raise ValueError('duplicate destination')
        seen.add(key)
        path = Path(item['local'])
        if path.is_symlink() or not path.is_file():
            raise ValueError('not a regular local file: ' + str(path))
        size = path.stat().st_size
        if item.get('size', size) != size:
            raise ValueError('local size changed: ' + str(path))
        sha256 = digest(path)
        if item.get('sha256', sha256) != sha256:
            raise ValueError('local SHA-256 changed: ' + str(path))
        item.update(size=size, sha256=sha256)
    return files


def plan(root, probe=True):
    root = Path(root).resolve()
    rules = [
        ('hanjing', '拍照姿势教学课程_韩晶', 'hanjing-posing', {'.mp4'}),
        ('liqiang', '李强第二期人像摄影韩系灯光课', 'liqiang-korean-lighting', {'.mp4'}),
        ('linhaiyin', '林海音/林海音：商业人像摄影课', 'commercial-portrait', {'.mp4'}),
        ('linhaiyin', '林海音/林海音第三期', 'season-3', {'.mp4', '.mkv'}),
        ('linhaiyin', '林海音/林海音（第二季更新）', 'season-2', {'.mp4'}),
    ]
    books = {'拍照姿势.pdf', '斯科特·凯尔比的自然光人像摄影手册.pdf',
             '斯科特 凯尔比的 风光摄影手册.pdf', '街头摄影  52个任务清单.pdf',
             '摄影技艺教程第7版_13241922.pdf'}
    selected = []
    for source, directory, slug, suffixes in rules:
        for path in sorted((root / directory).glob('*')):
            if path.is_file() and not path.is_symlink() and path.suffix.lower() in suffixes:
                if slug == 'commercial-portrait' and not path.name.endswith('.vip.mp4'):
                    continue
                selected.append({'source': source, 'local': str(path),
                                 'remote_rel': slug + '/' + path.parent.name + '/' + path.name})
    for path in sorted((root / '摄影').glob('*.pdf')):
        if path.name in books or any(path.name.startswith('美国纽约摄影学院摄影教材（' + volume + '册）')
                                     for volume in ('上', '下')):
            selected.append({'source': 'photo-books', 'local': str(path),
                             'remote_rel': 'photography-books/摄影/' + path.name})
    validate_files(selected)
    for item in selected:
        if Path(item['local']).suffix.lower() in {'.mp4', '.mkv'} and probe:
            result = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                                     '-of', 'json', item['local']], capture_output=True, text=True, check=True)
            info = json.loads(result.stdout)
            item['duration_seconds'] = float(info['format'].get('duration', 0))
            item['streams'] = [{key: stream.get(key) for key in ('codec_type', 'codec_name', 'width', 'height')}
                               for stream in info['streams']]
            if result.stderr:
                item['probe_warning'] = result.stderr[:2000]
        if item['remote_rel'].startswith('season-3/') and Path(item['local']).name == '1.mp4':
            item['known_issue'] = '视频流有解码错误；按要求保留，ffprobe 元数据不等于全流解码验证'
    selected_paths = {item['local'] for item in selected}
    duplicates = root / '林海音/林海音/林'
    skipped = []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or str(path) in selected_paths:
            continue
        reason = 'not in explicit allowlist'
        entry = {'local': str(path), 'size': path.stat().st_size}
        if path.is_relative_to(duplicates):
            sha256 = digest(path)
            matches = [item for item in selected if item['remote_rel'].startswith('commercial-portrait/')
                       and item['size'] == entry['size'] and item['sha256'] == sha256]
            if not matches:
                raise ValueError('duplicate not verified: ' + str(path))
            entry.update(sha256=sha256, duplicate_of=matches[0]['local'])
            reason = 'size and SHA-256 verified duplicate'
        elif path.suffix.lower() == '.vip':
            reason = 'encrypted .vip (not .vip.mp4)'
        elif path.suffix.lower() in {'.exe', '.apk', '.html', '.txt', '.jpg'} or path.name == '.DS_Store':
            reason = 'excluded extension; not opened or executed'
        entry['reason'] = reason
        skipped.append(entry)
    return {'version': 1, 'local_root': str(root), 'files': selected, 'skipped': skipped,
            'observations': {'duplicate_directory_exists': duplicates.exists(),
                             'duplicate_directory': str(duplicates)}}


def chunks(files, offsets, cap=CAP, max_entries=MAX_ENTRIES):
    batch, used = [], 0
    for item in files:
        offset = offsets.get(item['remote_rel'], 0)
        if offset < 0 or offset > item['size']:
            raise ValueError('invalid remote offset')
        while offset < item['size'] or (item['size'] == 0 and offset == 0):
            length = min(cap - used, item['size'] - offset)
            batch.append({**item, 'offset': offset, 'length': length,
                          'final': offset + length == item['size']})
            used += length
            offset += length
            if used == cap or len(batch) == max_entries:
                yield batch
                batch, used = [], 0
            if item['size'] == 0:
                break
    if batch:
        yield batch


WORKER = r'''
import hashlib,json,os
from pathlib import Path
os.umask(0o077)
def sha(path):
    result=hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            data=handle.read(1048576)
            if not data: break
            result.update(data)
    return result.hexdigest()
def target(item):
    root=Path(config['root'])/item['source']/'raw'
    path=root/item['remote_rel']
    if not root.resolve().is_relative_to(Path(config['root']).resolve()) or not path.resolve().is_relative_to(root.resolve()): raise ValueError('remote escape')
    return path
def cleanup(uris):
    import ray
    from ray.experimental.internal_kv import _internal_kv_del,_internal_kv_exists
    from ray._private.ray_constants import KV_NAMESPACE_PACKAGE
    ray.init(address='auto',logging_level='ERROR')
    result=[]
    for uri in uris:
        _internal_kv_del(uri.encode(),namespace=KV_NAMESPACE_PACKAGE)
        exists=_internal_kv_exists(uri.encode(),namespace=KV_NAMESPACE_PACKAGE)
        if exists: raise ValueError('package still exists: '+uri)
        result.append({'uri':uri,'exists_after':bool(exists)})
    return result
action=config['action']
result=[]
if action=='cleanup':
    result=cleanup(config['uris'])
else:
    for item in config['files']:
        path=target(item)
        part=Path(str(path)+'.part')
        if path.is_symlink() or part.is_symlink(): raise ValueError('remote file symlink')
        if action=='inspect':
            if not path.exists() and part.exists() and part.stat().st_size==item['size']:
                if sha(part)!=item['sha256']: raise ValueError('complete part SHA mismatch')
                part.replace(path)
            existing=path if path.exists() else part
            result.append({'remote_rel':item['remote_rel'],'complete':path.exists(),
                           'size':existing.stat().st_size if existing.exists() else 0,
                           'sha256':sha(existing) if existing.exists() else hashlib.sha256(b'').hexdigest()})
        elif action=='audit':
            actual=sha(path)
            if path.stat().st_size!=item['size'] or actual!=item['sha256']: raise ValueError('audit mismatch: '+str(path))
            parent=path.parent
            source_root=Path(config['root'])/item['source']
            modes={}
            while parent.is_relative_to(source_root):
                mode=parent.stat().st_mode & 0o777
                if mode!=0o700: raise ValueError('directory mode mismatch: '+str(parent))
                modes[str(parent)]=oct(mode)
                if parent==source_root: break
                parent=parent.parent
            if part.exists(): raise ValueError('completed file still has part: '+str(part))
            result.append({'source':item['source'],'remote_rel':item['remote_rel'],'size':item['size'],'sha256':actual,
                           'mode':oct(path.stat().st_mode & 0o777),'directory_modes':modes,'part_exists':False})
        elif action=='write':
            parent=path.parent
            source_root=Path(config['root'])/item['source']
            parent.mkdir(parents=True,exist_ok=True)
            while parent.is_relative_to(source_root):
                parent.chmod(0o700)
                if parent==source_root: break
                parent=parent.parent
            if path.exists():
                if path.stat().st_size!=item['size'] or sha(path)!=item['sha256']: raise ValueError('existing final mismatch')
                continue
            length=part.stat().st_size if part.exists() else 0
            if length<item['offset'] or length>item['offset']+item['length']: raise ValueError('part length mismatch')
            data=Path(item['chunk']).read_bytes()
            if hashlib.sha256(data).hexdigest()!=item['chunk_sha256']: raise ValueError('chunk mismatch')
            with part.open('r+b' if part.exists() else 'w+b') as handle:
                if length>item['offset']:
                    handle.seek(item['offset'])
                    if handle.read(length-item['offset'])!=data[:length-item['offset']]: raise ValueError('retry prefix mismatch')
                handle.seek(item['offset'])
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            if item['final']:
                if part.stat().st_size!=item['size'] or sha(part)!=item['sha256']: raise ValueError('file SHA mismatch')
                part.replace(path)
            result.append({'remote_rel':item['remote_rel'],'offset':item['offset']+item['length'],'complete':item['final']})
if action=='write':
    cleaned=cleanup([config['uri']])
    print('CLEANUP '+json.dumps(cleaned),flush=True)
print('UPLOAD_RESULT '+json.dumps(result),flush=True)
'''


def build_zip(path, batch, token):
    entries = []
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('worker.py', worker_source(WORKER, required=('ECP_CEPH_ROOT',)))
        archive.writestr('owner.txt', token)
        for index, chunk in enumerate(batch):
            with Path(chunk['local']).open('rb') as handle:
                handle.seek(chunk['offset'])
                data = handle.read(chunk['length'])
            if len(data) != chunk['length']:
                raise ValueError('short local read')
            name = 'chunk-' + str(index)
            archive.writestr(name, data)
            entries.append({**chunk, 'chunk': name, 'chunk_sha256': hashlib.sha256(data).hexdigest()})
    if Path(path).stat().st_size >= 100 * 1024 * 1024:
        raise ValueError('HTTP body limit exceeded')
    return entries


class HTTP:
    def __init__(self, dashboard=None, max_mbps=0):
        self.dashboard = (dashboard or dashboard_url()).rstrip('/')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.max_mbps = max_mbps

    def request(self, method, path, body=None):
        if method == 'POST' and path == '/api/jobs/' and body and 'entrypoint' in body:
            merge_private_env(body)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.dashboard + path, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        with self.opener.open(req, timeout=120) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}

    def upload(self, path, package):
        parsed = urllib.parse.urlsplit(self.dashboard)
        connection_type = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port, timeout=180)
        started = time.monotonic()
        sent = 0
        try:
            connection.putrequest('PUT', parsed.path + '/api/packages/gcs/' + package)
            connection.putheader('Content-Length', str(path.stat().st_size))
            connection.endheaders()
            with path.open('rb') as handle:
                while True:
                    data = handle.read(1024 * 1024)
                    if not data:
                        break
                    connection.send(data)
                    sent += len(data)
                    if self.max_mbps:
                        time.sleep(max(0, sent / (self.max_mbps * 1e6 / 8) - (time.monotonic() - started)))
            response = connection.getresponse()
            message = response.read()
            if response.status >= 300:
                raise RuntimeError('package PUT failed: ' + str(response.status) + ' ' + message.decode(errors='replace'))
        finally:
            connection.close()
        return {'bytes': sent, 'seconds': time.monotonic() - started}


class Uploader:
    def __init__(self, source, files, http, receipt_dir):
        self.source, self.files, self.http = source, files, http
        self.directory = TEMP / source
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = (self.directory / 'lock').open('w')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.state_path = self.directory / 'state.json'
        identity = state_identity(files)
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {
            'identity': identity, 'source': source, 'offsets': {}, 'jobs': [], 'batches': [], 'sessions': []}
        if self.state['identity'] != identity:
            self.lock.close()
            raise ValueError('manifest changed; use the original manifest/state')
        self.receipt = Path(receipt_dir) / (source + '_upload_receipt.json')
        self.persist()

    def persist(self):
        save(self.state_path, self.state)

    def wait(self, job):
        while True:
            info = self.http.request('GET', '/api/jobs/' + job['id'])
            if info['status'] in TERMINAL:
                job['status'] = info['status']
                self.persist()
                return info
            time.sleep(2)

    def delete_job(self, job):
        self.http.request('DELETE', '/api/jobs/' + job['id'])
        job['deleted'] = True
        self.persist()

    def run_job(self, action, files=None, uri=None, uris=None):
        config = {'action': action, 'root': CEPH, 'files': files or [], 'uri': uri, 'uris': uris or []}
        code = worker_source('config=' + repr(config) + '\n' + WORKER, required=('ECP_CEPH_ROOT',))
        if uri:
            entrypoint = 'python -c ' + shlex.quote('config=' + repr(config) + ';exec(open("worker.py").read())')
        else:
            encoded = base64.b64encode(code.encode()).decode()
            entrypoint = 'python -c ' + shlex.quote('import base64;exec(base64.b64decode(' + repr(encoded) + '))')
        job = {'id': 'w4-upload-' + self.source + '-' + uuid.uuid4().hex, 'action': action, 'uri': uri}
        self.state['jobs'].append(job)
        self.persist()
        body = {'submission_id': job['id'], 'entrypoint': entrypoint,
                'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0}
        if uri:
            body['runtime_env'] = {'working_dir': uri}
        merge_private_env(body)
        self.http.request('POST', '/api/jobs/', body)
        info = self.wait(job)
        logs = self.http.request('GET', '/api/jobs/' + job['id'] + '/logs')['logs']
        job['logs'] = logs
        self.persist()
        self.delete_job(job)
        if info['status'] != 'SUCCEEDED':
            raise RuntimeError('Ray job failed: ' + job['id'] + '\n' + logs)
        lines = [line.split('UPLOAD_RESULT ', 1)[1] for line in logs.splitlines() if line.startswith('UPLOAD_RESULT ')]
        if len(lines) != 1:
            raise RuntimeError('missing result marker: ' + job['id'])
        return json.loads(lines[0])

    def recover(self):
        for job in list(self.state['jobs']):
            if job.get('deleted'):
                continue
            try:
                self.wait(job)
                self.delete_job(job)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                job['deleted'] = True
                self.persist()
        uris = [batch['uri'] for batch in self.state['batches'] if not batch.get('cleaned')]
        if uris:
            self.run_job('cleanup', uris=uris)
            for batch in self.state['batches']:
                batch['cleaned'] = True
            self.persist()
        for path in self.directory.glob('*.zip'):
            path.unlink()

    def reconcile(self, remote):
        if len(remote) != len(self.files):
            raise ValueError('incomplete remote inspection')
        offsets = {}
        for item, observed in zip(self.files, remote):
            if observed['remote_rel'] != item['remote_rel'] or not 0 <= observed['size'] <= item['size']:
                raise ValueError('invalid remote inspection')
            if observed['complete'] and observed['size'] != item['size']:
                raise ValueError('remote final size mismatch')
            if digest(item['local'], observed['size']) != observed['sha256']:
                raise ValueError('remote prefix SHA-256 mismatch: ' + item['remote_rel'])
            offsets[item['remote_rel']] = observed['size']
        self.state['offsets'] = offsets
        self.persist()
        return offsets

    def upload(self):
        started = time.monotonic()
        session = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'uploaded_bytes': 0, 'put_seconds': 0}
        self.state['sessions'].append(session)
        try:
            self.state['status'] = 'running'
            self.state['ray_version'] = self.http.request('GET', '/api/version')['ray_version']
            self.persist()
            self.recover()
            self.state.pop('cleanup_error', None)
            offsets = self.reconcile(self.run_job('inspect', files=self.files))
            for batch in chunks(self.files, offsets):
                token = uuid.uuid4().hex
                path = self.directory / (token + '.zip')
                try:
                    entries = build_zip(path, batch, token)
                    package = '_ray_pkg_' + digest(path)[:32] + '.zip'
                    uri = 'gcs://' + package
                    record = {'uri': uri, 'payload_bytes': sum(item['length'] for item in batch), 'cleaned': False}
                    self.state['batches'].append(record)
                    self.persist()
                    transfer = self.http.upload(path, package)
                    session['uploaded_bytes'] += transfer['bytes']
                    session['put_seconds'] += transfer['seconds']
                    self.persist()
                    result = self.run_job('write', files=entries, uri=uri)
                    record['cleaned'] = True
                    record['completed_chunks'] = result
                    for item in result:
                        self.state['offsets'][item['remote_rel']] = item['offset']
                    self.persist()
                    print(self.source, 'BATCH_OK', len(self.state['batches']), record['payload_bytes'], flush=True)
                finally:
                    path.unlink(missing_ok=True)
            self.state['audit'] = self.run_job('audit', files=self.files)
            self.state['package_verification'] = self.run_job('cleanup', uris=[batch['uri'] for batch in self.state['batches']])
            owned = {job['id'] for job in self.state['jobs']}
            stable = 0
            for attempt in range(12):
                listed = self.http.request('GET', '/api/jobs/')
                remaining = [job for job in listed if job.get('submission_id') in owned]
                stable = 0 if remaining else stable + 1
                for observed in remaining:
                    if observed['status'] not in TERMINAL:
                        raise RuntimeError('owned job still active')
                    self.http.request('DELETE', '/api/jobs/' + observed['submission_id'])
                    self.state.setdefault('redeleted_job_records', []).append(observed['submission_id'])
                if stable >= 3:
                    break
                time.sleep(2)
            if stable < 3:
                raise RuntimeError('owned job records remain')
            self.state['cleanup_stable_empty_checks'] = stable
            self.state['owned_jobs_remaining'] = []
            self.state['status'] = 'complete'
            self.state.pop('cleanup_error', None)
        except BaseException:
            self.state['status'] = 'interrupted'
            try:
                self.recover()
            except Exception as error:
                self.state['cleanup_error'] = str(error)
            raise
        finally:
            session['elapsed_seconds'] = time.monotonic() - started
            session['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
            session['effective_MBps'] = session['uploaded_bytes'] / 1e6 / session['elapsed_seconds']
            session['put_MBps'] = session['uploaded_bytes'] / 1e6 / session['put_seconds'] if session['put_seconds'] else 0
            self.persist()
            save(self.receipt, {**self.state, 'dashboard': self.http.dashboard, 'files': self.files,
                                'payload_cap_bytes': CAP, 'http_limit_bytes': 100 * 1024 * 1024,
                                'nice': os.getpriority(os.PRIO_PROCESS, 0)})
            self.lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', nargs='?', type=Path)
    parser.add_argument('--plan', type=Path, metavar='ROOT')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--sources', nargs='+')
    parser.add_argument('--dashboard', default=None)
    parser.add_argument('--max-mbps', type=float, default=0, help='PUT limit in decimal megabits/s; 0 unlimited')
    parser.add_argument('--receipt-dir', type=Path, default=Path(__file__).resolve().parent / 'local')
    args = parser.parse_args()
    if args.max_mbps < 0:
        parser.error('--max-mbps must be nonnegative')
    if os.getpriority(os.PRIO_PROCESS, 0) < 10:
        os.nice(10 - os.getpriority(os.PRIO_PROCESS, 0))
    if args.plan:
        if not args.output:
            parser.error('--plan needs --output')
        save(args.output, plan(args.plan))
        return
    if not args.manifest:
        parser.error('manifest is required')
    manifest = json.loads(args.manifest.read_text())
    files = [{**item, 'source': item.get('source', manifest.get('source'))} for item in manifest['files']]
    sources = args.sources or sorted({item['source'] for item in files})
    if set(sources) - {item['source'] for item in files}:
        parser.error('unknown source')
    files = validate_files([item for item in files if item['source'] in sources])
    TEMP.mkdir(parents=True, exist_ok=True)
    with (TEMP / 'global.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for source in sources:
            Uploader(source, [item for item in files if item['source'] == source],
                     HTTP(args.dashboard or dashboard_url(), args.max_mbps), args.receipt_dir).upload()


if __name__ == '__main__':
    main()
