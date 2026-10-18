#!/usr/bin/env python3
"""Ray side of a batched AIHub call: read prepared requests, call the chat endpoint, print one result line each.

The key comes from a file inside the job package, never from env_vars, so it is not shown in the job listing.
Only ids, usage and model output are printed; requests and the key never reach the logs.
An optional config.json sets per-model concurrency and a spend cap; image parts may name a packaged file
({"type": "image_url", "image_file": "images/x.jpg"}) so a picture asked about several times travels once.
With imageRoot set, image_file is relative to that subdirectory of ECP_CEPH_ROOT instead.
"""
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
RETRY = (429, 500, 502, 503, 504)


def opener(proxy):
    return urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {}))


def call(url, key, body, proxy):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    with opener(proxy).open(request, timeout=180) as response:
        return json.load(response)


def relative_path(value, label):
    if (not isinstance(value, str) or not value or '\\' in value or Path(value).is_absolute()
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise ValueError(label + ' must be a relative path without traversal')
    return Path(value)


def image_path(name, config=None):
    relative = relative_path(name, 'image_file')
    if relative.suffix != '.jpg':
        raise ValueError('image_file must end in .jpg')
    config = config or {}
    if 'imageRoot' in config:
        subdirectory = relative_path(config['imageRoot'], 'imageRoot')
        value = os.environ.get('ECP_CEPH_ROOT')
        if not value or not Path(value).is_absolute():
            raise ValueError('ECP_CEPH_ROOT must be an absolute path when imageRoot is set')
        ceph = Path(value).resolve()
        images = (ceph / subdirectory).resolve()
        if ceph not in images.parents:
            raise ValueError('imageRoot outside Ceph root')
        file = (images / relative).resolve()
    else:
        images = (HERE / 'images').resolve()
        if HERE.resolve() not in images.parents:
            raise ValueError('images outside package')
        file = (HERE / relative).resolve()
    if images not in file.parents:
        raise ValueError('image outside image root')
    return file


def resolve(body, config=None):
    for message in body.get('messages', []):
        for part in message.get('content') if isinstance(message.get('content'), list) else []:
            if 'image_file' not in part:
                continue
            file = image_path(part.pop('image_file'), config)
            part['image_url'] = {'url': 'data:image/jpeg;base64,' + base64.b64encode(file.read_bytes()).decode()}
    return body


class Runner:
    def __init__(self, secret, config):
        self.secret, self.config = secret, config
        proxy = os.environ.get('HTTPS_PROXY')
        self.routes = [None] + ([proxy] if proxy else [])
        self.lock = threading.Lock()
        self.spent = 0.0
        self.gates = {}

    def cost(self, model, usage):
        price = (self.config.get('pricing') or {}).get(model)
        if not price:
            return 0.0
        return ((usage.get('prompt_tokens') or 0) * price['input']
                + (usage.get('completion_tokens') or 0) * price['output']) / 1e6 * price['usdToCny']

    def gate(self, model):
        with self.lock:
            if model not in self.gates:
                limit = (self.config.get('concurrency') or {}).get(model, 1)
                self.gates[model] = threading.Semaphore(limit)
            return self.gates[model]

    def attempt(self, body):
        last = None
        for proxy in list(self.routes):
            try:
                return call(self.secret['url'], self.secret['key'], body, proxy), None
            except urllib.error.HTTPError as error:
                last = {'status': error.code, 'error': error.read().decode(errors='replace')[:300]}
                if error.code not in (403, 407):
                    return None, last
            except Exception as error:  # this route failed; prefer the next one from now on
                last = {'status': 0, 'error': type(error).__name__ + ': ' + str(error)[:200]}
                with self.lock:
                    if len(self.routes) > 1 and self.routes[0] == proxy:
                        self.routes.append(self.routes.pop(0))
        return None, last

    def run(self, row):
        body = row['body']
        model = body.get('model')
        out = {'id': row['id']}
        budget = self.config.get('budgetCny')
        reserve = self.cost(model, {'prompt_tokens': 6000, 'completion_tokens': body.get('max_completion_tokens', 2048)})
        with self.gate(model):
            with self.lock:
                if budget is not None and self.spent + reserve > budget:
                    out.update(status='budget')
                    return out
                self.spent += reserve
            try:
                resolved = resolve(json.loads(json.dumps(body)), self.config)
                for attempt in range(3):
                    response, failure = self.attempt(resolved)
                    if response is not None or failure['status'] not in RETRY + (0,):
                        break
                    time.sleep(10 * (attempt + 1) ** 2)
            finally:
                with self.lock:
                    self.spent -= reserve
            if response is None:
                out.update(failure, attempts=attempt + 1)
                return out
            usage = response.get('usage') or {}
            with self.lock:
                self.spent += self.cost(model, usage)
            out.update(status=200, usage=usage, attempts=attempt + 1,
                       content=(response.get('choices') or [{}])[0].get('message', {}).get('content'))
            time.sleep(self.config.get('pauseSeconds', 1.5))
            return out


def main():
    secret = json.loads((HERE / 'secret.json').read_text())
    config = json.loads((HERE / 'config.json').read_text()) if (HERE / 'config.json').exists() else {}
    rows = [json.loads(line) for line in (HERE / 'requests.jsonl').read_text().splitlines() if line.strip()]
    runner = Runner(secret, config)
    workers = max(1, sum((config.get('concurrency') or {}).values()) or 1)
    printer = threading.Lock()

    def one(row):
        out = runner.run(row)
        with printer:
            print('MN_RESULT ' + json.dumps(out, ensure_ascii=False), flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, rows))
    print('MN_DONE ' + json.dumps({'requests': len(rows), 'spentCny': round(runner.spent, 4)}), flush=True)


if __name__ == '__main__':
    main()
