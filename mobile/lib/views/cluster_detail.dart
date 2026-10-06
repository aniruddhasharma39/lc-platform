import 'package:flutter/material.dart';

class ClusterDetail extends StatelessWidget {
  const ClusterDetail({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Cluster Details')),
      body: const Center(
        child: Text('Details for selected cluster'),
      ),
    );
  }
}
