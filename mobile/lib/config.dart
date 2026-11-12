import 'package:flutter/foundation.dart';

const bool _useLocalBackend = bool.fromEnvironment('USE_LOCAL_BACKEND', defaultValue: false);
const String _apiUrlOverride = String.fromEnvironment('API_BASE_URL');
const String _defaultEc2BaseUrl = 'http://13.234.106.118:5000/api/v1';

/// Resolves the active API base URL.
///
/// Connects to the AWS EC2 backend (`http://13.234.106.118:5000/api/v1`) by default,
/// or uses `API_BASE_URL` `--dart-define` when supplied (with trailing slash stripped).
/// Local debug runs can pass `--dart-define=USE_LOCAL_BACKEND=true` for port 5001.
String resolveApiBaseUrl({
  String apiUrlOverride = '',
  bool useLocalBackend = false,
  bool isReleaseMode = kReleaseMode,
  bool isWeb = kIsWeb,
  bool isDebugAndroid = kDebugMode,
  TargetPlatform? platform,
  String? webHost,
}) {
  final trimmedOverride = apiUrlOverride.trim();
  if (trimmedOverride.isNotEmpty) {
    final normalized = trimmedOverride.endsWith('/')
        ? trimmedOverride.substring(0, trimmedOverride.length - 1)
        : trimmedOverride;
    return normalized;
  }

  if (!isReleaseMode && useLocalBackend) {
    if (isWeb) {
      final host = (webHost != null && webHost.isNotEmpty && webHost != '0.0.0.0')
          ? webHost
          : 'localhost';
      return 'http://$host:5001/api/v1';
    }
    final activePlatform = platform ?? defaultTargetPlatform;
    if (isDebugAndroid && activePlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:5001/api/v1';
    }
    return 'http://localhost:5001/api/v1';
  }

  return _defaultEc2BaseUrl;
}

/// Active backend base URL (defaults to EC2 at `http://13.234.106.118:5000/api/v1`).
/// Pass `--dart-define=API_BASE_URL=...` or `--dart-define=USE_LOCAL_BACKEND=true` in debug mode.
String get baseUrl => resolveApiBaseUrl(
      apiUrlOverride: _apiUrlOverride,
      useLocalBackend: _useLocalBackend,
      isReleaseMode: kReleaseMode,
      isWeb: kIsWeb,
      isDebugAndroid: kDebugMode,
      platform: defaultTargetPlatform,
      webHost: Uri.base.host,
    );
