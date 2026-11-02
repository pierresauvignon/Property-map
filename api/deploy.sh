#!/usr/bin/env bash
# Zips api/index.mjs and updates the Lambda function code.
# Usage: bash api/deploy.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../infra/lib.sh"

ZIP_PATH="$(mktemp -d)/function.zip"
cd "$SCRIPT_DIR"
zip -q "$ZIP_PATH" index.mjs

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP_PATH"

rm -f "$ZIP_PATH"
