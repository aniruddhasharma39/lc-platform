import 'package:flutter/foundation.dart';

const bool _useLocalBackend = bool.fromEnvironment('USE_LOCAL_BACKEND', defaultValue: false);
const String _apiUrlOverride = String.fromEnvironment('API_BASE_URL');

/// Connects to the AWS EC2 backend by default.
/// Pass --dart-define=USE_LOCAL_BACKEND=true for local development against port 5001,
/// or --dart-define=API_BASE_URL=https://... to override dynamically.
String get baseUrl {
  if (_apiUrlOverride.isNotEmpty) {
    return _apiUrlOverride;
  }
  if (_useLocalBackend) {
    if (kIsWeb) {
      final host = (Uri.base.host.isNotEmpty && Uri.base.host != '0.0.0.0') ? Uri.base.host : 'localhost';
      return 'http://$host:5001/api/v1';
    }
    if (kDebugMode && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:5001/api/v1';
    }
  }
  return 'http://13.234.106.118:5000/api/v1';
}
