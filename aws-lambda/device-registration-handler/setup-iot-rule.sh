#!/usr/bin/env bash
# AWS CLI Setup script to configure the IoT Topic Rules and Lambda permissions
# Region: ap-south-1

REGION="ap-south-1"
FUNCTION_NAME="lc-platform-device-registration"
RULE_CREATED="lc_platform_thing_created_rule"
RULE_DELETED="lc_platform_thing_deleted_rule"
RULE_MANIFEST="lc_platform_device_manifest_rule"
RULE_TELEMETRY="lc_platform_device_telemetry_rule"

echo "========================================================"
echo "Configuring AWS IoT Core Rules for LC-Platform Device Registry"
echo "========================================================"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Detected AWS Account ID: ${ACCOUNT_ID}"

# 1. Grant AWS IoT permission to invoke Lambda for Thing Created rule
echo "[1/8] Granting IoT invoke permission for Thing Created rule..."
aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "iot-events-permission-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal iot.amazonaws.com \
    --source-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/${RULE_CREATED}" \
    --region "${REGION}" 2>/dev/null || true

# 2. Create or update IoT Topic Rule: Thing Created
echo "[2/8] Creating Rule: ${RULE_CREATED}..."
aws iot create-topic-rule \
    --rule-name "${RULE_CREATED}" \
    --topic-rule-payload "{\"sql\": \"SELECT * FROM '\$aws/events/thing/+/created'\", \"description\": \"Registers created IoT things into LC-Platform RDS\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}\"}}], \"ruleDisabled\": false}" \
    --region "${REGION}"

# 3. Grant AWS IoT permission to invoke Lambda for Thing Deleted rule
echo "[3/8] Granting IoT invoke permission for Thing Deleted rule..."
aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "iot-deleted-permission-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal iot.amazonaws.com \
    --source-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/${RULE_DELETED}" \
    --region "${REGION}" 2>/dev/null || true

# 4. Create or update IoT Topic Rule: Thing Deleted
echo "[4/8] Creating Rule: ${RULE_DELETED}..."
aws iot create-topic-rule \
    --rule-name "${RULE_DELETED}" \
    --topic-rule-payload "{\"sql\": \"SELECT *, topic(4) as thingName FROM '\$aws/events/thing/+/deleted'\", \"description\": \"Removes deleted IoT things from LC-Platform RDS\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}\"}}], \"ruleDisabled\": false}" \
    --region "${REGION}"

# 3. Grant AWS IoT permission to invoke Lambda for Device Manifest rule
echo "[3/6] Granting IoT invoke permission for Device Manifest rule..."
aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "iot-manifest-permission-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal iot.amazonaws.com \
    --source-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/${RULE_MANIFEST}" \
    --region "${REGION}" 2>/dev/null || true

# 4. Create or update IoT Topic Rule: Device Manifest (lc/devices/+/manifest)
echo "[4/6] Creating Rule: ${RULE_MANIFEST} (topic: lc/devices/+/manifest)..."
aws iot create-topic-rule \
    --rule-name "${RULE_MANIFEST}" \
    --topic-rule-payload "{\"sql\": \"SELECT *, topic(3) as topicThingName FROM 'lc/devices/+/manifest'\", \"description\": \"Ingests firmware hardware profile and sensors manifest into LC-Platform RDS\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}\"}}], \"ruleDisabled\": false}" \
    --region "${REGION}"

# 5. Grant AWS IoT permission to invoke Lambda for Telemetry rule
echo "[5/6] Granting IoT invoke permission for Telemetry rule..."
aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "iot-telemetry-permission-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal iot.amazonaws.com \
    --source-arn "arn:aws:iot:${REGION}:${ACCOUNT_ID}:rule/${RULE_TELEMETRY}" \
    --region "${REGION}" 2>/dev/null || true

# 6. Create or update IoT Topic Rule: Device Telemetry (lc-gate/+/telemetry & lc-gate/+/health)
echo "[6/6] Creating Rule: ${RULE_TELEMETRY} (topic: lc-gate/+/#)..."
aws iot create-topic-rule \
    --rule-name "${RULE_TELEMETRY}" \
    --topic-rule-payload "{\"sql\": \"SELECT *, topic(2) as topicThingName, topic() as topic FROM 'lc-gate/+/%23'\", \"description\": \"Streams real-time edge device telemetry and health payloads into LC-Platform RDS DeviceTelemetry\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}\"}}], \"ruleDisabled\": false}" \
    --region "${REGION}"

echo "========================================================"
echo "Setup Complete!"
echo "1. Thing Created Rule ($aws/events/thing/+/created) -> ACTIVE"
echo "2. Thing Deleted Rule ($aws/events/thing/+/deleted) -> ACTIVE"
echo "3. Device Manifest Rule (lc/devices/+/manifest)     -> ACTIVE"
echo "4. Telemetry Ingest Rule (lc-gate/+/#)              -> ACTIVE"
echo "========================================================"

