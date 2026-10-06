import 'package:flutter/material.dart';

class GatesmanDashboard extends StatelessWidget {
  const GatesmanDashboard({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Gatesman Dashboard')),
      body: const Center(
        child: Text('Role-scoped dashboard content'),
      ),
    );
  }
}
