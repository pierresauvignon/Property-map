# Copy to infra/config.sh (gitignored) and fill in. Every script in infra/ and
# api/ reads it, so this is the only place your account details live.

export AWS_PROFILE=default         # the AWS CLI profile to deploy with
REGION=us-east-1                   # CloudFront certificates must be in us-east-1;
                                   # keeping everything there is simplest
NAME=propmap                       # prefix for every resource this app creates
BUCKET_PREFIX=yourname-propmap     # S3 names are global: make this unique

# Optional. Leave DOMAIN empty to run on the *.cloudfront.net address.
DOMAIN=                            # e.g. houses.example.com
# Optional. Email notifications via SES; leave empty to switch them off.
# The identity (domain or address) must already be verified in SES.
SES_IDENTITY=                      # e.g. example.com
MAIL_FROM=                         # e.g. "Property Map <houses@example.com>"
