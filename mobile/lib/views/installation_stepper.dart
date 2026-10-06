import 'package:flutter/material.dart';

class InstallationStepper extends StatelessWidget {
  const InstallationStepper({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Guided Installation')),
      body: const Center(
        child: Text('Stepper for installation workflow'),
      ),
    );
  }
}
