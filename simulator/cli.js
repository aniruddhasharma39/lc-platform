#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'simulator_state.json');

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { devices: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const command = process.argv[2];
const deviceId = process.argv[3];
const state = loadState();

switch (command) {
  case 'create':
    const newId = deviceId || `SIM-\${Date.now()}`;
    if (state.devices[newId]) {
      console.error('Device already exists.');
      process.exit(1);
    }
    state.devices[newId] = {
      factoryDeviceId: newId,
      firmwareVersion: '1.0.0',
      battery: 100,
      connectivity: 'OFFLINE',
      status: 'PROVISIONED',
      running: false
    };
    saveState(state);
    console.log(`Device \${newId} created.`);
    break;

  case 'list':
    console.table(Object.values(state.devices));
    break;

  case 'start':
    if (!deviceId || !state.devices[deviceId]) {
      console.error('Valid device ID required.');
      process.exit(1);
    }
    state.devices[deviceId].running = true;
    state.devices[deviceId].connectivity = 'ONLINE';
    saveState(state);
    console.log(`Device \${deviceId} started.`);
    break;

  case 'stop':
    if (!deviceId || !state.devices[deviceId]) {
      console.error('Valid device ID required.');
      process.exit(1);
    }
    state.devices[deviceId].running = false;
    state.devices[deviceId].connectivity = 'OFFLINE';
    saveState(state);
    console.log(`Device \${deviceId} stopped.`);
    break;

  case 'restart':
    if (!deviceId || !state.devices[deviceId]) {
      console.error('Valid device ID required.');
      process.exit(1);
    }
    state.devices[deviceId].running = true;
    state.devices[deviceId].connectivity = 'ONLINE';
    saveState(state);
    console.log(`Device \${deviceId} restarted.`);
    break;

  default:
    console.log('Usage: simulator <create|list|start|stop|restart> [deviceId]');
    process.exit(1);
}
