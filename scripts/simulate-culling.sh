#!/bin/sh
# One-command bootstrap. All external tooling and browser downloads live in /tmp.
set -eu
w8_repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export TMPDIR=/tmp
export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers
mkdir -p /tmp/w8-simulate-qa
if [ ! -f /tmp/pw/node_modules/playwright/index.mjs ]; then
  nice -n 10 npm i --cache /tmp/w8-npm-cache --prefix /tmp/pw playwright \
    > /tmp/w8-simulate-qa/playwright-install.log 2>&1
fi
if [ -z "${W8_BROWSER:-}" ]; then
  # A download failure is evidence, not successful setup. The runner still emits
  # a blocked report for the missing browser, instead of silently dropping QA.
  nice -n 10 /tmp/pw/node_modules/.bin/playwright install chromium \
    > /tmp/w8-simulate-qa/chromium-install.log 2>&1 || true
fi
cd "$w8_repo"
exec nice -n 10 node scripts/simulate-culling.mjs
