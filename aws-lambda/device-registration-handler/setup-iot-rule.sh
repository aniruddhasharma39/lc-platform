#!/usr/bin/env bash
# AWS CLI Setup script to configure the IoT Topic Rules and Lambda permissions
# Region: ap-south-1
set -euo pipefail

REGION="ap-south-1"
FUNCTION_NAME="lc-platform-device-registration"
RULE_CREATED="lc_platform_thing_created_rule"
RULE_UPDATED="lc_platform_thing_updated_rule"
RULE_DELETED="lc_platform_thing_deleted_rule"
RULE_MANIFEST="lc_platform_device_manifest_rule"
RULE_TELEMETRY="lc_platform_device_telemetry_rule"

echo "========================================================"
echo "Configuring AWS IoT Core Rules for LC-Platform Device Registry"
echo "========================================================"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [[ -z "${ACCOUNT_ID}" ]]; then
  echo "[ERROR] Failed to detect AWS Account ID. Check AWS CLI credentials." >&2
  exit 1
fi
echo "Detected AWS Account ID: ${ACCOUNT_ID}"

FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

upsert_iot_rule() {
  local step_label="$1"
  local rule_name="$2"
  local stmt_id="$3"
  local sql="$4"
  local desc="$5"

  echo "${step_label} Configuring permission & IoT rule: ${rule_name}..."

  # Fixed statement ID prevents duplicate Lambda resource-policy bloat across re-runs
  local perm_err
  if ! perm_err=$(aws lambda add-permission \
      --function-name "${FUNCTION_NAME}" \
      --statement-id "${stmt_id}" \
      --action lambda:InvokeFunction \
      --principal iot.amazonaws.com \
      --source-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/${rule_name}" \
      --region "${REGION}" 2>&1 >/dev/null); then
    if [[ "${perm_err}" == *"ResourceConflictException"* ]]; then
      echo "      Permission ${stmt_id} already exists (reusing)."
    else
      echo "${perm_err}" >&2
      exit 1
    fi
  fi

  local payload
  payload=$(printf '{"sql":"%s","description":"%s","actions":[{"lambda":{"functionArn":"%s"}}],"ruleDisabled":false}' \
    "${sql}" "${desc}" "${FUNCTION_ARN}")

  local rule_err
  if rule_err=$(aws iot create-topic-rule \
      --rule-name "${rule_name}" \
      --topic-rule-payload "${payload}" \
      --region "${REGION}" 2>&1); then
    echo "      Created rule: ${rule_name}"
  elif [[ "${rule_err}" == *"ResourceAlreadyExistsException"* ]]; then
    echo "      Rule exists; replacing rule: ${rule_name}..."
    aws iot replace-topic-rule \
      --rule-name "${rule_name}" \
      --topic-rule-payload "${payload}" \
      --region "${REGION}"
    echo "      Updated existing rule: ${rule_name}"
  else
    echo "${rule_err}" >&2
    exit 1
  fi
}

# 1. Thing Created ($aws/events/thing/+/created)
upsert_iot_rule \
  "[1/5]" \
  "${RULE_CREATED}" \
  "iot-created-perm" \
  'SELECT *, topic(4) as topicThingName, topic() as topic FROM '\''$aws/events/thing/+/created'\''' \
  "Registers created IoT things into LC-Platform RDS"

# 2. Thing Updated ($aws/events/thing/+/updated)
upsert_iot_rule \
  "[2/5]" \
  "${RULE_UPDATED}" \
  "iot-updated-perm" \
  'SELECT *, topic(4) as topicThingName, topic() as topic FROM '\''$aws/events/thing/+/updated'\''' \
  "Synchronizes updated IoT things metadata into LC-Platform RDS"

# 3. Thing Deleted ($aws/events/thing/+/deleted)
upsert_iot_rule \
  "[3/5]" \
  "${RULE_DELETED}" \
  "iot-deleted-perm" \
  'SELECT *, topic(4) as thingName, topic() as topic FROM '\''$aws/events/thing/+/deleted'\''' \
  "Removes deleted IoT things from LC-Platform RDS"

# 4. Device Manifest (lc/devices/+/manifest)
upsert_iot_rule \
  "[4/5]" \
  "${RULE_MANIFEST}" \
  "iot-manifest-perm" \
  "SELECT *, topic(3) as topicThingName, topic() as topic FROM 'lc/devices/+/manifest'" \
  "Ingests firmware hardware profile and sensors manifest into LC-Platform RDS"

# 5. Telemetry & Health (lc-gate/+/telemetry & lc-gate/+/health)
upsert_iot_rule \
  "[5/5]" \
  "${RULE_TELEMETRY}" \
  "iot-telemetry-perm" \
  "SELECT *, topic(2) as topicThingName, topic() as topic FROM 'lc-gate/+/#'" \
  "Streams real-time edge device telemetry and health payloads into LC-Platform RDS DeviceTelemetry"

echo "========================================================"
echo "Setup Complete!"
echo "1. Thing Created Rule (\$aws/events/thing/+/created) -> ACTIVE"
echo "2. Thing Updated Rule (\$aws/events/thing/+/updated) -> ACTIVE"
echo "3. Thing Deleted Rule (\$aws/events/thing/+/deleted) -> ACTIVE"
echo "4. Device Manifest Rule (lc/devices/+/manifest)     -> ACTIVE"
echo "5. Telemetry Ingest Rule (lc-gate/+/#)              -> ACTIVE"
echo "========================================================"
