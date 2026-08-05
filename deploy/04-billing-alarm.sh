#!/usr/bin/env bash
# CloudWatch billing alarm at $10 so an unexpected cost cannot run silently.
#
#   ./deploy/04-billing-alarm.sh you@example.com
#
# Billing metrics are published ONLY to us-east-1, regardless of where your
# resources live. That is an AWS constraint, not a mistake in this script.
set -euo pipefail

EMAIL="${1:?usage: $0 <email-address>}"
THRESHOLD="${2:-10}"
BILLING_REGION=us-east-1

TOPIC_ARN="$(aws sns create-topic --name bk-ingest-billing --region "$BILLING_REGION" \
  --query TopicArn --output text)"

aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" \
  --region "$BILLING_REGION" >/dev/null
echo "==> subscription requested for $EMAIL — CONFIRM THE EMAIL or no alarm will reach you"

aws cloudwatch put-metric-alarm \
  --region "$BILLING_REGION" \
  --alarm-name "bk-ingest-estimated-charges-over-${THRESHOLD}usd" \
  --alarm-description "BK-Ingest: estimated AWS charges exceeded \$${THRESHOLD}" \
  --namespace AWS/Billing --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --statistic Maximum --period 21600 --evaluation-periods 1 \
  --threshold "$THRESHOLD" --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

echo "==> alarm set at \$${THRESHOLD}"
echo "    If it never fires, check Billing preferences -> 'Receive Billing Alerts' is enabled;"
echo "    AWS does not publish the EstimatedCharges metric at all until that box is ticked."
