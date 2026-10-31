import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// Test simulation of the exact gate structure returned for Gate 17 with events
void main() {
  group('LC Gates Screen - Gate Card Type Safety Verification', () {
    test('Simulated gate status calculation with dynamic nested event maps', () {
      // Simulating a gate map as deserialized from JSON / cache with Map<dynamic, dynamic>
      final dynamic rawGate = <dynamic, dynamic>{
        'id': 17,
        'lcNumber': 'LC-M-001',
        'name': 'panvel gate',
        'locationName': 'Panvel West',
        'zone': 'CR',
        'division': 'Mumbai',
        'masters': [
          <dynamic, dynamic>{
            'id': 10,
            'thingName': 'LC-M-001',
            'powerSource': 'DIRECT',
            'childDevices': []
          }
        ],
        'events': [
          <dynamic, dynamic>{
            'id': 1,
            'status': 'OPEN',
            'closedAt': null,
            'openedAt': '2026-10-31T10:00:00Z',
          },
          <dynamic, dynamic>{
            'id': 2,
            'status': 'CLOSED',
            'closedAt': '2026-10-31T09:30:00Z',
            'openedAt': '2026-10-31T09:00:00Z',
          }
        ],
        'scopeGroups': [
          {
            'scopeGroupId': 1,
            'scopeGroup': {'id': 1, 'name': 'Central Railways'}
          }
        ]
      };

      // Ensure spreading dynamic preserves Map<String, dynamic>
      final updatedGate = <String, dynamic>{
        ...Map<String, dynamic>.from(rawGate as Map),
        'isOnline': true,
        'deviceStatus': 'ONLINE',
      };

      // Verify safe event extraction
      final events = updatedGate['events'] as List?;
      expect(events, isNotNull);
      expect(events!.length, equals(2));

      final firstEv = events.first;
      expect(firstEv is Map, isTrue);

      final ev = Map<String, dynamic>.from(firstEv as Map);
      final st = (ev['status'] ?? '').toString().toUpperCase();
      expect(st, equals('OPEN'));
      expect(ev['closedAt'], isNull);

      // Verify status computation
      String computedStatus = 'CLOSED';
      if (st == 'OPEN' || ev['closedAt'] == null) {
        computedStatus = 'OPEN';
      }
      expect(computedStatus, equals('OPEN'));
    });
  });
}
