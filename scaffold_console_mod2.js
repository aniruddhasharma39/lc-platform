const fs = require('fs');
const path = require('path');

const consoleSrc = path.join(__dirname, 'console', 'src');
const viewsPath = path.join(consoleSrc, 'views');
const devicesPath = path.join(viewsPath, 'devices');

if (!fs.existsSync(devicesPath)) fs.mkdirSync(devicesPath, { recursive: true });

fs.writeFileSync(path.join(devicesPath, 'DeviceInventory.jsx'), `
import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function DeviceInventory() {
  const [devices, setDevices] = useState([]);
  
  useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async () => {
    try {
      const res = await axios.get('/api/v1/devices', {
        headers: { Authorization: \`Bearer \${localStorage.getItem('token')}\` }
      });
      setDevices(res.data.data);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Device Inventory</h1>
      <table className="min-w-full bg-white border">
        <thead>
          <tr>
            <th className="py-2 px-4 border-b">ID</th>
            <th className="py-2 px-4 border-b">Factory ID</th>
            <th className="py-2 px-4 border-b">Status</th>
            <th className="py-2 px-4 border-b">Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map(device => (
            <tr key={device.id}>
              <td className="py-2 px-4 border-b">{device.id}</td>
              <td className="py-2 px-4 border-b">{device.factory_device_id}</td>
              <td className="py-2 px-4 border-b">{device.status}</td>
              <td className="py-2 px-4 border-b">
                <button className="text-blue-500 mr-2">View</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
`);

fs.writeFileSync(path.join(devicesPath, 'SimulatorManagement.jsx'), `
import React, { useState } from 'react';

export default function SimulatorManagement() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Simulator Management</h1>
      <p>CLI Commands provided: npm run simulator:create, etc.</p>
    </div>
  );
}
`);

console.log('Console device views generated successfully.');
