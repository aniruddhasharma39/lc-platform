const awsIot = require('aws-iot-device-sdk');

console.log('Starting IoT Simulator...');

// Mock configuration (In reality, load claim certificates)
const device = awsIot.device({
  keyPath: './certs/private.pem.key',
  certPath: './certs/certificate.pem.crt',
  caPath: './certs/AmazonRootCA1.pem',
  clientId: 'simulator-device-001',
  host: process.env.AWS_IOT_ENDPOINT || 'mock-endpoint.iot.us-east-1.amazonaws.com'
});

device.on('connect', () => {
  console.log('Connected to AWS IoT Core');
  
  // Simulate telemetry every 10 seconds
  setInterval(() => {
    const payload = generateTelemetry();
    device.publish('devices/telemetry', JSON.stringify(payload));
    console.log('Published telemetry:', payload);
  }, 10000);
});

function generateTelemetry() {
  const isGateOpen = Math.random() > 0.5;
  return {
    MasterDeviceId: 'LC-MASTER-001',
    SensorType: 'BOOM_BARRIER',
    Status: isGateOpen ? 'OPEN' : 'CLOSED',
    TimeStamp: new Date().toISOString(),
    Battery: Math.floor(Math.random() * 20) + 80, // 80-100%
    SlaveDeviceId: 'LC-SLAVE-001'
  };
}

// For mock purposes without real certs, just run the generator output
setInterval(() => {
  console.log('[Mock Run] Telemetry payload:', generateTelemetry());
}, 5000);
