#!/bin/sh
# Refreshes everything S4 binds to the prompt-bearing sources, in the order #269 used (35ff3e4, dba3c00):
#   1. re-registers the S4 prompt version p5_pilot012_rotation_memory_v1 from the CURRENT sources (existing rows are never touched);
#   2. takes the failure-path fixture once from the same sources into tests/fixtures/parity-verify/failure-path-v24-<short sha>/ (older fixtures stay),
#      with baseCommit set to the code commit, and points tests/parity-failure-fixture.test.ts at it.
# Usage (repository root, node on PATH, clean tree): sh docs/prompt-inventory-rotation-memory-20261128/s4-refresh.sh <code-commit>
# <code-commit> is the commit that contains the FINAL prompt-bearing sources (the manifest in diagnostics/parity-live/audit.ts lists them); commit the result afterwards.
# Any later change to one of those files (or to a producer file the fixture lists) needs another run.
set -e
[ -n "$1" ] || { echo "usage: sh $0 <code-commit>" >&2; exit 2; }
git diff --quiet HEAD -- dialogue-model || { echo "dialogue-model has uncommitted changes; commit the final sources first" >&2; exit 1; }
SHA=$(git rev-parse "$1")
SHORT=$(git rev-parse --short=7 "$1")
node --disable-warning=ExperimentalWarning docs/prompt-inventory-rotation-memory-20261128/s4-register-prompt-version.ts
DIR=tests/fixtures/parity-verify/failure-path-v24-$SHORT
rm -rf "$DIR"
node --disable-warning=ExperimentalWarning tests/support/generate-failure-fixture.ts "$DIR"
sed -i.bak "s/\"baseCommit\": \"[0-9a-f]*\"/\"baseCommit\": \"$SHA\"/" "$DIR/capture-metadata.json" && rm -f "$DIR/capture-metadata.json.bak"
chmod 644 "$DIR/capture-metadata.json" "$DIR/producer-records.json"
sed -i.bak "s#failure-path-v24-[0-9a-f]*/#failure-path-v24-$SHORT/#; s#currentMetadata.baseCommit, \"[0-9a-f]*\"#currentMetadata.baseCommit, \"$SHA\"#" tests/parity-failure-fixture.test.ts && rm -f tests/parity-failure-fixture.test.ts.bak
echo "registered the version, took $DIR from $SHA, and pointed tests/parity-failure-fixture.test.ts at it"
