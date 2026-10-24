#!/usr/bin/env bash
# One-time setup: creates the two secrets in SSM Parameter Store (encrypted SecureString).
# They are generated here and never written to the repository.
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"

create_if_missing() {
  local name="$1"
  if aws ssm get-parameter --region "$REGION" --name "$name" >/dev/null 2>&1; then
    echo "exists:  $name"
  else
    aws ssm put-parameter --region "$REGION" --name "$name" --type SecureString \
      --value "$(openssl rand -base64 32 | tr -d '=+/')" --tags Key=project,Value=collabdoc >/dev/null
    echo "created: $name"
  fi
}

create_if_missing /collabdoc/session-secret
create_if_missing /collabdoc/admin-token
echo
echo "Admin token (for the #/admin page):"
echo "  aws ssm get-parameter --region $REGION --name /collabdoc/admin-token --with-decryption --query Parameter.Value --output text"
