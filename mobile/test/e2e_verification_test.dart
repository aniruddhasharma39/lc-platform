import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:mobile/components/device_info_sheet.dart';
import 'package:mobile/screens/cluster/gate_detail_screen.dart';
import 'package:mobile/screens/dashboard_screen.dart';
import 'package:mobile/screens/lc_gates/lc_gates_screen.dart';
import 'package:mobile/screens/reports/reports_screen.dart';
import 'package:mobile/services/home_cache_service.dart';
import 'package:mobile/services/lc_gates_cache_service.dart';
import 'package:mobile/services/reports_cache_service.dart';

const String _snapshotPath =
    r'C:\Users\KRISHNA KHIRBADODIYA\.gemini\antigravity\brain\50c24cde-d2ef-4c70-95c8-bfba90e5866b\scratch\e2e_real_api_snapshots.json';

class _CapturedHttpResponse {
  final int statusCode;
  final String body;
  final Map<String, String> headers;

  const _CapturedHttpResponse({
    this.statusCode = 200,
    required this.body,
    this.headers = const {'content-type': 'application/json; charset=utf-8'},
  });
}

class _E2eFakeHeaders implements HttpHeaders {
  final Map<String, List<String>> _values = {};

  _E2eFakeHeaders([Map<String, String>? initial]) {
    if (initial != null) {
      initial.forEach((k, v) {
        _values[k.toLowerCase()] = [v];
      });
    }
  }

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {
    _values.putIfAbsent(name.toLowerCase(), () => []).add(value.toString());
  }

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    _values[name.toLowerCase()] = [value.toString()];
  }

  @override
  void removeAll(String name) {
    _values.remove(name.toLowerCase());
  }

  @override
  String? value(String name) {
    final list = _values[name.toLowerCase()];
    if (list == null || list.isEmpty) return null;
    return list.first;
  }

  @override
  List<String>? operator [](String name) => _values[name.toLowerCase()];

  @override
  void forEach(void Function(String name, List<String> values) action) {
    _values.forEach(action);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _E2eFakeHttpResponse extends Stream<List<int>> implements HttpClientResponse {
  final _CapturedHttpResponse _spec;
  late final HttpHeaders _headers = _E2eFakeHeaders(_spec.headers);
  late final List<int> _bytes = utf8.encode(_spec.body);

  _E2eFakeHttpResponse(this._spec);

  @override
  int get statusCode => _spec.statusCode;

  @override
  int get contentLength => _bytes.length;

  @override
  bool get isRedirect => false;

  @override
  bool get persistentConnection => false;

  @override
  List<RedirectInfo> get redirects => const [];

  @override
  String get reasonPhrase => _spec.statusCode == 200 ? 'OK' : 'Error';

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

class _E2eFakeHttpRequest implements HttpClientRequest {
  @override
  final Uri uri;
  @override
  final String method;
  final Future<_CapturedHttpResponse> Function(
    String method,
    Uri uri,
    HttpHeaders headers,
    String body,
  ) _handler;
  final HttpHeaders _headers = _E2eFakeHeaders();
  final List<int> _bodyBytes = [];
  Future<HttpClientResponse>? _closed;

  _E2eFakeHttpRequest(this.method, this.uri, this._handler);

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
  void add(List<int> data) => _bodyBytes.addAll(data);

  @override
  void write(Object? object) {
    if (object != null) _bodyBytes.addAll(utf8.encode(object.toString()));
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) async {
    await for (final chunk in stream) {
      _bodyBytes.addAll(chunk);
    }
  }

  @override
  Future<HttpClientResponse> close() {
    return _closed ??= () async {
      final body = utf8.decode(_bodyBytes, allowMalformed: true);
      final spec = await _handler(method, uri, _headers, body);
      return _E2eFakeHttpResponse(spec);
    }();
  }

  @override
  Future<HttpClientResponse> get done => close();

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _E2eFakeHttpClient implements HttpClient {
  final Future<_CapturedHttpResponse> Function(
    String method,
    Uri uri,
    HttpHeaders headers,
    String body,
  ) _handler;

  _E2eFakeHttpClient(this._handler);

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      _E2eFakeHttpRequest(method, url, _handler);

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);

  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('PUT', url);

  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('POST', url);

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _E2eHttpOverrides extends HttpOverrides {
  final Future<_CapturedHttpResponse> Function(
    String method,
    Uri uri,
    HttpHeaders headers,
    String body,
  ) handler;

  _E2eHttpOverrides(this.handler);

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _E2eFakeHttpClient(handler);
}

class _E2eApiBackend {
  final Map<String, dynamic> raw;
  late Map<String, dynamic> devSummary;
  late Map<String, dynamic> smSummary;
  late List<dynamic> devGates;
  late List<dynamic> smGates;
  late Map<String, dynamic> devStatusSummary;
  late Map<String, dynamic> smStatusSummary;

  final List<Uri> requestedUris = [];
  int changesPollCount = 0;
  int putGateCount = 0;

  _E2eApiBackend(this.raw) {
    devSummary = _deepClone(raw['dev']['dashboardSummary']) as Map<String, dynamic>;
    smSummary = _deepClone(raw['sm']['dashboardSummary']) as Map<String, dynamic>;
    devGates = _deepClone(raw['dev']['lcgateAll']) as List<dynamic>;
    smGates = _deepClone(raw['sm']['lcgateAll']) as List<dynamic>;
    devStatusSummary =
        _deepClone(raw['dev']['lcgateStatusSummary']) as Map<String, dynamic>;
    smStatusSummary =
        _deepClone(raw['sm']['lcgateStatusSummary']) as Map<String, dynamic>;
  }

  static dynamic _deepClone(dynamic value) => json.decode(json.encode(value));

  Future<_CapturedHttpResponse> handle(
    String method,
    Uri uri,
    HttpHeaders headers,
    String body,
  ) async {
    requestedUris.add(uri);
    final path = uri.path;
    final auth = headers.value('authorization') ?? '';
    final isSm = auth.contains('e2e-sm-token');
    final scope = _deepClone(raw[isSm ? 'sm' : 'dev']) as Map<String, dynamic>;
    final startDate = uri.queryParameters['startDate'];
    final endDate = uri.queryParameters['endDate'];
    final isTodayOnly =
        startDate != null && endDate != null && startDate == endDate;

    if (path.endsWith('/notifications')) {
      return const _CapturedHttpResponse(
        body: '{"notifications":[],"unreadCount":0}',
      );
    }
    if (path.endsWith('/users')) {
      return const _CapturedHttpResponse(
        body: '{"users":[],"pendingRequests":[]}',
      );
    }
    if (path.endsWith('/roles')) {
      return const _CapturedHttpResponse(body: '{"roles":[]}');
    }
    if (path.endsWith('/modules')) {
      return const _CapturedHttpResponse(body: '{"modules":[]}');
    }
    if (path.endsWith('/settings/branding')) {
      return const _CapturedHttpResponse(body: '{"appName":"LC Platform"}');
    }

    if (path.endsWith('/lcgate/dashboard-summary')) {
      return _CapturedHttpResponse(
        body: json.encode(isSm ? smSummary : devSummary),
        headers: const {
          'content-type': 'application/json; charset=utf-8',
          'etag': 'W/"dash-e2e-v1"',
        },
      );
    }

    if (path.endsWith('/lcgate/status-summary')) {
      return _CapturedHttpResponse(
        body: json.encode(isSm ? smStatusSummary : devStatusSummary),
      );
    }

    if (path.endsWith('/lcgate')) {
      final gates = isSm ? smGates : devGates;
      final configuredOnly = uri.queryParameters['configuredOnly'] == 'true';
      final filtered = configuredOnly
          ? gates.where((g) => g is Map && g['isConfigured'] == true).toList()
          : gates;
      return _CapturedHttpResponse(
        body: json.encode(filtered),
        headers: const {
          'content-type': 'application/json; charset=utf-8',
          'etag': 'W/"lcgate-e2e-v1"',
        },
      );
    }

    final gateIdMatch = RegExp(r'/lcgate/(\d+)$').firstMatch(path);
    if (gateIdMatch != null) {
      final id = int.parse(gateIdMatch.group(1)!);
      final gates = isSm ? smGates : devGates;
      final idx = gates.indexWhere((g) => g is Map && g['id'] == id);
      if (idx == -1) {
        return const _CapturedHttpResponse(
          statusCode: 404,
          body: '{"error":"Not found"}',
        );
      }

      if (method == 'PUT') {
        putGateCount++;
        final patch = json.decode(body) as Map<String, dynamic>;
        for (final targetGates in [devGates, smGates]) {
          final tIdx = targetGates.indexWhere((g) => g is Map && g['id'] == id);
          if (tIdx != -1) {
            final updated = Map<String, dynamic>.from(targetGates[tIdx] as Map);
            for (final k in [
              'name',
              'lcNumber',
              'locationName',
              'zone',
              'division',
              'latitude',
              'longitude',
            ]) {
              if (patch.containsKey(k) && patch[k] != null) {
                updated[k] = patch[k];
              }
            }
            targetGates[tIdx] = updated;
          }
        }
        for (final targetSummary in [devSummary, smSummary]) {
          final sGates = targetSummary['gates'] as List?;
          if (sGates != null) {
            for (int i = 0; i < sGates.length; i++) {
              final g = sGates[i];
              if (g is Map && g['id'] == id) {
                final updated = Map<String, dynamic>.from(g);
                for (final k in ['name', 'lcNumber', 'locationName', 'zone', 'division']) {
                  if (patch.containsKey(k) && patch[k] != null) {
                    updated[k] = patch[k];
                  }
                }
                sGates[i] = updated;
              }
            }
          }
        }
        return _CapturedHttpResponse(body: json.encode(gates[idx]));
      }

      final gateObj = gates[idx];
      return _CapturedHttpResponse(
        body: json.encode({
          ...Map<String, dynamic>.from(gateObj as Map),
          'cluster': gateObj,
        }),
      );
    }

    if (path.endsWith('/reports/clusters')) {
      return _CapturedHttpResponse(
        body: json.encode(scope['reportsClusters']),
        headers: const {
          'content-type': 'application/json; charset=utf-8',
          'etag': 'W/"clusters-e2e-v1"',
        },
      );
    }
    if (path.endsWith('/reports/count')) {
      return _CapturedHttpResponse(
        body: json.encode(
          scope[isTodayOnly ? 'reportsCountToday' : 'reportsCount7d'],
        ),
      );
    }
    if (path.endsWith('/reports/cycle-analytics')) {
      return _CapturedHttpResponse(
        body: json.encode(
          scope[isTodayOnly ? 'reportsCycleToday' : 'reportsCycle7d'],
        ),
      );
    }
    if (path.endsWith('/reports/holistic')) {
      return _CapturedHttpResponse(
        body: json.encode(
          scope[isTodayOnly ? 'reportsHolisticToday' : 'reportsHolistic7d'],
        ),
      );
    }
    if (path.endsWith('/reports/records')) {
      return _CapturedHttpResponse(
        body: json.encode(
          scope[isTodayOnly ? 'reportsRecordsToday' : 'reportsRecords7d'],
        ),
        headers: const {
          'content-type': 'application/json; charset=utf-8',
          'etag': 'W/"records-e2e-v1"',
        },
      );
    }
    if (path.endsWith('/reports/records/changes')) {
      changesPollCount++;
      return _CapturedHttpResponse(
        body: json.encode(scope['reportsChangesToday']),
      );
    }

    return _CapturedHttpResponse(
      statusCode: 404,
      body: '{"error":"Unhandled test route: $method $path"}',
    );
  }
}

Future<void> _settleUi(WidgetTester tester, [int steps = 8]) async {
  for (int i = 0; i < steps; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _clearAllCaches() async {
  await HomeCacheService.instance.clearAllUserCaches();
  await LCGatesCacheService.instance.clearAllUserCaches();
  await ReportsCacheService.instance.clearAllUserCaches();
}

Future<void> _seedAuthPrefs(Map<String, dynamic> user, String token) async {
  SharedPreferences.setMockInitialValues({
    'token': token,
    'userId': user['id'].toString(),
    'user': json.encode(user),
    'userRole': user['role'].toString(),
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final snapshotRaw =
      json.decode(File(_snapshotPath).readAsStringSync()) as Map<String, dynamic>;
  final meta = Map<String, dynamic>.from(snapshotRaw['meta'] as Map);
  final devUser = Map<String, dynamic>.from(meta['devUser'] as Map);
  final smUser = Map<String, dynamic>.from(meta['smUser'] as Map);

  group(
    '[E2E Verification] Real Backend API Snapshot Mobile Suite',
    () {
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await _clearAllCaches();
    });

    testWidgets(
      'Assertions 2-5: Developer & Station Master parity across Home and My Gates',
      timeout: const Timeout(Duration(seconds: 30)),
      (WidgetTester tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final backend = _E2eApiBackend(snapshotRaw);

        await HttpOverrides.runZoned(() async {
          for (final entry in [
            {'user': devUser, 'token': 'e2e-dev-token', 'label': 'Developer'},
            {'user': smUser, 'token': 'e2e-sm-token', 'label': 'Station Master'},
          ]) {
            await _clearAllCaches();
            final user = entry['user'] as Map<String, dynamic>;
            final token = entry['token'] as String;
            await _seedAuthPrefs(user, token);

            // 1. Mount Home (DashboardScreen)
            await tester.pumpWidget(
              MaterialApp(
                home: DashboardScreen(user: user, onLogout: () {}),
              ),
            );
            await _settleUi(tester);

            expect(find.text('TOTAL LC GATES'), findsOneWidget);
            expect(find.text('1 configured (+1 unconfigured)'), findsOneWidget);
            expect(find.text('CYCLES TODAY'), findsWidgets);
            expect(find.text('2'), findsWidgets);
            expect(find.text('AVG OPEN TIME'), findsOneWidget);
            expect(find.text('1m 30s'), findsWidgets);

            // Unmount Home cleanly before mounting My Gates
            await tester.pumpWidget(const SizedBox.shrink());
            await tester.pump();

            // 2. Mount My Gates (LCGatesScreen)
            await tester.pumpWidget(
              MaterialApp(
                home: LCGatesScreen(user: user),
              ),
            );
            await _settleUi(tester);

            // Both configured G1 and unconfigured G2 are rendered & reconciled
            expect(find.text('LC-E2E-G1'), findsOneWidget);
            expect(find.text('G1 Configured Gate'), findsOneWidget);
            expect(find.text('1 Master Unit • 0 Slave Sensors'), findsOneWidget);
            expect(find.text('LC-E2E-G2'), findsOneWidget);
            expect(find.text('G2 Unconfigured Gate'), findsOneWidget);
            expect(find.text('UNCONFIGURED'), findsOneWidget);

            await tester.pumpWidget(const SizedBox.shrink());
            await tester.pump();
          }
        }, createHttpClient: (_) => _E2eHttpOverrides(backend.handle).createHttpClient(null));
      },
    );

    testWidgets(
      'Assertions 3, 4, 5 & 6: ReportsScreen preset switch clears cached tabs, shows 01:00 IST, 45s poll preserves KPIs, Duration/Holistic match Home',
      timeout: const Timeout(Duration(seconds: 30)),
      (WidgetTester tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final backend = _E2eApiBackend(snapshotRaw);

        await HttpOverrides.runZoned(() async {
          await _seedAuthPrefs(devUser, 'e2e-dev-token');

          await tester.pumpWidget(
            MaterialApp(
              home: ReportsScreen(user: devUser),
            ),
          );
          await _settleUi(tester, 12);

          // Step 1: Initial view = Last 7 Days + Count tab (3 operations)
          expect(find.text('Total Ops'), findsOneWidget);
          expect(find.text('3'), findsWidgets);
          expect(find.text('Openings'), findsOneWidget);
          expect(find.text('Closings'), findsOneWidget);

          // Step 2: Switch to Today -> Count must update to 2 (not 3, not double-counted 4)
          await tester.tap(find.text('Today'));
          await _settleUi(tester, 10);

          expect(find.text('Total Ops'), findsOneWidget);
          expect(find.text('2'), findsWidgets);
          expect(find.text('4'), findsNothing);

          // Step 3: Switch to Event Log -> renders 2 records including overnight 01:00 IST event
          await tester.tap(find.text('Event Log'));
          await _settleUi(tester, 10);

          expect(find.text('Logsheet Records (2)'), findsOneWidget);
          expect(find.text('2 ops'), findsOneWidget);
          expect(find.text('1m 30s'), findsWidgets);
          expect(find.text('Opened: 01:00:00'), findsOneWidget);
          expect(find.text('Closed: 01:02:00'), findsOneWidget);

          // Step 4: Advance clock past 45s poll interval -> /reports/records/changes fires & KPIs never jump
          final callsBeforePoll = backend.changesPollCount;
          await tester.pump(const Duration(seconds: 46));
          await _settleUi(tester, 8);

          expect(backend.changesPollCount, greaterThan(callsBeforePoll));
          expect(find.text('Logsheet Records (2)'), findsOneWidget);
          expect(find.text('2 ops'), findsOneWidget);
          expect(find.text('1m 30s'), findsWidgets);

          // Step 5: Switch to Duration tab -> freshly fetched for Today (2 cycles, 1m 30s; ZERO stale 7d 3 / 2m 40s)
          await tester.tap(find.text('Duration'));
          await _settleUi(tester, 10);

          expect(find.text('Completed Cycles'), findsOneWidget);
          expect(find.text('Avg Open Time'), findsOneWidget);
          expect(find.text('2'), findsWidgets);
          expect(find.text('1m 30s'), findsWidgets);
          expect(find.text('2m 40s'), findsNothing);

          // Step 6: Switch to Holistic tab -> freshly fetched for Today (2 ops, 1m 30s; ZERO stale 7d 3 / 2m 40s)
          await tester.tap(find.text('Holistic'));
          await _settleUi(tester, 10);

          expect(find.text('Total Operations'), findsOneWidget);
          expect(find.text('Avg Open Duration'), findsOneWidget);
          expect(find.text('2'), findsWidgets);
          expect(find.text('1m 30s'), findsWidgets);
          expect(find.text('2m 40s'), findsNothing);

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
        }, createHttpClient: (_) => _E2eHttpOverrides(backend.handle).createHttpClient(null));
      },
    );

    testWidgets(
      'Assertion 7: DeviceInfoSheet never queries /devices/:id for unlinked Master, and GateDetailScreen edit reflects in My Gates & Home without relogin',
      timeout: const Timeout(Duration(seconds: 30)),
      (WidgetTester tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        final backend = _E2eApiBackend(snapshotRaw);

        await HttpOverrides.runZoned(() async {
          await _seedAuthPrefs(devUser, 'e2e-dev-token');

          // Part A: Unlinked MasterUnit in DeviceInfoSheet must NEVER query MasterUnit.id as DeviceRegistry.id
          final unlinkedMaster = <String, dynamic>{
            'id': 999,
            'masterSeq': 2,
            'serialNumber': 'MA-E2E-UNLINKED (Virtual Master)',
            'isVirtual': true,
            'status': 'OFFLINE',
            'deviceRegistries': <dynamic>[],
          };

          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: SingleChildScrollView(
                  child: DeviceInfoSheet(
                    gate: Map<String, dynamic>.from(backend.devGates[1] as Map),
                    master: unlinkedMaster,
                  ),
                ),
              ),
            ),
          );
          await _settleUi(tester);

          expect(find.text('VIRTUAL / UNLINKED'), findsOneWidget);
          expect(find.text('Virtual / Unlinked Master'), findsOneWidget);
          expect(find.text('Check Connection Now'), findsNothing);
          expect(
            backend.requestedUris.any((u) => u.path.contains('/devices')),
            isFalse,
            reason: 'Unlinked Master must never issue /devices/:id requests',
          );

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();

          // Part B: Pre-warm Home and My Gates caches with original G1 name
          await tester.pumpWidget(
            MaterialApp(
              home: DashboardScreen(user: devUser, onLogout: () {}),
            ),
          );
          await _settleUi(tester);
          expect(find.text('Kurla East'), findsWidgets);
          expect(HomeCacheService.instance.getMemoryCachedDashboard('1'), isNotNull);

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();

          await tester.pumpWidget(
            MaterialApp(
              home: LCGatesScreen(user: devUser),
            ),
          );
          await _settleUi(tester);
          expect(find.text('G1 Configured Gate'), findsOneWidget);
          expect(find.text('1 Master Unit • 0 Slave Sensors'), findsOneWidget);

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();

          // Edit G1 in GateDetailScreen
          final g1Gate = Map<String, dynamic>.from(
            backend.devGates.firstWhere((g) => (g as Map)['id'] == 1) as Map,
          );
          await tester.pumpWidget(
            MaterialApp(
              home: GateDetailScreen(token: 'e2e-dev-token', gate: g1Gate),
            ),
          );
          await _settleUi(tester);

          await tester.tap(find.byTooltip('Edit LC Gate'));
          await _settleUi(tester);

          await tester.enterText(
            find.widgetWithText(TextField, 'G1 Configured Gate'),
            'G1 Renamed E2E Gate',
          );
          await tester.enterText(
            find.widgetWithText(TextField, 'Kurla East'),
            'Kurla East E2E',
          );
          await tester.tap(find.text('Save Changes'));
          await _settleUi(tester, 12);

          expect(backend.putGateCount, 1);
          expect(
            HomeCacheService.instance.getMemoryCachedDashboard('1'),
            isNull,
            reason: 'HomeCacheService must be cleared when editing gate',
          );

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();

          // Navigate back to My Gates & Home WITHOUT relogin (same SharedPreferences/token)
          await tester.pumpWidget(
            MaterialApp(
              home: LCGatesScreen(user: devUser),
            ),
          );
          await _settleUi(tester, 10);

          expect(find.text('G1 Renamed E2E Gate'), findsOneWidget);
          expect(find.text('G1 Configured Gate'), findsNothing);
          expect(find.text('1 Master Unit • 0 Slave Sensors'), findsOneWidget);

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();

          await tester.pumpWidget(
            MaterialApp(
              home: DashboardScreen(user: devUser, onLogout: () {}),
            ),
          );
          await _settleUi(tester, 10);

          expect(find.text('Kurla East E2E'), findsOneWidget);
          expect(find.text('Kurla East'), findsNothing);

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
        }, createHttpClient: (_) => _E2eHttpOverrides(backend.handle).createHttpClient(null));
      },
    );
  });
}

