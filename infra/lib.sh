# Sourced by the deploy scripts: loads infra/config.sh and derives names.
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$INFRA_DIR/config.sh" ]; then
  echo "infra/config.sh not found: cp infra/config.example.sh infra/config.sh and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$INFRA_DIR/config.sh"
export AWS_DEFAULT_REGION="$REGION"

TABLE_NAME="${NAME}"
WEB_BUCKET="${BUCKET_PREFIX}-web"
UPLOADS_BUCKET="${BUCKET_PREFIX}-uploads"
ROLE_NAME="${NAME}-api-role"
FUNCTION_NAME="${NAME}-api"
DIST_COMMENT="${NAME}"

# Written by provision.sh: the distribution id and domain it created.
STATE_FILE="$INFRA_DIR/.state"
[ -f "$STATE_FILE" ] && source "$STATE_FILE"
true
