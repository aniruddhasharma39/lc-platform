import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const bool _useLocalBackend = bool.fromEnvironment('USE_LOCAL_BACKEND', defaultValue: false);
const String _apiUrlOverride = String.fromEnvironment('API_BASE_URL');
const String _defaultEc2BaseUrl = 'http://13.234.106.118:5000/api/v1';

// Dynamic Firestore config REST endpoint
const String _firestoreConfigUrl =
    'https://firestore.googleapis.com/v1/projects/lc-gate-management/databases/(default)/documents/app_config/server';

String _dynamicBaseUrl = _defaultEc2BaseUrl;

/// Active backend base URL.
/// Dynamically resolved from Cloud Firestore and locally cached in SharedPreferences.
String get baseUrl {
  final trimmedOverride = _apiUrlOverride.trim();
  if (trimmedOverride.isNotEmpty) {
    return trimmedOverride.endsWith('/')
        ? trimmedOverride.substring(0, trimmedOverride.length - 1)
        : trimmedOverride;
  }

  if (!kReleaseMode && _useLocalBackend) {
    if (kIsWeb) {
      final host = (Uri.base.host.isNotEmpty && Uri.base.host != '0.0.0.0')
          ? Uri.base.host
          : 'localhost';
      return 'http://$host:5001/api/v1';
    }
    final activePlatform = defaultTargetPlatform;
    if (kDebugMode && activePlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:5001/api/v1';
    }
    return 'http://localhost:5001/api/v1';
  }

  return _dynamicBaseUrl;
}

/// Initializes dynamic base URL from SharedPreferences cache,
/// and updates it from Google Cloud Firestore in the background.
Future<void> initDynamicConfig() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final cached = prefs.getString('cached_backend_base_url');
    if (cached != null && cached.trim().isNotEmpty) {
      _dynamicBaseUrl = cached.trim();
    }

    // Fetch latest live config from Firestore REST endpoint
    final res = await http
        .get(Uri.parse(_firestoreConfigUrl))
        .timeout(const Duration(seconds: 4));

    if (res.statusCode == 200) {
      final json = jsonDecode(res.body);
      final rawValue = json?['fields']?['baseUrl']?['stringValue'];
      final remoteValue = rawValue?.toString().trim();
      if (remoteValue != null && remoteValue.isNotEmpty && remoteValue.startsWith('http')) {
        final cleanUrl = remoteValue.endsWith('/')
            ? remoteValue.substring(0, remoteValue.length - 1)
            : remoteValue;
        _dynamicBaseUrl = cleanUrl;
        await prefs.setString('cached_backend_base_url', cleanUrl);
        debugPrint('[DynamicConfig] Synced active baseUrl from Firestore: $cleanUrl');
      }
    }
  } catch (e) {
    debugPrint('[DynamicConfig] Error syncing Firestore baseUrl (using cache/default): $e');
  }
}

