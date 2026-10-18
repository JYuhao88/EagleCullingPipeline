"""Stream bounded public artifacts from Ray log tail without buffering entire logs."""
import argparse
import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.common.private_env import jobs_url


async def fetch(identifier, output):
    output.mkdir(parents=True, exist_ok=True)
    state = {}
    pending = ''
    url = jobs_url().replace('https://', 'wss://', 1).replace('http://', 'ws://', 1) + identifier + '/logs/tail'
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=30)) as session:
            async with session.ws_connect(url, max_msg_size=4 * 1024 * 1024) as socket:
                async for message in socket:
                    if message.type != aiohttp.WSMsgType.TEXT:
                        continue
                    pending += message.data
                    lines = pending.split('\n')
                    pending = lines.pop()
                    for line in lines:
                        if line.startswith('REPORT '):
                            print(line, flush=True)
                        if not line.startswith('ARTIFACT '):
                            continue
                        record = json.loads(line[9:])
                        name = record['name']
                        if Path(name).name != name:
                            raise ValueError('Unsafe artifact filename')
                        if name not in state:
                            state[name] = {'stream': (output / (name + '.partial')).open('wb'), 'hash': hashlib.sha256(),
                                           'index': 0, 'count': record['count'], 'sha256': record['sha256']}
                        item = state[name]
                        if record['index'] != item['index'] or record['count'] != item['count']:
                            raise ValueError('Artifact chunk sequence mismatch')
                        chunk = base64.b64decode(record['data'], validate=True)
                        item['stream'].write(chunk); item['hash'].update(chunk); item['index'] += 1
                        if item['index'] % 256 == 0:
                            print(json.dumps({'artifact': name, 'chunks': item['index'], 'total': item['count']}), flush=True)
                        if item['index'] == item['count']:
                            item['stream'].close()
                            if item['hash'].hexdigest() != item['sha256']:
                                raise ValueError('Artifact checksum mismatch')
                            (output / (name + '.partial')).replace(output / name)
                            print(json.dumps({'saved': name, 'sha256': item['sha256']}), flush=True)
        if not state or any(item['index'] != item['count'] for item in state.values()):
            raise ValueError('Incomplete artifact transfer')
    finally:
        for item in state.values():
            item['stream'].close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(fetch(args.id, args.output))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
