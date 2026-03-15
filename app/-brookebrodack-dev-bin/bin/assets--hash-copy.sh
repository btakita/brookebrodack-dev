#!/bin/sh
# Copy assets from public/assets/ to dist/browser/ with content-hashed filenames.
# Matches the naming scheme used by esbuild-plugin-object-store-asset:
#   {name}-{SHA256_8_UPPER}{ext}
set -e

SRC_DIR="${1:-public/assets}"
DEST_DIR="${2:-app/brookebrodack-site/dist/browser}"

find "$SRC_DIR" -type f -print0 | while IFS= read -r -d '' file; do
  ext="${file##*.}"
  base="$(basename "$file" ".$ext")"
  hash=$(sha256sum < "$file" | cut -c1-8 | tr '[:lower:]' '[:upper:]')
  dest="$DEST_DIR/${base}-${hash}.${ext}"
  cp "$file" "$dest" 2>/dev/null || true
  echo "  ${base}-${hash}.${ext}"
done
