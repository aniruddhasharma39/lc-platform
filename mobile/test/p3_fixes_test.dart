import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config.dart';

void main() {
  group('[P3] API Base URL & Environment Resolution', () {
    test('defaults to EC2 endpoint when no override is supplied', () {
      expect(baseUrl, 'http://13.234.106.118:5000/api/v1');
      expect(
        resolveApiBaseUrl(isReleaseMode: true),
        'http://13.234.106.118:5000/api/v1',
      );
      expect(
        resolveApiBaseUrl(isReleaseMode: false, useLocalBackend: false),
        'http://13.234.106.118:5000/api/v1',
      );
    });

    test('release mode allows explicit API_BASE_URL overrides and strips trailing slash', () {
      expect(
        resolveApiBaseUrl(
          apiUrlOverride: 'http://13.234.106.118:5000/api/v1/',
          isReleaseMode: true,
        ),
        'http://13.234.106.118:5000/api/v1',
      );
      expect(
        resolveApiBaseUrl(
          apiUrlOverride: 'https://13.234.106.118/api/v1/',
          isReleaseMode: true,
        ),
        'https://13.234.106.118/api/v1',
      );
    });

    test('debug mode resolves local backend URLs only when useLocalBackend is true', () {
      expect(
        resolveApiBaseUrl(
          useLocalBackend: true,
          isReleaseMode: false,
          isWeb: false,
          isDebugAndroid: true,
          platform: TargetPlatform.android,
        ),
        'http://10.0.2.2:5001/api/v1',
      );
      expect(
        resolveApiBaseUrl(
          useLocalBackend: true,
          isReleaseMode: false,
          isWeb: false,
          isDebugAndroid: false,
          platform: TargetPlatform.windows,
        ),
        'http://localhost:5001/api/v1',
      );
      expect(
        resolveApiBaseUrl(
          useLocalBackend: true,
          isReleaseMode: false,
          isWeb: true,
          webHost: '192.168.1.50',
        ),
        'http://192.168.1.50:5001/api/v1',
      );
      // Even if useLocalBackend=true, release mode forces EC2 default
      expect(
        resolveApiBaseUrl(
          useLocalBackend: true,
          isReleaseMode: true,
        ),
        'http://13.234.106.118:5000/api/v1',
      );
    });
  });
}

