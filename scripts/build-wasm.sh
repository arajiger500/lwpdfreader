#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
wasm-pack build core --target web --out-dir ../src/wasm --release -- --locked
rm -f src/wasm/.gitignore src/wasm/package.json src/wasm/README.md
