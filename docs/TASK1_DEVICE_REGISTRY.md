The AWS Lambda function, RDS Database table, and backend integration for the LC-Platform Device Registry are now implemented and tested.

1. Database Schema & RDS Integration (DeviceRegistry)
A new table DeviceRegistry has been added to 

backend/prisma/schema.prisma
 and synchronized with your AWS RDS PostgreSQL database (safeshunt-db).

Stored Fields & Metadata:
AWS IoT Identifiers: thingName (unique), thingArn, thingTypeName
Device Details: deviceType (MASTER, SLAVE, etc.), serialNumber (unique), status (ACTIVE, PROVISIONED, DECOMMISSIONED, etc.)
Cluster & Gate Linkage: gateId, masterId, childDeviceId (automatically resolved by serial number matching)
Hardware Specs: firmwareVersion, hardwareVersion, macAddress, imei
Manufacturing Metadata: dateOfMfg (Date of Manufacturing), manufacturer, modelNumber, batchNumber
Sensors Metadata (sensors - JSON): Array/object of all internal sensors (e.g. Solar voltage ADC, LiFePO4 battery monitor, boom angle inclinometer, Doppler radar, temperature)
Components Metadata (components - JSON): Internal components (MCU STM32F401, Cellular SIM7600G modem, MPPT solar charger, relay board, battery pack)
Attributes & Metadata (attributes, metadata - JSON): AWS IoT attributes and custom runtime parameters
2. AWS Lambda Function
Located in:



aws-lambda/device-registration-handler/


backend/lambda/device-registration/
Key Files Created:


index.js
:
Connects to RDS PostgreSQL via connection pool.
Normalizes payloads from AWS IoT Topic Rules ($aws/events/thing/+/created), Fleet Provisioning hooks, EventBridge, or API Gateway.
Automatically auto-links the device to existing LCGate, MasterUnit, or ChildDevice records by matching serial number prefix.
Upserts into "DeviceRegistry" with full sensor and component metadata.


function.zip
: Pre-packaged zip archive ready to upload to the AWS Lambda Console.


template.yaml
: AWS SAM / CloudFormation template for 1-click infrastructure deployment.


serverless.yml
: Serverless Framework configuration.


setup-iot-rule.bat
 & 

setup-iot-rule.sh
: Automates creating the AWS IoT Topic Rule and granting invocation permissions via AWS CLI.


test-local.js
: Verified end-to-end against RDS.
3. Backend REST API Integration
Created 

backend/src/routes/deviceRegistry.ts
 and mounted under /api/v1/devices in 

backend/src/index.ts
.

Endpoint	Method	Purpose
/api/v1/devices	GET	List registered devices (filters by search, status, deviceType, gateId, pagination)
/api/v1/devices/:id	GET	Get single device by ID or thingName with full sensor and component data
/api/v1/devices	POST	Direct device registration or webhook endpoint
/api/v1/devices/:id	PUT	Update sensors, components, firmware, or operational status
/api/v1/devices/:id	DELETE	Decommission or remove device
/api/v1/devices/stats/summary	GET	Metrics counters (total devices, active, masters, slaves)
/api/v1/devices/simulate-iot-event	POST	Simulate an AWS IoT Thing Created lifecycle event directly against the backend
Additionally, 

backend/src/routes/lcgate.ts
 was updated so that gate cluster telemetry (/:id/telemetry) now embeds the AWS IoT device status and hardware profiles.

4. How to Deploy to AWS
Step A: Deploy the Lambda Function
In the AWS Console (Region: ap-south-1 Mumbai), go to AWS Lambda > Create function.
Set Function Name: lc-platform-device-registration, Runtime: Node.js 20.x.
In the Code tab, select Upload from > .zip file and upload: c:\Users\PC\Desktop\Internship\LC-Gate\aws-lambda\device-registration-handler\function.zip
Under Configuration > Environment variables, set:
DATABASE_URL = your RDS PostgreSQL connection string.
Step B: Configure the AWS IoT Topic Rule
Run the automated script:

powershell
cd c:\Users\PC\Desktop\Internship\LC-Gate\aws-lambda\device-registration-handler
.\setup-iot-rule.bat
Or configure it manually in the AWS IoT Core Console:

Rule SQL: SELECT * FROM '$aws/events/thing/+/created'
Action: Invoke Lambda function lc-platform-device-registration
4:31 PM
