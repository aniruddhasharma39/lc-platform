import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/components/device_info_sheet.dart';
import 'package:mobile/screens/device_registry/device_registry_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeHttpResponse extends Stream<List<int>> implements HttpClientResponse {
  final int _statusCode;
  final List<int> _bodyBytes;

  _FakeHttpResponse(this._statusCode, String body) : _bodyBytes = utf8.encode(body);

  @override
  int get statusCode => _statusCode;

  @override
  int get contentLength => _bodyBytes.length;

  @override
  HttpClientResponseCompressionState get compressionState => HttpClientResponseCompressionState.notCompressed;

  @override
  bool get persistentConnection => false;

  @override
  bool get isRedirect => false;

  @override
  List<RedirectInfo> get redirects => const [];

  @override
  String get reasonPhrase => _statusCode == 200 ? 'OK' : 'Error';

  @override
  X509Certificate? get certificate => null;

  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  List<Cookie> get cookies => const [];

  @override
  Future<Socket> detachSocket() => throw UnsupportedError('detachSocket');

  @override
  HttpHeaders get headers => _FakeHttpHeaders();

  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) async => this;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.fromIterable([_bodyBytes]).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}

class _FakeHttpHeaders implements HttpHeaders {
  @override
  dynamic noSuchMethod(Invocation invocation) => null;

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  ContentType? contentType = ContentType.json;

  @override
  void forEach(void Function(String name, List<String> values) action) {}
}

class _FakeHttpRequest implements HttpClientRequest {
  final Uri _uri;
  final String Function(Uri uri) _responder;

  _FakeHttpRequest(this._uri, this._responder);

  @override
  final HttpHeaders headers = _FakeHttpHeaders();

  @override
  Encoding encoding = utf8;

  @override
  int contentLength = 0;

  @override
  bool bufferOutput = true;

  @override
  bool followRedirects = true;

  @override
  int maxRedirects = 5;

  @override
  bool persistentConnection = false;

  @override
  Future<HttpClientResponse> close() async => _FakeHttpResponse(200, _responder(_uri));

  @override
  Future<HttpClientResponse> get done => close();

  @override
  void add(List<int> data) {}

  @override
  Future<void> addStream(Stream<List<int>> stream) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _MockHttpOverrides extends HttpOverrides {
  final String Function(Uri uri) responder;

  _MockHttpOverrides(this.responder);

  @override
  HttpClient createHttpClient(SecurityContext? context) => _FakeHttpClient(responder);
}

class _FakeHttpClient implements HttpClient {
  final String Function(Uri uri) responder;

  _FakeHttpClient(this.responder);

  @override
  bool autoUncompress = true;

  @override
  Duration? connectionTimeout;

  @override
  Duration idleTimeout = const Duration(seconds: 15);

  @override
  int? maxConnectionsPerHost;

  @override
  String? userAgent;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async => _FakeHttpRequest(url, responder);

  @override
  Future<HttpClientRequest> getUrl(Uri url) async => _FakeHttpRequest(url, responder);

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

void main() {
  test('Packet classification separates HEARTBEAT from barrier TELEMETRY', () {
    expect(
      classifyMobilePacketType({
        'topic': 'lc-gate/LC-M-001/telemetry',
        'status': 'ONLINE',
        'payload': {'Status': 'ONLINE', 'thingName': 'LC-M-001', 'firmwareVersion': '1.0.8'},
      }),
      equals('HEARTBEAT'),
    );

    expect(
      classifyMobilePacketType({
        'topic': 'lc-gate/LC-47E/telemetry',
        'status': 'OPEN',
        'payload': {'Status': 'NOT_CLOSED', 'LimitSwitchClosed': false},
      }),
      equals('TELEMETRY'),
    );
  });

  test('ONLINE status badge never renders in red error styling', () {
    final onlineBadge = statusValueBadgeColors('ONLINE');
    expect(onlineBadge.label, equals('ONLINE'));
    expect(onlineBadge.bg, equals(const Color(0xFFD1FAE5)));
    expect(onlineBadge.fg, equals(const Color(0xFF047857)));

    final openBadge = statusValueBadgeColors('NOT_CLOSED');
    expect(openBadge.label, equals('OPEN'));
    expect(openBadge.fg, equals(const Color(0xFFB91C1C)));

    expect(formatDeviceTimestamp(null), equals('Never connected'));
  });

  testWidgets('DeviceInfoSheet shows connectivityStatus OFFLINE instead of green ACTIVE', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({'token': 'test'});

    await HttpOverrides.runZoned(() async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: DeviceInfoSheet(
              device: {
                'thingName': 'LC-47',
                'deviceType': 'LC_GATE_MASTER',
                'status': 'ACTIVE',
                'connectivityStatus': 'OFFLINE',
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('OFFLINE'), findsOneWidget);
      expect(find.text('ACTIVE'), findsNothing);
    }, createHttpClient: null);
  });

  testWidgets('DeviceRegistryScreen uses DB connectivity summary and filters Online/Offline cleanly', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({'token': 'test-token'});

    final mockDevices = List.generate(
      9,
      (i) => {
        'id': 900 + i,
        'thingName': i == 0 ? 'LC-M-001' : 'LC-4$i',
        'serialNumber': i == 0 ? 'LC-M-001' : 'LC-4$i',
        'deviceType': 'LC_GATE_MASTER',
        'status': 'ACTIVE',
        'connectivityStatus': 'OFFLINE',
        'computedStatus': 'OFFLINE',
        'isOnline': false,
        'firmwareVersion': '1.0.8',
        'lastSeenAt': '2026-11-04T02:46:13.449Z',
      },
    );

    final overrides = _MockHttpOverrides((uri) {
      if (uri.path.endsWith('/devices')) {
        return json.encode({
          'devices': mockDevices,
          'summary': {
            'total': 9,
            'online': 0,
            'offline': 9,
            'active': 9,
            'inactive': 0,
            'provisioned': 0,
            'maintenance': 0,
          },
          'pagination': {'page': 1, 'limit': 50, 'total': 9, 'totalPages': 1},
        });
      }
      return '{}';
    });

    await HttpOverrides.runWithHttpOverrides(() async {
      await tester.pumpWidget(
        const MaterialApp(
          home: DeviceRegistryScreen(user: {'name': 'Tester', 'role': 'Developer'}),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('ONLINE'), findsOneWidget);
      expect(find.text('ONLINE / ACTIVE'), findsNothing);
      expect(find.text('0'), findsAtLeastNWidgets(2)); // online=0, provisioned=0
      expect(find.text('9'), findsAtLeastNWidgets(2)); // total=9, offline=9
      expect(find.text('Online'), findsOneWidget);
      expect(find.text('Offline'), findsAtLeastNWidgets(1));
    }, overrides);
  });

  testWidgets('DeviceInspectSheet shows DB OFFLINE state and separates HEARTBEAT packets from barrier Telemetry', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({'token': 'test-token'});

    final overrides = _MockHttpOverrides((uri) {
      if (uri.path.endsWith('/telemetry')) {
        return json.encode({
          'thingName': 'LC-M-001',
          'serialNumber': 'LC-M-001',
          'connectivityStatus': 'OFFLINE',
          'computedStatus': 'OFFLINE',
          'isOnline': false,
          'barrierState': 'OPEN',
          'currentStatus': 'OPEN',
          'lastSeenAt': '2026-11-04T02:46:13.449Z',
          'latestTelemetry': {
            'id': 1157,
            'thingName': 'LC-M-001',
            'topic': 'lc-gate/LC-M-001/telemetry',
            'status': 'OPEN',
            'packetType': 'TELEMETRY',
            'receivedAt': '2026-10-28T12:26:31.372Z',
            'payload': {'Status': 'OPEN', 'LimitSwitchClosed': false},
          },
          'payloads': [
            {
              'id': 2166,
              'thingName': 'LC-M-001',
              'topic': 'lc-gate/LC-M-001/telemetry',
              'status': 'ONLINE',
              'packetType': 'HEARTBEAT',
              'receivedAt': '2026-11-02T11:00:09.706Z',
              'payload': {'Status': 'ONLINE', 'thingName': 'LC-M-001', 'firmwareVersion': '1.0.8'},
            },
            {
              'id': 1157,
              'thingName': 'LC-M-001',
              'topic': 'lc-gate/LC-M-001/telemetry',
              'status': 'OPEN',
              'packetType': 'TELEMETRY',
              'receivedAt': '2026-10-28T12:26:31.372Z',
              'payload': {'Status': 'OPEN', 'LimitSwitchClosed': false},
            },
          ],
        });
      }
      return '{}';
    });

    await HttpOverrides.runWithHttpOverrides(() async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DeviceInspectSheet(
              device: const {
                'id': 907,
                'thingName': 'LC-M-001',
                'serialNumber': 'LC-M-001',
                'connectivityStatus': 'OFFLINE',
                'barrierState': 'OPEN',
                'lastSeenAt': '2026-11-04T02:46:13.449Z',
              },
              onHealthCheck: () {},
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('OFFLINE'), findsOneWidget);
      expect(find.text('BARRIER: OPEN'), findsOneWidget);
      expect(find.textContaining('Last MQTT packet seen:'), findsOneWidget);
      expect(find.text('Telemetry (1)'), findsOneWidget);
      expect(find.text('All Records (2)'), findsOneWidget);
      expect(find.textContaining('Received:'), findsOneWidget);
      // On Telemetry tab, legacy 1.0.8 heartbeat-only packet must not replace genuine OPEN telemetry
      expect(find.text('1.0.8'), findsNothing);

      // Switching to All Records reveals timestamped HEARTBEAT history
      await tester.tap(find.text('All Records (2)'));
      await tester.pumpAndSettle();
      expect(find.text('HEARTBEAT'), findsAtLeastNWidgets(1));
      expect(find.text('1.0.8'), findsOneWidget);
    }, overrides);
  });
}
