import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/config.dart';
import 'package:mobile/screens/device_registry/device_registry_screen.dart';
import 'package:mobile/screens/lc_gates/lc_gates_screen.dart';
import 'package:mobile/services/lc_gates_cache_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('[P2.2] resolveDevicePhotoUrl & Pagination > 50', () {
    test('resolveDevicePhotoUrl handles missing leading slash and cache-busting version', () {
      expect(
        resolveDevicePhotoUrl('uploads/sim1.jpg'),
        '$baseUrl/uploads/sim1.jpg',
      );
      expect(
        resolveDevicePhotoUrl('/uploads/sim1.jpg', version: '2026-11-11T10:00:00Z'),
        '$baseUrl/uploads/sim1.jpg?v=2026-11-11T10%3A00%3A00Z',
      );
      expect(
        resolveDevicePhotoUrl('https://cdn.example.com/sim.jpg?w=200', version: '42'),
        'https://cdn.example.com/sim.jpg?w=200&v=42',
      );
      expect(resolveDevicePhotoUrl(''), '');
    });

    testWidgets('DeviceRegistryScreen paginates beyond 50 devices with Load More', (tester) async {
      SharedPreferences.setMockInitialValues({'token': 'test-token', 'userId': '77'});

      final page1Devices = List.generate(
        50,
        (i) => {
          'id': i + 1,
          'thingName': 'LC-M-${(i + 1).toString().padLeft(3, '0')}',
          'serialNumber': 'SN-${i + 1}',
          'deviceType': 'MASTER',
          'status': 'ACTIVE',
          'connectivityStatus': 'ONLINE',
        },
      );
      final page2Devices = List.generate(
        10,
        (i) => {
          'id': 51 + i,
          'thingName': 'LC-M-${(51 + i).toString().padLeft(3, '0')}',
          'serialNumber': 'SN-${51 + i}',
          'deviceType': 'MASTER',
          'status': 'ACTIVE',
          'connectivityStatus': 'ONLINE',
        },
      );

      final client = _P2FakeHttpClient((uri) {
        if (uri.path.endsWith('/devices')) {
          final page = int.tryParse(uri.queryParameters['page'] ?? '1') ?? 1;
          return json.encode({
            'devices': page == 1 ? page1Devices : page2Devices,
            'summary': {'total': 60, 'online': 60, 'offline': 0},
            'pagination': {'page': page, 'limit': 50, 'total': 60, 'totalPages': 2},
          });
        }
        return json.encode({});
      });

      await HttpOverrides.runZoned(() async {
        await tester.pumpWidget(
          const MaterialApp(
            home: DeviceRegistryScreen(user: {'id': 77, 'role': 'Developer'}),
          ),
        );
        await tester.pumpAndSettle();

        final verticalScrollable = find.byWidgetPredicate(
          (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
        );
        final loadMoreFinder = find.text('Load More (50 of 60)');
        await tester.scrollUntilVisible(
          loadMoreFinder,
          500,
          scrollable: verticalScrollable,
          maxScrolls: 100,
        );
        expect(loadMoreFinder, findsOneWidget);

        await tester.ensureVisible(loadMoreFinder);
        await tester.pumpAndSettle();
        await tester.tap(loadMoreFinder);
        await tester.pumpAndSettle();

        expect(find.text('Load More (50 of 60)'), findsNothing);
        // Item 60 is now rendered in scrollable sliver list
        final item60Finder = find.text('LC-M-060');
        await tester.scrollUntilVisible(
          item60Finder,
          500,
          scrollable: verticalScrollable,
          maxScrolls: 50,
        );
        expect(item60Finder, findsOneWidget);
      }, createHttpClient: (_) => client);
    });
  });

  group('[P2.1] LCGatesScreen _refreshSelectedGate preserves top-level fields', () {
    testWidgets('Merging cluster detail preserves connectivity fields even if omitted in response', (tester) async {
      SharedPreferences.setMockInitialValues({'token': 'test-token', 'userId': '77'});
      await LCGatesCacheService.instance.clearAllUserCaches();

      final hwMasters = [
        {
          'id': 5,
          'masterSequence': 1,
          'serialNumber': 'LC-M-10',
          'awsThingName': 'LC-M-10',
          'deviceRegistry': {
            'id': 9,
            'thingName': 'LC-M-10',
            'connectivityStatus': 'ONLINE',
          },
        }
      ];

      final client = _P2FakeHttpClient((uri) {
        if (uri.path.endsWith('/lcgate')) {
          return json.encode([
            {
              'id': 10,
              'lcNumber': 'LC-101',
              'name': 'Gate 101',
              'locationName': 'Kurla',
              'isConfigured': true,
              'isOnline': true,
              'status': 'OPEN',
              'currentStatus': 'OPEN',
              'deviceStatus': 'ONLINE',
              'masters': hwMasters,
            }
          ]);
        }
        if (uri.path.endsWith('/lcgate/status-summary')) {
          return json.encode({'verifiedAt': DateTime.now().toIso8601String(), 'statuses': []});
        }
        if (uri.path.endsWith('/lcgate/10')) {
          // Simulate payload with cluster omitting top-level isOnline / status / deviceStatus
          return json.encode({
            'cluster': {
              'id': 10,
              'lcNumber': 'LC-101',
              'name': 'Gate 101 Refreshed',
              'locationName': 'Kurla',
              'masters': hwMasters,
            }
          });
        }
        return json.encode({});
      });

      await HttpOverrides.runZoned(() async {
        await tester.pumpWidget(
          const MaterialApp(
            home: LCGatesScreen(
              user: {'id': 77, 'role': 'Developer'},
              initialGateId: 10,
              initialTab: 'telemetry',
            ),
          ),
        );
        await tester.pumpAndSettle();

        // Trigger detail refresh inside selected gate header
        final refreshIcon = find.byIcon(Icons.refresh).first;
        await tester.tap(refreshIcon);
        await tester.pumpAndSettle();

        // Merge preserved `isOnline: true` and `status: OPEN` on _selectedGate
        expect(find.textContaining('ONLINE'), findsWidgets);
        expect(find.textContaining('OPEN'), findsWidgets);
      }, createHttpClient: (_) => client);
    });
  });
}

class _P2FakeHeaders implements HttpHeaders {
  final Map<String, List<String>> _h = {'content-type': ['application/json']};

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) =>
      _h.putIfAbsent(name.toLowerCase(), () => []).add(value.toString());

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) =>
      _h[name.toLowerCase()] = [value.toString()];

  @override
  String? value(String name) => _h[name.toLowerCase()]?.first;

  @override
  void forEach(void Function(String name, List<String> values) action) => _h.forEach(action);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _P2FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  final List<int> _bytes;
  final HttpHeaders _headers = _P2FakeHeaders();
  _P2FakeResponse(String body) : _bytes = utf8.encode(body);

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
  }) =>
      Stream<List<int>>.fromIterable([_bytes]).listen(
        onData,
        onError: onError,
        onDone: onDone,
        cancelOnError: cancelOnError,
      );

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _P2FakeRequest implements HttpClientRequest {
  @override
  final Uri uri;
  final String Function(Uri uri) resolver;
  final HttpHeaders _headers = _P2FakeHeaders();
  Future<HttpClientResponse>? _closed;

  _P2FakeRequest(this.uri, this.resolver);

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
  Future<void> addStream(Stream<List<int>> stream) async => stream.drain<void>();
  @override
  Future<HttpClientResponse> close() =>
      _closed ??= Future<HttpClientResponse>.value(_P2FakeResponse(resolver(uri)));
  @override
  Future<HttpClientResponse> get done => close();
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _P2FakeHttpClient implements HttpClient {
  final String Function(Uri uri) resolver;
  _P2FakeHttpClient(this.resolver);

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      _P2FakeRequest(url, resolver);
  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);
  @override
  void close({bool force = false}) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}
