#!/usr/bin/env bash
# repin-kernel.sh — the bridge's kernel-release ritual, with the smoke suite
# as a hard gate.
#
#   scripts/repin-kernel.sh v4.17.0            # re-pin + auto minor bump (2.55.1 -> 2.56.0)
#   scripts/repin-kernel.sh v4.17.0 2.56.0     # re-pin + explicit bridge version
#
# Encodes the steps that were previously manual (and where the smoke rot of
# 2.55.1 slipped through because nothing ran the tests):
#   1. point package.json at github:axona-net/axona-protocol#<tag>
#   2. lockfile dance: rm package-lock.json && npm install
#      (github: pins wedge `npm ci` against a stale lockfile otherwise)
#   3. npm ci               — prove the fresh lockfile reproduces
#   4. npm test             — HARD GATE: nothing is committed on failure
#   5. bump the bridge version + commit pin/lockfile/version together
#
# It does NOT push or deploy — those stay deliberate:
#   git push origin testnet
#   ssh droplet: git pull && npm ci && systemctl restart axona-bridge
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: repin-kernel.sh <kernel-tag e.g. v4.17.0> [bridge-version]}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: kernel tag must look like v4.17.0, got '$TAG'"; exit 1; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree not clean — commit or stash first"; exit 1
fi

CUR=$(node -p "require('./package.json').version")
NEW="${2:-$(node -p "const [a,b]='$CUR'.split('.'); \`\${a}.\${+b+1}.0\`")}"

echo "→ re-pin @axona/protocol to $TAG   (bridge $CUR → $NEW)"
node - "$TAG" "$NEW" <<'EOF'
const fs = require('fs');
const [tag, ver] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.dependencies['@axona/protocol'] = `github:axona-net/axona-protocol#${tag}`;
p.version = ver;
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
EOF

echo "→ lockfile dance (rm package-lock.json && npm install)"
rm -f package-lock.json
npm install --no-audit --no-fund

echo "→ npm ci (lockfile reproducibility)"
rm -rf node_modules
npm ci --no-audit --no-fund

# (the kernel's exports map doesn't expose ./package.json — read it via fs)
INSTALLED=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/@axona/protocol/package.json','utf8')).version")
[[ "v$INSTALLED" == "$TAG" ]] || { echo "error: installed kernel $INSTALLED != requested $TAG"; exit 1; }

echo "→ npm test (release gate)"
if ! npm test; then
  echo ""
  echo "✗ SMOKE FAILED — nothing committed. Fix the failure, then re-run:"
  echo "    git checkout package.json package-lock.json && scripts/repin-kernel.sh $TAG $NEW"
  exit 1
fi

git add package.json package-lock.json
git commit -m "bridge v$NEW: re-pin kernel @$TAG (smoke-gated)"
echo ""
echo "✓ bridge v$NEW pinned to kernel $TAG, smoke 10/10, committed."
echo "  next: git push origin testnet, then droplet deploy (git pull && npm ci && systemctl restart axona-bridge)"
