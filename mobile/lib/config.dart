import 'package:flutter/foundation.dart';

/// In debug or web mode (e.g. `flutter run -d chrome`), connect to the local backend server (port 5001)
/// where live hierarchy, parentId, and sub-group migrations are active.
/// In production or mobile builds, falls back to the production URL.
String get baseUrl {
  if (kIsWeb) {
    return 'http://localhost:5001/api/v1';
  }
  if (kDebugMode && defaultTargetPlatform == TargetPlatform.android) {
    return 'http://10.0.2.2:5001/api/v1';
  }
  return 'https://lc-platform.onrender.com/api/v1';
}
