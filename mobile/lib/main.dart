import 'package:flutter/material.dart';

import 'theme/app_theme.dart';
import 'views/login_view.dart';
import 'views/gatesman_dashboard.dart';
import 'views/cluster_detail.dart';
import 'views/installation_stepper.dart';

void main() {
  runApp(const LCPlatformApp());
}

class LCPlatformApp extends StatelessWidget {
  const LCPlatformApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LC Platform',
      theme: AppTheme.lightTheme,
      initialRoute: '/',
      routes: {
        '/': (context) => const AppStartupView(),
        '/login': (context) => const LoginView(),
        '/dashboard': (context) => const GatesmanDashboard(),
        '/cluster': (context) => const ClusterDetail(),
        '/installation': (context) => const InstallationStepper(),
      },
    );
  }
}

class AppStartupView extends StatefulWidget {
  const AppStartupView({super.key});

  @override
  State<AppStartupView> createState() => _AppStartupViewState();
}

class _AppStartupViewState extends State<AppStartupView> {
  @override
  void initState() {
    super.initState();
    _checkAuthAndNavigate();
  }

  Future<void> _checkAuthAndNavigate() async {
    // Temporary authentication bypass simulation
    // Assuming no token exists for now, so we route to /login
    bool hasToken = false; // Change to true to test dashboard bypass
    
    // Slight delay to allow Flutter to render initial frame
    await Future.delayed(const Duration(milliseconds: 100));
    
    if (mounted) {
      if (hasToken) {
        Navigator.of(context).pushReplacementNamed('/dashboard');
      } else {
        Navigator.of(context).pushReplacementNamed('/login');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}
