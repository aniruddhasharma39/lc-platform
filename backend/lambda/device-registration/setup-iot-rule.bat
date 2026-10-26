@echo off
REM AWS CLI Setup script to configure the IoT Topic Rules and Lambda permissions
REM Region: ap-south-1

set REGION=ap-south-1
set FUNCTION_NAME=lc-platform-device-registration
set RULE_CREATED=lc_platform_thing_created_rule
set RULE_MANIFEST=lc_platform_device_manifest_rule
set ACCOUNT_ID=

echo ========================================================
echo Configuring AWS IoT Core Rules for LC-Platform Device Registry
echo ========================================================

REM 1. Get AWS Account ID if not set
for /f "tokens=*" %%i in ('aws sts get-caller-identity --query Account --output text') do set ACCOUNT_ID=%%i
echo Detected AWS Account ID: %ACCOUNT_ID%

REM 2. Grant AWS IoT Core permission to invoke Lambda for Thing Created rule
echo [1/4] Granting IoT invoke permission for Thing Created rule...
aws lambda add-permission ^
    --function-name %FUNCTION_NAME% ^
    --statement-id iot-events-permission ^
    --action lambda:InvokeFunction ^
    --principal iot.amazonaws.com ^
    --source-arn "arn:aws:iot:%REGION%:%ACCOUNT_ID%:rule/%RULE_CREATED%" ^
    --region %REGION% 2>nul

REM 3. Create or Update AWS IoT Topic Rule: Thing Created ($aws/events/thing/+/created)
echo [2/4] Creating Rule: %RULE_CREATED%...
aws iot create-topic-rule ^
    --rule-name %RULE_CREATED% ^
    --topic-rule-payload "{\"sql\": \"SELECT * FROM '$aws/events/thing/+/created'\", \"description\": \"Registers created IoT things into LC-Platform RDS\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:%REGION%:%ACCOUNT_ID%:function:%FUNCTION_NAME%\"}}], \"ruleDisabled\": false}" ^
    --region %REGION%

REM 4. Grant AWS IoT Core permission to invoke Lambda for Device Manifest rule
echo [3/4] Granting IoT invoke permission for Device Manifest rule...
aws lambda add-permission ^
    --function-name %FUNCTION_NAME% ^
    --statement-id iot-manifest-permission ^
    --action lambda:InvokeFunction ^
    --principal iot.amazonaws.com ^
    --source-arn "arn:aws:iot:%REGION%:%ACCOUNT_ID%:rule/%RULE_MANIFEST%" ^
    --region %REGION% 2>nul

REM 5. Create or Update AWS IoT Topic Rule: Device Manifest (lc/devices/+/manifest)
echo [4/4] Creating Rule: %RULE_MANIFEST% (topic: lc/devices/+/manifest)...
aws iot create-topic-rule ^
    --rule-name %RULE_MANIFEST% ^
    --topic-rule-payload "{\"sql\": \"SELECT *, topic(3) as topicThingName FROM 'lc/devices/+/manifest'\", \"description\": \"Ingests firmware hardware profile and sensors manifest into LC-Platform RDS\", \"actions\": [{\"lambda\": {\"functionArn\": \"arn:aws:lambda:%REGION%:%ACCOUNT_ID%:function:%FUNCTION_NAME%\"}}], \"ruleDisabled\": false}" ^
    --region %REGION%

echo ========================================================
echo Done!
echo 1. Thing Created Rule ($aws/events/thing/+/created) -> ACTIVE
echo 2. Device Manifest Rule (lc/devices/+/manifest)     -> ACTIVE
echo Any device publishing its manifest over MQTT will now be stored in RDS.
echo ========================================================
pause

