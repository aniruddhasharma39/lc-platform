/**
 * Local Test Runner for AWS Lambda Function
 * Simulates an AWS IoT lifecycle event ($aws/events/thing/<thingName>/created)
 */

const handler = require('./index').handler;

// Set RDS DATABASE_URL for local testing
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:<password>@<host>:5432/lc_platform?schema=public";

// Mock AWS IoT Core Lifecycle Event
const sampleEvent = {
  eventType: "THING_CREATED",
  eventId: "c28b7e21-50e4-4fa9-b88e-4f1141cf984a",
  timestamp: Date.now(),
  thingName: "LC-TEST-01",
  thingTypeName: "MasterUnit",
  thingArn: "arn:aws:iot:ap-south-1:123456789012:thing/LC-TEST-01",
  deviceType: "MASTER",
  serialNumber: "LC-TEST-01",
  manufacturer: "Mirtha / LC-Platform",
  modelNumber: "LC-GATE-MASTER-V2",
  firmwareVersion: "v2.1.0",
  hardwareVersion: "revC",
  dateOfMfg: "2024-06-10T00:00:00.000Z",
  sensors: [
    { name: "Solar Panel Voltage Monitor", type: "ANALOG_VOLTAGE", pin: "ADC1_IN0", range: "0-30V" },
    { name: "LiFePO4 Current Sensor", type: "I2C_INA219", address: "0x40", range: "-30A to +30A" },
    { name: "Gate Boom Angle Inclinometer", type: "I2C_MPU6050", address: "0x68", range: "0-90 deg" },
    { name: "Radar Train Detection Unit", type: "DOPPLER_RADAR", interface: "UART", baud: 115200 },
    { name: "Ambient Temperature & Humidity", type: "I2C_SHT30", address: "0x44" }
  ],
  components: [
    { name: "Main Controller Board", model: "STM32F401 Blackpill ARM Cortex-M4 @ 84MHz" },
    { name: "Long-Range Cellular Modem", model: "SIM7600G-H LTE CAT-4 with GNSS" },
    { name: "Solar Charge Regulator", model: "MPPT 12V 10A Intelligent Controller" },
    { name: "Industrial Relay Module", model: "Omron 4-Channel 10A Optocoupled" },
    { name: "Lithium Iron Phosphate Battery", model: "12.8V 24Ah Deep Cycle with Smart BMS" }
  ],
  attributes: {
    installationLocation: "Gate Testing Lab",
    provisioningProfile: "LC_FLEET_CLAIM_V1"
  }
};

async function run() {
  console.log("Running local Lambda test against RDS...");
  try {
    const res = await handler(sampleEvent, {});
    console.log("LAMBDA STATUS CODE:", res.statusCode);
    console.log("LAMBDA RESPONSE BODY:", JSON.parse(res.body));
    process.exit(0);
  } catch (err) {
    console.error("TEST FAILED:", err);
    process.exit(1);
  }
}

run();
