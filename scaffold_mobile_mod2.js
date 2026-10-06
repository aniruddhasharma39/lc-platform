const fs = require('fs');
const path = require('path');

const mobileSrc = path.join(__dirname, 'mobile', 'lib');
const viewsPath = path.join(mobileSrc, 'views');
const devicesPath = path.join(viewsPath, 'devices');

if (!fs.existsSync(devicesPath)) fs.mkdirSync(devicesPath, { recursive: true });

fs.writeFileSync(path.join(devicesPath, 'device_inventory_view.dart'), `
import 'package:flutter/material.dart';

class DeviceInventoryView extends StatelessWidget {
  const DeviceInventoryView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Device Inventory')),
      body: const Center(
        child: Text('Device list and caching logic will go here'),
      ),
    );
  }
}
`);

fs.writeFileSync(path.join(devicesPath, 'device_detail_view.dart'), `
import 'package:flutter/material.dart';

class DeviceDetailView extends StatelessWidget {
  const DeviceDetailView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Device Detail')),
      body: const Center(
        child: Text('Device telemetry and provisioning status'),
      ),
    );
  }
}
`);

console.log('Mobile device views generated successfully.');
