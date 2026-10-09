import 'package:flutter/material.dart';
import '../main.dart';

class BrandingScreen extends StatelessWidget {
  final Map<String, dynamic> user;
  const BrandingScreen({super.key, required this.user});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.brush, size: 64, color: AppColors.primary),
          const SizedBox(height: 16),
          const Text('Branding Configuration', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 32.0),
            child: Text(
              'Branding settings (App Name, Wallpapers, etc.) are optimized for the Web Developer Console. Please use the web platform to configure global branding options.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey, fontSize: 16),
            ),
          ),
        ],
      ),
    );
  }
}
