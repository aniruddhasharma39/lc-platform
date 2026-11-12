import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/utils/user_utils.dart';
import 'package:mobile/services/home_cache_service.dart';
import 'package:mobile/services/lc_gates_cache_service.dart';
import 'package:mobile/services/reports_cache_service.dart';
import 'package:mobile/components/device_info_sheet.dart';
import 'package:mobile/screens/reports/reports_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('[P1.2] Session userId & Cache Invalidation', () {
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await HomeCacheService.instance.clearAllUserCaches();
      await LCGatesCacheService.instance.clearAllUserCaches();
    });

    test('resolveCurrentUserId prioritizes id over employeeId and persists/clears cleanly', () async {
      final prefs = await SharedPreferences.getInstance();

      expect(
        resolveCurrentUserId(user: {'id': 42, 'employeeId': 'EMP-42', 'username': 'jdoe'}, prefs: prefs),
        '42',
      );

      await persistUserSessionPrefs(prefs, {'id': 42, 'employeeId': 'EMP-42'});
      expect(prefs.getString('userId'), '42');
      expect(prefs.getString('employeeId'), 'EMP-42');

      // Secondary screens without widget.user pick up canonical numeric 'userId', never 'EMP-42'
      expect(resolveCurrentUserId(user: null, prefs: prefs), '42');
      expect(await loadCurrentUserId(), '42');

      // Clear on logout
      await clearUserSessionPrefs(prefs);
      expect(prefs.getString('userId'), isNull);
      expect(prefs.getString('employeeId'), isNull);
      expect(resolveCurrentUserId(user: null, prefs: prefs), 'user');
    });

    test('LCGatesCacheService.markAllStale invalidates both lc_gates_dir_v2 and lc_cluster_v2 on disk even if memory is cold', () async {
      final nowIso = DateTime.now().toIso8601String();
      final dirKey = 'lc_gates_dir_v${LCGatesCacheService.schemaVersion}_42';
      final clusterKey = 'lc_cluster_v${LCGatesCacheService.schemaVersion}_u42_sdefault_d0';

      SharedPreferences.setMockInitialValues({
        dirKey: json.encode({
          'schemaVersion': LCGatesCacheService.schemaVersion,
          'gates': [{'id': 1, 'lcNumber': 'LC-101'}],
          'scopeGroups': [],
          'etag': 'W/"dir-etag"',
          'lastSyncedAt': nowIso,
          'gatesSyncedAt': nowIso,
          'scopeGroupsSyncedAt': nowIso,
          'hierarchySyncedAt': nowIso,
        }),
        clusterKey: json.encode({
          'schemaVersion': LCGatesCacheService.schemaVersion,
          'gates': [{'id': 1, 'lcNumber': 'LC-101'}],
          'scopeGroups': [],
          'etag': 'W/"cluster-etag"',
          'lastSyncedAt': nowIso,
          'gatesSyncedAt': nowIso,
          'scopeGroupsSyncedAt': nowIso,
          'hierarchySyncedAt': nowIso,
        }),
      });

      await LCGatesCacheService.instance.markAllStale('42');

      final prefs = await SharedPreferences.getInstance();
      final dirJson = json.decode(prefs.getString(dirKey)!) as Map<String, dynamic>;
      final clusterJson = json.decode(prefs.getString(clusterKey)!) as Map<String, dynamic>;
      final epochIso = DateTime.fromMillisecondsSinceEpoch(0).toIso8601String();

      expect(dirJson['etag'], isNull);
      expect(dirJson['gatesSyncedAt'], epochIso);
      expect(dirJson['lastSyncedAt'], epochIso);

      expect(clusterJson['etag'], isNull);
      expect(clusterJson['lastSyncedAt'], epochIso);
    });

    test('HomeCacheService.clearAllUserCaches clears all user dashboard keys from prefs', () async {
      SharedPreferences.setMockInitialValues({
        'home_dashboard_cache_42': '{"data":{},"cachedDate":"2026-11-11","lastSyncedAt":"2026-11-11T00:00:00Z"}',
        'home_dashboard_cache_99': '{"data":{},"cachedDate":"2026-11-11","lastSyncedAt":"2026-11-11T00:00:00Z"}',
        'unrelated_key': 'keep_me',
      });

      await HomeCacheService.instance.clearAllUserCaches();
      final prefs = await SharedPreferences.getInstance();

      expect(prefs.getString('home_dashboard_cache_42'), isNull);
      expect(prefs.getString('home_dashboard_cache_99'), isNull);
      expect(prefs.getString('unrelated_key'), 'keep_me');
    });
  });

  group('[P1.3] DeviceInfoSheet Virtual/Unlinked Master Guard', () {
    test('Unlinked MasterUnit never leaks MasterUnit.id as deviceId', () {
      final target = resolveDeviceInfoTarget(
        master: {
          'id': 5,
          'serialNumber': 'MA-1774689415 (Virtual Master)',
          'status': 'OFFLINE',
        },
      );

      expect(target.deviceId, isNull);
      expect(target.isVirtualUnlinked, isTrue);
      expect(target.canQueryTelemetry, isFalse);
      expect(target.connectivityStatus, 'VIRTUAL / UNLINKED');
    });

    test('MasterUnit with singular deviceRegistry resolves linked deviceId and hardware ThingName', () {
      final target = resolveDeviceInfoTarget(
        master: {
          'id': 5,
          'serialNumber': 'LC-M-088',
          'deviceRegistry': {
            'id': 88,
            'thingName': 'LC-M-088',
            'deviceType': 'MASTER',
            'connectivityStatus': 'ONLINE',
          },
        },
      );

      expect(target.deviceId, 88);
      expect(target.thingName, 'LC-M-088');
      expect(target.isVirtualUnlinked, isFalse);
      expect(target.canQueryTelemetry, isTrue);
      expect(target.connectivityStatus, 'ONLINE');
    });

    test('MasterUnit without deviceRegistry but with valid awsThingName queries by ThingName without MasterUnit.id', () {
      final target = resolveDeviceInfoTarget(
        master: {
          'id': 5,
          'awsThingName': 'LC-M-099',
          'connectivityStatus': 'ONLINE',
        },
      );

      expect(target.deviceId, isNull);
      expect(target.thingName, 'LC-M-099');
      expect(target.isVirtualUnlinked, isFalse);
      expect(target.canQueryTelemetry, isTrue);
    });

    test('Gate with no masters never treats lcNumber as AWS IoT thingName', () {
      final target = resolveDeviceInfoTarget(
        gate: {
          'id': 12,
          'lcNumber': 'LC-101',
          'masters': [],
          'deviceRegistries': [],
        },
      );

      expect(target.deviceId, isNull);
      expect(target.isVirtualUnlinked, isTrue);
      expect(target.canQueryTelemetry, isFalse);
      expect(target.thingName, 'Virtual / Unlinked Master');
    });

    testWidgets('DeviceInfoSheet renders Virtual / Unlinked Master cleanly and hides Ping action', (tester) async {
      SharedPreferences.setMockInitialValues({'token': 'test-token'});

      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: DeviceInfoSheet(
              master: {
                'id': 5,
                'serialNumber': 'MA-1774689415 (Virtual Master)',
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('VIRTUAL / UNLINKED'), findsOneWidget);
      expect(find.text('Virtual / Unlinked Master'), findsOneWidget);
      expect(find.byIcon(Icons.network_ping), findsNothing);
      expect(find.text('Check Connection Now'), findsNothing);
    });
  });

  group('[P1.4] ReportsScreen Stale Tab Reset on Filter Change', () {
    testWidgets('Changing date preset clears cached Duration tab snapshot and forces fresh fetch', (tester) async {
      SharedPreferences.setMockInitialValues({'token': 'test-token', 'userId': '42'});
      await ReportsCacheService.instance.clearAllUserCaches();

      final requestedUris = <Uri>[];
      final now = DateTime.now();
      String fmt(DateTime d) =>
          '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
      final todayStr = fmt(now);

      final client = _FakeHttpClient((uri) {
        requestedUris.add(uri);
        final path = uri.path;
        if (path.endsWith('/reports/clusters')) {
          return json.encode({
            'isDeveloper': false,
            'clusters': [
              {
                'id': 1,
                'name': 'Cluster 1',
                'gates': [
                  {'id': 10, 'lcNumber': 'LC-101', 'name': 'Gate 101'}
                ],
              }
            ],
          });
        }
        final isTodayOnly = uri.queryParameters['startDate'] == todayStr &&
            uri.queryParameters['endDate'] == todayStr;
        if (path.endsWith('/reports/count')) {
          return json.encode({
            'kpis': {
              'totalOperations': isTodayOnly ? 11 : 77,
              'totalOpenCount': isTodayOnly ? 11 : 77,
              'totalCloseCount': isTodayOnly ? 11 : 77,
              'reportingGatesCount': 1,
            },
            'gates': [],
            'stations': [],
            'divisions': [],
            'zones': [],
          });
        }
        if (path.endsWith('/reports/cycle-analytics')) {
          return json.encode({
            'overall': {
              'totalCycles': isTodayOnly ? 11 : 77,
              'avgOpenFormatted': '2m',
              'avgClosedFormatted': '10m',
              'reportingGatesCount': 1,
            },
            'gateReports': [],
          });
        }
        return json.encode({});
      });

      await HttpOverrides.runZoned(() async {
        await tester.pumpWidget(
          const MaterialApp(
            home: Scaffold(
              body: ReportsScreen(user: {'id': 42, 'role': 'Station Master'}),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 1. Switch to Duration tab under default '7days' preset -> fetches cycle-analytics once (value 77)
        await tester.tap(find.text('Duration'));
        await tester.pumpAndSettle();

        final initialCycleRequests =
            requestedUris.where((u) => u.path.endsWith('/reports/cycle-analytics')).toList();
        expect(initialCycleRequests.length, 1);
        expect(find.text('77'), findsWidgets);

        // 2. Switch back to Count tab and change Date Preset to 'Today'
        await tester.tap(find.text('Count'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Today'));
        await tester.pumpAndSettle();

        // 3. Switch to Duration tab again -> MUST NOT reuse stale '77'; must re-fetch with Today dates!
        await tester.tap(find.text('Duration'));
        await tester.pumpAndSettle();

        final cycleRequests =
            requestedUris.where((u) => u.path.endsWith('/reports/cycle-analytics')).toList();
        expect(cycleRequests.length, 2);
        expect(cycleRequests.last.queryParameters['startDate'], todayStr);
        expect(cycleRequests.last.queryParameters['endDate'], todayStr);
        expect(find.text('11'), findsWidgets);
        expect(find.text('77'), findsNothing);
      }, createHttpClient: (_) => client);
    });
  });
}

class _FakeHttpHeaders implements HttpHeaders {
  final Map<String, List<String>> _headers = {'content-type': ['application/json']};

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {
    _headers.putIfAbsent(name.toLowerCase(), () => []).add(value.toString());
  }

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    _headers[name.toLowerCase()] = [value.toString()];
  }

  @override
  String? value(String name) => _headers[name.toLowerCase()]?.first;

  @override
  void forEach(void Function(String name, List<String> values) action) {
    _headers.forEach(action);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeHttpClientResponse extends Stream<List<int>> implements HttpClientResponse {
  final List<int> _bytes;
  final HttpHeaders _headers = _FakeHttpHeaders();

  _FakeHttpClientResponse(String body) : _bytes = utf8.encode(body);

  @override
  int get statusCode => 200;

  @override
  String get reasonPhrase => 'OK';

  @override
  int get contentLength => _bytes.length;

  @override
  bool get isRedirect => false;

  @override
  List<RedirectInfo> get redirects => const [];

  @override
  bool get persistentConnection => false;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;

  @override
  HttpHeaders get headers => _headers;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.fromIterable([_bytes]).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeHttpClientRequest implements HttpClientRequest {
  @override
  final Uri uri;
  final String Function(Uri uri) resolver;
  final HttpHeaders _headers = _FakeHttpHeaders();
  Future<HttpClientResponse>? _closed;

  _FakeHttpClientRequest(this.uri, this.resolver);

  @override
  HttpHeaders get headers => _headers;

  @override
  int contentLength = -1;

  @override
  bool followRedirects = true;

  @override
  int maxRedirects = 5;

  @override
  bool persistentConnection = false;

  @override
  bool bufferOutput = true;

  @override
  Encoding encoding = utf8;

  @override
  void add(List<int> data) {}

  @override
  Future<void> addStream(Stream<List<int>> stream) async {
    await stream.drain<void>();
  }

  @override
  Future<HttpClientResponse> close() =>
      _closed ??= Future<HttpClientResponse>.value(_FakeHttpClientResponse(resolver(uri)));

  @override
  Future<HttpClientResponse> get done => close();

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeHttpClient implements HttpClient {
  final String Function(Uri uri) resolver;
  _FakeHttpClient(this.resolver);

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      _FakeHttpClientRequest(url, resolver);

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

