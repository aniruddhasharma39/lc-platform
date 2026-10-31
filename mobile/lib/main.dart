import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'config.dart';
import 'screens/login_screen.dart';
import 'screens/dashboard_screen.dart';
import 'utils/app_feedback.dart';

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
  static const textMain = Color(0xFF1E293B);
  static const textMuted = Color(0xFF64748B);
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
  Map<String, dynamic>? _cachedBranding;

  @override
  void initState() {
    super.initState();
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('token');
    final userStr = prefs.getString('user');
    final brandingStr = prefs.getString('cached_branding');

    if (brandingStr != null && brandingStr.isNotEmpty) {
      try {
        final decoded = json.decode(brandingStr);
        if (decoded is Map<String, dynamic>) {
          _cachedBranding = decoded;
          final logoUrl = _cachedBranding!['logoUrl'] ?? _cachedBranding!['wallpaperUrl'];
          if (logoUrl != null && logoUrl.toString().trim().isNotEmpty) {
            precacheImage(NetworkImage(logoUrl.toString()), context).catchError((_) {});
          }
        }
      } catch (_) {}
    }
    
    if (token != null && userStr != null) {
      try {
        final res = await http.get(
          Uri.parse('$baseUrl/auth/me'),
          headers: {'Authorization': 'Bearer $token'},
        ).timeout(const Duration(seconds: 8));

        if (res.statusCode == 200) {
          final serverUser = json.decode(res.body);
          if (mounted) {
            setState(() {
              isAuthenticated = true;
              user = serverUser is Map<String, dynamic> ? serverUser : json.decode(userStr);
            });
          }
        } else if (res.statusCode == 401) {
          // Token expired or invalid! Clear storage and show LoginScreen
          await prefs.remove('token');
          await prefs.remove('user');
          for (final k in prefs.getKeys()) {
            if (k.startsWith('home_dashboard_cache_')) {
              await prefs.remove(k);
            }
          }
          if (mounted) {
            setState(() {
              isAuthenticated = false;
              user = null;
            });
            AppFeedback.showWarning(context, 'Your session has expired. Please log in again.');
          }
        } else {
          // Temporary server error, keep cached session
          if (mounted) {
            setState(() {
              isAuthenticated = true;
              user = json.decode(userStr);
            });
          }
        }
      } catch (_) {
        // Network offline or timeout, continue with cached session
        if (mounted) {
          setState(() {
            isAuthenticated = true;
            user = json.decode(userStr);
          });
        }
      }
    }
    if (mounted) {
      setState(() {
        isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (isLoading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    
    if (isAuthenticated && user != null) {
      return DashboardScreen(user: user!, onLogout: () async {
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove('token');
        await prefs.remove('user');
        for (final k in prefs.getKeys()) {
          if (k.startsWith('home_dashboard_cache_')) {
            await prefs.remove(k);
          }
        }
        if (!mounted) return;
        setState(() {
          isAuthenticated = false;
          user = null;
        });
        AppFeedback.showInfo(this.context, 'You have been logged out successfully.');
      });
    }

    return LoginScreen(
      initialBranding: _cachedBranding,
      onLogin: (u, t) async {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('token', t);
        await prefs.setString('user', json.encode(u));
        if (!mounted) return;
        setState(() {
          isAuthenticated = true;
          user = u;
        });
        final name = u['fullName'] ?? u['name'] ?? 'User';
        AppFeedback.showSuccess(this.context, 'Welcome back, $name!');
      },
    );
  }
}
