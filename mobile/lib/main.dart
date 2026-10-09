import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import 'screens/login_screen.dart';
import 'screens/dashboard_screen.dart';

void main() {
  runApp(const MyApp());
}

class AppColors {
  static const primary = Color(0xFF0B3C7A);
  static const secondary = Color(0xFF0E9AA7);
  static const accent = Color(0xFFF5A623);
  static const success = Color(0xFF2E9E5B);
  static const danger = Color(0xFFD64545);
  static const surface = Color(0xFFF4F6F9);
  static const background = Colors.white;
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LC Platform',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary, primary: AppColors.primary, secondary: AppColors.secondary),
        scaffoldBackgroundColor: AppColors.background,
        useMaterial3: true,
        inputDecorationTheme: InputDecorationTheme(
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.primary,
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            padding: const EdgeInsets.symmetric(vertical: 16),
          )
        )
      ),
      home: const AuthWrapper(),
    );
  }
}

class AuthWrapper extends StatefulWidget {
  const AuthWrapper({super.key});
  @override
  State<AuthWrapper> createState() => _AuthWrapperState();
}

class _AuthWrapperState extends State<AuthWrapper> {
  bool isLoading = true;
  bool isAuthenticated = false;
  Map<String, dynamic>? user;

  @override
  void initState() {
    super.initState();
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
    final userStr = prefs.getString('user');
    
    if (token != null && userStr != null) {
      setState(() {
        isAuthenticated = true;
        user = json.decode(userStr);
      });
    }
    setState(() {
      isLoading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (isLoading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    
    if (isAuthenticated && user != null) {
      return DashboardScreen(user: user!, onLogout: () async {
        final prefs = await SharedPreferences.getInstance();
        await prefs.clear();
        setState(() {
          isAuthenticated = false;
          user = null;
        });
      });
    }

    return LoginScreen(onLogin: (u, t) async {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('token', t);
      await prefs.setString('user', json.encode(u));
      setState(() {
        isAuthenticated = true;
        user = u;
      });
    });
  }
}
