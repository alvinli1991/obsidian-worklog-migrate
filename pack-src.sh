#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

files=(
  .gitignore
  LICENSE
  README.md
  package.json
  package-lock.json
  tsconfig.json
  esbuild.config.mjs
  manifest.json
  versions.json
  pack-src.sh
  src
  tests
)

for file in "${files[@]}"; do
  if [[ ! -e "$file" ]]; then
    printf 'Missing source file: %s\n' "$file" >&2
    exit 1
  fi
done

temporary_dir="$(mktemp -d "$project_dir/.pack-src.XXXXXX")"
trap 'rm -rf -- "$temporary_dir"' EXIT

zip -q -X -r "$temporary_dir/src.zip" "${files[@]}" \
  -x '*.DS_Store' '*.map' '*/node_modules/*'
mv -f -- "$temporary_dir/src.zip" "$project_dir/src.zip"

printf 'Created %s\n' "$project_dir/src.zip"
