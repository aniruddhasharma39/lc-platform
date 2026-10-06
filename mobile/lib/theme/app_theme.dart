import 'package:flutter/material.dart';

class AppTheme {
  static const Color primary = Color(0xFF0B3C7A);
  static const Color secondary = Color(0xFF0E9AA7);
  static const Color accent = Color(0xFFF5A623);
  static const Color success = Color(0xFF2E9E5B);
  static const Color danger = Color(0xFF064545);
  static const Color surface = Color(0xFFF4F6F9);

  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      colorScheme: const ColorScheme.light(
        primary: primary,
        secondary: secondary,
        surface: surface,
        error: danger,
        onPrimary: Colors.white,
        onSecondary: Colors.white,
        onSurface: primary,
        onError: Colors.white,
      ),
      scaffoldBackgroundColor: surface,
      appBarTheme: const AppBarTheme(
        backgroundColor: primary,
        foregroundColor: Colors.white,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: Colors.white,
        ),
      ),
    );
  }
}
