
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
