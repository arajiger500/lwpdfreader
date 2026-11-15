#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Panic/source locations in dependencies otherwise embed each host's Cargo path.
# Encoded flags preserve spaces in checkout paths and override ambient RUSTFLAGS.
lwpdf_root=$(pwd -P)
lwpdf_cargo_root=${CARGO_HOME:-$HOME/.cargo}
lwpdf_flag_separator=$(printf '\037')
export CARGO_INCREMENTAL=0
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$lwpdf_root=/lwpdfreader${lwpdf_flag_separator}--remap-path-prefix=$lwpdf_cargo_root=/cargo"
wasm-pack build core --target web --out-dir ../src/wasm --release -- --locked
node scripts/normalize-wasm.mjs src/wasm/lwpdf_core_bg.wasm
rm -f src/wasm/.gitignore src/wasm/package.json src/wasm/README.md
