#!/usr/bin/env bash
# Property Map infra provisioning — idempotent, safe to re-run.
#
# Reads infra/config.sh (copy it from config.example.sh first) and creates:
# a DynamoDB table, two private S3 buckets, the Lambda and its role, a
# CloudFront distribution in front of all three, and — if DOMAIN is set — an
# ACM certificate for it. Only touches resources named from NAME and
# BUCKET_PREFIX. Writes the distribution id to infra/.state for redeploy.sh.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
SCRIPT_DIR="$INFRA_DIR"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
GEN_DIR="$SCRIPT_DIR/.generated"     # JSON written here is output, not source
mkdir -p "$GEN_DIR"

# CloudFront's Origin Access Control does not sign request bodies, so an
# IAM-authed Function URL refuses every POST/PUT (and, behind an SPA error
# mapping, the failure even arrives as a 200 page of HTML). Instead the
# Function URL is public and CloudFront adds this secret header to every
# request it forwards; the Lambda rejects anything without it.
# Generated once, kept out of git.
SECRET_FILE="$SCRIPT_DIR/.origin-secret"
if [ ! -s "$SECRET_FILE" ]; then
  (umask 077; openssl rand -hex 32 > "$SECRET_FILE")
fi
ORIGIN_SECRET=$(cat "$SECRET_FILE")

# The Lambda's environment, written as JSON so MAIL_FROM may hold spaces.
lambda_env_file () {
  SITE="$1" TABLE_NAME="$TABLE_NAME" UPLOADS_BUCKET="$UPLOADS_BUCKET" \
  ORIGIN_SECRET="$ORIGIN_SECRET" MAIL_FROM="${MAIL_FROM:-}" \
  python3 -c '
import json, os, sys
e = os.environ
json.dump({"Variables": {
  "TABLE_NAME": e["TABLE_NAME"], "UPLOAD_BUCKET": e["UPLOADS_BUCKET"],
  "SITE_ORIGIN": e["SITE"], "ORIGIN_SECRET": e["ORIGIN_SECRET"], "MAIL_FROM": e["MAIL_FROM"],
}}, open(sys.argv[1], "w"))' "$GEN_DIR/lambda-env.json"
  echo "file://$GEN_DIR/lambda-env.json"
}

create_bucket () {
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$1" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$1" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
}

echo "=== 1. DynamoDB table ${TABLE_NAME} ==="
if aws dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  echo "Table $TABLE_NAME already exists, skipping create."
else
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists --table-name "$TABLE_NAME"
fi

# TTL: sessions expire on their own
TTL_STATUS=$(aws dynamodb describe-time-to-live --table-name "$TABLE_NAME" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)
if [ "$TTL_STATUS" = "ENABLED" ]; then
  echo "TTL already enabled."
else
  aws dynamodb update-time-to-live \
    --table-name "$TABLE_NAME" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null
  echo "TTL enabled on attribute 'ttl'."
fi

for B in "$WEB_BUCKET" "$UPLOADS_BUCKET"; do
  echo "=== 2. S3 bucket ${B} ==="
  if aws s3api head-bucket --bucket "$B" >/dev/null 2>&1; then
    echo "Bucket $B already exists, skipping create."
  else
    create_bucket "$B"
  fi
  aws s3api put-public-access-block --bucket "$B" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
done

echo "=== 3. IAM role ${ROLE_NAME} ==="
cat > "$GEN_DIR/trust-policy.json" <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME already exists, skipping create."
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$GEN_DIR/trust-policy.json" >/dev/null
  echo "Waiting for role propagation..."
  sleep 10
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# SES: the account's default configuration set is authorised separately from
# the identity, so both resources are needed or every send fails.
SES_STATEMENT=""
if [ -n "${SES_IDENTITY:-}" ]; then
  SES_STATEMENT=",
    {
      \"Sid\": \"SendEmail\",
      \"Effect\": \"Allow\",
      \"Action\": [\"ses:SendEmail\"],
      \"Resource\": [
        \"arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${SES_IDENTITY}\",
        \"arn:aws:ses:${REGION}:${ACCOUNT_ID}:configuration-set/*\"
      ]
    }"
fi

# This is the whole policy. Don't add grants by hand in the console: the next
# run of this script replaces the live policy with what is written here.
cat > "$GEN_DIR/inline-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}/index/*"
      ]
    },
    {
      "Sid": "UploadsBucketAccess",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${UPLOADS_BUCKET}/*"
    },
    {
      "Sid": "UploadsBucketList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${UPLOADS_BUCKET}"
    }${SES_STATEMENT}
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "${NAME}-api-inline" \
  --policy-document "file://$GEN_DIR/inline-policy.json"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Role ARN: $ROLE_ARN"

echo "=== 4. Lambda ${FUNCTION_NAME} ==="
if aws lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  echo "Lambda $FUNCTION_NAME already exists; leaving its code alone (redeploy.sh updates it)."
else
  ZIP="$GEN_DIR/function.zip"
  (cd "$SCRIPT_DIR/../api" && rm -f "$ZIP" && zip -q "$ZIP" index.mjs)
  for i in $(seq 1 10); do
    if aws lambda create-function --function-name "$FUNCTION_NAME" \
      --runtime nodejs22.x \
      --handler index.handler \
      --role "$ROLE_ARN" \
      --timeout 15 \
      --memory-size 512 \
      --environment "$(lambda_env_file "https://localhost")" \
      --zip-file "fileb://$ZIP" >/dev/null 2>&1; then
      echo "Lambda created."
      break
    fi
    echo "create-function failed (attempt $i), likely IAM propagation delay, retrying in 5s..."
    sleep 5
    if [ "$i" = "10" ]; then
      echo "Failed to create Lambda after retries." >&2
      exit 1
    fi
  done
fi
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

# Function URL with auth NONE: the origin secret above is what guards it.
if aws lambda get-function-url-config --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  aws lambda update-function-url-config --function-name "$FUNCTION_NAME" --auth-type NONE >/dev/null
else
  aws lambda create-function-url-config --function-name "$FUNCTION_NAME" --auth-type NONE >/dev/null
fi
aws lambda add-permission --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal "*" \
  --function-url-auth-type NONE >/dev/null 2>&1 || echo "Public Function URL permission already present."
FUNCTION_URL=$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --query 'FunctionUrl' --output text)
FUNCTION_URL_DOMAIN=$(echo "$FUNCTION_URL" | sed -E 's#https://([^/]+)/#\1#')
echo "Function URL: $FUNCTION_URL (rejects anything without the origin secret)"

CERT_ARN=""; CERT_STATUS="none"; VALIDATION_NAME=""; VALIDATION_VALUE=""
if [ -n "${DOMAIN:-}" ]; then
  echo "=== 5. ACM certificate for ${DOMAIN} ==="
  CERT_ARN=$(aws acm list-certificates --region us-east-1 \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" --output text | head -n1)
  if [ -n "$CERT_ARN" ] && [ "$CERT_ARN" != "None" ]; then
    echo "Certificate already requested: $CERT_ARN"
  else
    CERT_ARN=$(aws acm request-certificate \
      --domain-name "$DOMAIN" \
      --validation-method DNS \
      --region us-east-1 \
      --query CertificateArn --output text)
    echo "Requested certificate: $CERT_ARN"
    echo "Waiting a few seconds for validation options to populate..."
    sleep 10
  fi
  CERT_STATUS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 --query 'Certificate.Status' --output text)
  VALIDATION_NAME=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
  VALIDATION_VALUE=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
  echo "Certificate status: $CERT_STATUS"
fi

echo "=== 6. CloudFront distribution ==="
create_oac_if_missing () {
  local name="$1"
  local existing
  existing=$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='${name}'].Id" --output text)
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "$existing"
    return
  fi
  aws cloudfront create-origin-access-control \
    --origin-access-control-config "Name=${name},SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query 'OriginAccessControl.Id' --output text
}
OAC_WEB_ID=$(create_oac_if_missing "${NAME}-web-oac")
OAC_UPLOADS_ID=$(create_oac_if_missing "${NAME}-uploads-oac")

WEB_ORIGIN_DOMAIN="${WEB_BUCKET}.s3.${REGION}.amazonaws.com"
UPLOADS_ORIGIN_DOMAIN="${UPLOADS_BUCKET}.s3.${REGION}.amazonaws.com"

CACHING_DISABLED_POLICY="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST_POLICY="b689b0a8-53d0-40ab-baf2-68738e2966ac"
CACHING_OPTIMIZED_POLICY="658327ea-f89d-4fab-a63d-7e88639e58f6"
# Managed-SecurityHeadersPolicy: nosniff and friends on user uploads, so an
# uploaded file is never read by the browser as a page of our app.
SECURITY_HEADERS_POLICY="67f7725c-6f97-4210-82d7-5512b31e9d03"

uploads_behaviour () {
  cat <<EOF
      {
        "PathPattern": "$1",
        "TargetOriginId": "uploads-s3-origin",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${CACHING_OPTIMIZED_POLICY}",
        "ResponseHeadersPolicyId": "${SECURITY_HEADERS_POLICY}",
        "AllowedMethods": {
          "Quantity": 2, "Items": ["GET", "HEAD"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        }
      }
EOF
}

build_dist_config () {
  local use_alias="$1" caller_ref="$2" aliases_block viewer_cert_block
  if [ "$use_alias" = "true" ]; then
    aliases_block="\"Quantity\":1,\"Items\":[\"${DOMAIN}\"]"
    viewer_cert_block="\"ACMCertificateArn\":\"${CERT_ARN}\",\"SSLSupportMethod\":\"sni-only\",\"MinimumProtocolVersion\":\"TLSv1.2_2021\",\"CertificateSource\":\"acm\""
  else
    aliases_block="\"Quantity\":0,\"Items\":[]"
    viewer_cert_block="\"CloudFrontDefaultCertificate\":true"
  fi

  # No CustomErrorResponses on purpose: mapping 403/404 to index.html turns
  # every API failure into a 200 page of HTML. The app is one page anyway.
  cat <<EOF
{
  "CallerReference": "${caller_ref}",
  "Comment": "${DIST_COMMENT}",
  "Enabled": true,
  "Aliases": { ${aliases_block} },
  "DefaultRootObject": "index.html",
  "HttpVersion": "http2",
  "IsIPV6Enabled": true,
  "Origins": {
    "Quantity": 3,
    "Items": [
      {
        "Id": "web-s3-origin",
        "DomainName": "${WEB_ORIGIN_DOMAIN}",
        "OriginAccessControlId": "${OAC_WEB_ID}",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      },
      {
        "Id": "uploads-s3-origin",
        "DomainName": "${UPLOADS_ORIGIN_DOMAIN}",
        "OriginAccessControlId": "${OAC_UPLOADS_ID}",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      },
      {
        "Id": "lambda-origin",
        "DomainName": "${FUNCTION_URL_DOMAIN}",
        "CustomHeaders": {
          "Quantity": 1,
          "Items": [{ "HeaderName": "x-origin-secret", "HeaderValue": "${ORIGIN_SECRET}" }]
        },
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": 30,
          "OriginKeepaliveTimeout": 5
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "web-s3-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "Compress": true,
    "CachePolicyId": "${CACHING_OPTIMIZED_POLICY}",
    "AllowedMethods": {
      "Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    }
  },
  "CacheBehaviors": {
    "Quantity": 3,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "lambda-origin",
        "ViewerProtocolPolicy": "redirect-to-https",
        "Compress": true,
        "CachePolicyId": "${CACHING_DISABLED_POLICY}",
        "OriginRequestPolicyId": "${ALL_VIEWER_EXCEPT_HOST_POLICY}",
        "AllowedMethods": {
          "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        }
      },
$(uploads_behaviour "/photos/*"),
$(uploads_behaviour "/files/*")
    ]
  },
  "PriceClass": "PriceClass_100",
  "ViewerCertificate": { ${viewer_cert_block} }
}
EOF
}

EXISTING_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${DIST_COMMENT}'].Id" --output text)
if [ -n "$EXISTING_DIST_ID" ] && [ "$EXISTING_DIST_ID" != "None" ]; then
  DIST_ID="$EXISTING_DIST_ID"
  echo "Distribution already exists: $DIST_ID (left as it is)"
else
  USE_ALIAS="false"
  [ "$CERT_STATUS" = "ISSUED" ] && USE_ALIAS="true"
  build_dist_config "$USE_ALIAS" "${NAME}-$(date +%s)" > "$GEN_DIR/dist-config.json"
  DIST_ID=$(aws cloudfront create-distribution --distribution-config "file://$GEN_DIR/dist-config.json" \
    --query 'Distribution.Id' --output text)
  rm -f "$GEN_DIR/dist-config.json"   # it holds the origin secret
  echo "Created distribution $DIST_ID"
fi
DIST_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)
printf 'DIST_ID=%s\nDIST_DOMAIN=%s\n' "$DIST_ID" "$DIST_DOMAIN" > "$STATE_FILE"

echo "=== 7. Bucket policies for CloudFront OAC ==="
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
for B in "$WEB_BUCKET" "$UPLOADS_BUCKET"; do
  cat > "$GEN_DIR/$B-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${B}/*",
      "Condition": { "StringEquals": { "AWS:SourceArn": "${DIST_ARN}" } }
    }
  ]
}
EOF
  aws s3api put-bucket-policy --bucket "$B" --policy "file://$GEN_DIR/$B-policy.json"
done

echo "=== 8. Uploads CORS (the browser PUTs straight to S3 with a presigned URL) ==="
ORIGINS="\"https://${DIST_DOMAIN}\""
[ -n "${DOMAIN:-}" ] && ORIGINS="${ORIGINS}, \"https://${DOMAIN}\""
cat > "$GEN_DIR/uploads-cors.json" <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": [${ORIGINS}],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
EOF
aws s3api put-bucket-cors --bucket "$UPLOADS_BUCKET" --cors-configuration "file://$GEN_DIR/uploads-cors.json"

echo "=== 9. Lambda environment ==="
SITE_ORIGIN="https://${DOMAIN:-$DIST_DOMAIN}"
aws lambda update-function-configuration --function-name "$FUNCTION_NAME" \
  --timeout 15 --memory-size 512 \
  --environment "$(lambda_env_file "$SITE_ORIGIN")" >/dev/null
rm -f "$GEN_DIR/lambda-env.json"   # it holds the origin secret
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

echo ""
echo "=== DONE ==="
echo "Site:  https://${DIST_DOMAIN}  (CloudFront takes a few minutes to deploy)"
echo "Next:  bash infra/redeploy.sh   then   node api/seed.mjs"
if [ -n "${DOMAIN:-}" ] && [ "$CERT_STATUS" != "ISSUED" ]; then
  echo "Certificate: add this CNAME at your DNS host, wait for ISSUED, then run infra/attach-alias.sh"
  echo "  $VALIDATION_NAME -> $VALIDATION_VALUE"
fi
