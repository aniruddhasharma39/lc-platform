
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
