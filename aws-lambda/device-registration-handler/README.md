# LC-Platform AWS IoT Device Registration Lambda & RDS Registry

This AWS Lambda service automatically registers any hardware device created as a **"Thing"** in **AWS IoT Core** directly into the **PostgreSQL RDS Database** table (`DeviceRegistry`).

It captures all hardware specifications and metadata requested:
- **Sensors within the device** (e.g., Solar panel voltage, LiFePO4 current monitor, Boom barrier inclinometer, Doppler radar, temperature sensors)
- **Internal hardware components** (e.g., STM32 MCU, SIM7600G LTE Modem, MPPT solar controller, relays, battery pack)
- **Manufacturing details** (Date of manufacturing, manufacturer, model number, batch number)
- **Firmware & Hardware revisions**
- **Automatic Gate / Cluster Linkage** (Automatically links device to `LCGate`, `MasterUnit`, or `ChildDevice` by serial number or prefix)

---

## 🏗 Architecture & Event Flow

```
                      +-----------------------------+
                      | Physical Hardware Device    |
                      | (STM32 + SIM7600G Modem)    |
                      +--------------+--------------+
                                     |
                                     | 1. Connects & registers via Fleet Provisioning
                                     v
                      +-----------------------------+
                      |     AWS IoT Core            |
                      |  $aws/events/thing/+/created|
                      +--------------+--------------+
                                     |
                                     | 2. IoT Topic Rule triggers Lambda
                                     v
                      +-----------------------------+
                      |   AWS Lambda Function       |
                      | lc-platform-device-register |
                      +--------------+--------------+
                                     |
                                     | 3. Parses sensors, components, mfg date
                                     |    and upserts into DeviceRegistry
                                     v
                      +-----------------------------+
                      |   AWS RDS PostgreSQL        |
                      |     "DeviceRegistry"        |
                      +--------------+--------------+
                                     |
                                     | 4. Syncs with Web & Mobile Dashboards
                                     v
                      +-----------------------------+
                      | Express Backend REST API    |
                      |     /api/v1/devices         |
                      +-----------------------------+
```

---

## 🚀 Deployment Options

### Option 1: AWS Console (Quick Zip Upload)
1. Open the [AWS Lambda Console](https://console.aws.amazon.com/lambda) in **`ap-south-1` (Mumbai)**.
2. Click **Create function** > **Author from scratch**:
   - **Function name**: `lc-platform-device-registration`
   - **Runtime**: `Node.js 20.x`
   - **Architecture**: `x86_64`
3. In the **Code** tab, click **Upload from** > **.zip file** and select:
   `aws-lambda/device-registration-handler/function.zip`
4. Under **Configuration** > **Environment variables**, add:
   - **Key**: `DATABASE_URL`
   - **Value**: `postgresql://<user>:<password>@<rds-endpoint>:5432/lc_platform?schema=public`
5. Under **Configuration** > **General configuration**:
   - **Timeout**: `15 sec`
   - **Memory**: `256 MB`

---

### Option 2: AWS IoT Core Rule Configuration (Console or CLI)

#### Via AWS Console:
1. Open [AWS IoT Core Console](https://console.aws.amazon.com/iot).
2. Go to **Message routing** > **Rules** > **Create rule**:
   - **Rule name**: `lc_platform_thing_created_rule`
   - **SQL statement**:
     ```sql
     SELECT * FROM '$aws/events/thing/+/created'
     ```
3. Under **Rule actions**, choose **Lambda**:
   - Select function: `lc-platform-device-registration`
4. Click **Create**.

#### Via AWS CLI:
Run the included batch script on Windows:
```cmd
setup-iot-rule.bat
```
Or on Linux/macOS:
```bash
chmod +x setup-iot-rule.sh
./setup-iot-rule.sh
```

---

## 📡 REST API Integration (Backend)

The LC-Platform backend provides endpoints for managing and inspecting registered devices under `/api/v1/devices`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/devices` | List registered devices (supports `search`, `status`, `deviceType`, `gateId`, pagination) |
| `GET` | `/api/v1/devices/:id` | Get single device by ID or `thingName` with full sensor and component metadata |
| `POST` | `/api/v1/devices` | Register or upsert device into RDS registry |
| `PUT` | `/api/v1/devices/:id` | Update metadata, sensors, components, or status |
| `DELETE` | `/api/v1/devices/:id` | Decommission or delete device |
| `GET` | `/api/v1/devices/stats/summary` | Telemetry metrics: total, active, provisioned, master/slave counts |
| `POST` | `/api/v1/devices/simulate-iot-event` | Test AWS IoT event payload without physical hardware |

---

## 🧪 Testing

### 1. Local Lambda Test
Verify Lambda against RDS directly:
```bash
node test-local.js
```

### 2. Backend Simulated IoT Event Test
Send a sample IoT lifecycle event to the backend API:
```bash
curl -X POST http://localhost:5001/api/v1/devices/simulate-iot-event \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "thingName": "LC-0001-01",
    "thingTypeName": "MasterUnit",
    "serialNumber": "LC-0001-01",
    "deviceType": "MASTER",
    "dateOfMfg": "2024-05-15",
    "manufacturer": "Mirtha / LC-Platform",
    "modelNumber": "LC-GATE-M1",
    "firmwareVersion": "v1.2.0",
    "hardwareVersion": "revB"
  }'
```
