@echo off
REM AWS CLI Setup script to configure the IoT Topic Rules and Lambda permissions
REM Region: ap-south-1

set REGION=ap-south-1
set FUNCTION_NAME=lc-platform-device-registration
set RULE_CREATED=lc_platform_thing_created_rule
set RULE_UPDATED=lc_platform_thing_updated_rule
set RULE_DELETED=lc_platform_thing_deleted_rule
set RULE_MANIFEST=lc_platform_device_manifest_rule
set RULE_TELEMETRY=lc_platform_device_telemetry_rule
set ACCOUNT_ID=

echo ========================================================
echo Configuring AWS IoT Core Rules for LC-Platform Device Registry
echo ========================================================

for /f "tokens=*" %%i in ('aws sts get-caller-identity --query Account --output text') do set ACCOUNT_ID=%%i
if "%ACCOUNT_ID%"=="" goto :ErrAccountId
echo Detected AWS Account ID: %ACCOUNT_ID%

set FUNCTION_ARN=arn:aws:lambda:%REGION%:%ACCOUNT_ID%:function:%FUNCTION_NAME%

call :UpsertRule "[1/5]" "%RULE_CREATED%" "iot-created-perm" "SELECT *, topic(4) as topicThingName, topic() as topic FROM '$aws/events/thing/+/created'" "Registers created IoT things into LC-Platform RDS"
if errorlevel 1 exit /b 1

call :UpsertRule "[2/5]" "%RULE_UPDATED%" "iot-updated-perm" "SELECT *, topic(4) as topicThingName, topic() as topic FROM '$aws/events/thing/+/updated'" "Synchronizes updated IoT things metadata into LC-Platform RDS"
if errorlevel 1 exit /b 1

call :UpsertRule "[3/5]" "%RULE_DELETED%" "iot-deleted-perm" "SELECT *, topic(4) as thingName, topic() as topic FROM '$aws/events/thing/+/deleted'" "Removes deleted IoT things from LC-Platform RDS"
if errorlevel 1 exit /b 1

call :UpsertRule "[4/5]" "%RULE_MANIFEST%" "iot-manifest-perm" "SELECT *, topic(3) as topicThingName, topic() as topic FROM 'lc/devices/+/manifest'" "Ingests firmware hardware profile and sensors manifest into LC-Platform RDS"
if errorlevel 1 exit /b 1

call :UpsertRule "[5/5]" "%RULE_TELEMETRY%" "iot-telemetry-perm" "SELECT *, topic(2) as topicThingName, topic() as topic FROM 'lc-gate/+/#'" "Streams real-time edge device telemetry and health check payloads into LC-Platform RDS"
if errorlevel 1 exit /b 1

echo ========================================================
echo Done!
echo 1. Thing Created Rule ($aws/events/thing/+/created) -^> ACTIVE
echo 2. Thing Updated Rule ($aws/events/thing/+/updated) -^> ACTIVE
echo 3. Thing Deleted Rule ($aws/events/thing/+/deleted) -^> ACTIVE
echo 4. Device Manifest Rule (lc/devices/+/manifest)     -^> ACTIVE
echo 5. Telemetry ^& Health Rule (lc-gate/+/#)            -^> ACTIVE
echo Any device published or deleted in AWS IoT will now synchronize with RDS.
echo ========================================================
if /i not "%~1"=="--no-pause" pause
exit /b 0

:ErrAccountId
echo [ERROR] Failed to detect AWS Account ID. Check AWS CLI credentials.
exit /b 1

:UpsertRule
set "STEP_LABEL=%~1"
set "RULE_NAME=%~2"
set "STMT_ID=%~3"
set "RULE_SQL=%~4"
set "RULE_DESC=%~5"

echo %STEP_LABEL% Configuring permission ^& IoT rule: %RULE_NAME%...

set "PERM_ERR_FILE=%TEMP%\lc_iot_perm_err_%STMT_ID%.txt"
call aws lambda add-permission --function-name "%FUNCTION_NAME%" --statement-id "%STMT_ID%" --action lambda:InvokeFunction --principal iot.amazonaws.com --source-arn "arn:aws:iot:%REGION%:%ACCOUNT_ID%:rule/%RULE_NAME%" --region "%REGION%" >nul 2>"%PERM_ERR_FILE%"
if not errorlevel 1 goto :PermOk
findstr /C:"ResourceConflictException" "%PERM_ERR_FILE%" >nul 2>&1
if errorlevel 1 goto :PermFail
echo       Permission %STMT_ID% already exists ^(reusing^).
:PermOk
del /f /q "%PERM_ERR_FILE%" >nul 2>&1

set "RULE_PAYLOAD={\"sql\": \"%RULE_SQL%\", \"description\": \"%RULE_DESC%\", \"actions\": [{\"lambda\": {\"functionArn\": \"%FUNCTION_ARN%\"}}], \"ruleDisabled\": false}"
set "ERR_FILE=%TEMP%\lc_iot_rule_err_%STMT_ID%.txt"

call aws iot create-topic-rule --rule-name "%RULE_NAME%" --topic-rule-payload "%RULE_PAYLOAD%" --region "%REGION%" 2>"%ERR_FILE%"
if not errorlevel 1 goto :RuleCreated
findstr /C:"ResourceAlreadyExistsException" "%ERR_FILE%" >nul 2>&1
if errorlevel 1 goto :RuleCreateFail

echo       Rule exists; replacing rule %RULE_NAME%...
del /f /q "%ERR_FILE%" >nul 2>&1
call aws iot replace-topic-rule --rule-name "%RULE_NAME%" --topic-rule-payload "%RULE_PAYLOAD%" --region "%REGION%"
if errorlevel 1 goto :RuleReplaceFail
echo       Updated existing rule: %RULE_NAME%
exit /b 0

:RuleCreated
del /f /q "%ERR_FILE%" >nul 2>&1
echo       Created rule: %RULE_NAME%
exit /b 0

:PermFail
type "%PERM_ERR_FILE%"
del /f /q "%PERM_ERR_FILE%" >nul 2>&1
echo [ERROR] Failed to add Lambda permission for %RULE_NAME%.
exit /b 1

:RuleCreateFail
type "%ERR_FILE%"
del /f /q "%ERR_FILE%" >nul 2>&1
echo [ERROR] Failed to create rule %RULE_NAME%.
exit /b 1

:RuleReplaceFail
echo [ERROR] Failed to replace rule %RULE_NAME%.
exit /b 1
