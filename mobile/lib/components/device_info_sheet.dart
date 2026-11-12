import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

/// Reusable Device Info & Hardware Manifest Bottom Sheet
/// Mirrors Web's DeviceInfoModal.tsx (strictly reports live device telemetry/manifest)
class DeviceInfoSheet extends StatefulWidget {
  final Map<String, dynamic>? gate;
  final Map<String, dynamic>? master;
  final Map<String, dynamic>? device;

  const DeviceInfoSheet({
    super.key,
    this.gate,
    this.master,
    this.device,
  });

  static void show(
    BuildContext context, {
    Map<String, dynamic>? gate,
    Map<String, dynamic>? master,
    Map<String, dynamic>? device,
  }) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => DeviceInfoSheet(
        gate: gate,
        master: master,
        device: device,
      ),
    );
  }

  @override
  State<DeviceInfoSheet> createState() => _DeviceInfoSheetState();
}

class DeviceInfoTarget {
  final int? deviceId;
  final String thingName;
  final String deviceType;
  final String connectivityStatus;
  final bool isVirtualUnlinked;
  final bool canQueryTelemetry;

  const DeviceInfoTarget({
    this.deviceId,
    required this.thingName,
    required this.deviceType,
    required this.connectivityStatus,
    required this.isVirtualUnlinked,
    required this.canQueryTelemetry,
  });
}

bool isValidHardwareThingName(String? raw) {
  if (raw == null) return false;
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return false;
  if (trimmed.toLowerCase().contains('virtual')) return false;
  return trimmed.toUpperCase().startsWith('LC-');
}

Map<String, dynamic>? _findHardwareRegistryInList(dynamic list) {
  if (list is! List) return null;
  for (final item in list) {
    if (item is Map) {
      final map = Map<String, dynamic>.from(item);
      final tn = map['thingName']?.toString().trim();
      if (tn != null && tn.isNotEmpty && !tn.toLowerCase().contains('virtual')) {
        return map;
      }
    }
  }
  return null;
}

Map<String, dynamic>? _findHardwareRegistryInMaster(Map<dynamic, dynamic> master) {
  final fromList = _findHardwareRegistryInList(master['deviceRegistries']);
  if (fromList != null) return fromList;
  final singular = master['deviceRegistry'];
  if (singular is Map) {
    final map = Map<String, dynamic>.from(singular);
    final tn = map['thingName']?.toString().trim();
    if (tn != null && tn.isNotEmpty && !tn.toLowerCase().contains('virtual')) {
      return map;
    }
  }
  return null;
}

DeviceInfoTarget resolveDeviceInfoTarget({
  Map<String, dynamic>? device,
  Map<String, dynamic>? master,
  Map<String, dynamic>? gate,
}) {
  // 1. Genuine DeviceRegistry record passed explicitly
  if (device != null) {
    final tn = device['thingName']?.toString().trim();
    if (tn != null && tn.isNotEmpty && !tn.toLowerCase().contains('virtual')) {
      final parsedId = device['id'] is int ? device['id'] as int : int.tryParse('${device['id']}');
      return DeviceInfoTarget(
        deviceId: parsedId,
        thingName: tn,
        deviceType: (device['deviceType'] ?? 'GATE').toString().toUpperCase(),
        connectivityStatus: (device['connectivityStatus'] ?? device['computedStatus'] ?? 'OFFLINE').toString().toUpperCase(),
        isVirtualUnlinked: false,
        canQueryTelemetry: true,
      );
    }
  }

  // 2. Linked DeviceRegistry under MasterUnit (`deviceRegistries` or singular `deviceRegistry`)
  Map<String, dynamic>? linkedRegistry;
  if (master != null) {
    linkedRegistry = _findHardwareRegistryInMaster(master);
  } else if (gate != null) {
    final masters = gate['masters'];
    if (masters is List) {
      for (final m in masters) {
        if (m is Map) {
          linkedRegistry = _findHardwareRegistryInMaster(m);
          if (linkedRegistry != null) break;
        }
      }
    }
    linkedRegistry ??= _findHardwareRegistryInList(gate['deviceRegistries']);
  }

  if (linkedRegistry != null) {
    final parsedId = linkedRegistry['id'] is int
        ? linkedRegistry['id'] as int
        : int.tryParse('${linkedRegistry['id']}');
    return DeviceInfoTarget(
      deviceId: parsedId,
      thingName: linkedRegistry['thingName'].toString().trim(),
      deviceType: (linkedRegistry['deviceType'] ?? (master != null ? 'MASTER' : 'GATE')).toString().toUpperCase(),
      connectivityStatus: (linkedRegistry['connectivityStatus'] ?? linkedRegistry['computedStatus'] ?? 'OFFLINE').toString().toUpperCase(),
      isVirtualUnlinked: false,
      canQueryTelemetry: true,
    );
  }

  // 3. Unlinked / fallback path: NEVER use MasterUnit.id or LCGate.id as _deviceId!
  Map<String, dynamic>? fallback = device ?? master;
  if (fallback == null && gate != null && gate['masters'] is List && (gate['masters'] as List).isNotEmpty) {
    final firstMaster = (gate['masters'] as List).first;
    if (firstMaster is Map) {
      fallback = Map<String, dynamic>.from(firstMaster);
    }
  }

  final rawCandidate = fallback != null
      ? (fallback['awsThingName'] ?? fallback['thingName'] ?? fallback['serialNumber'])?.toString().trim()
      : null;

  if (isValidHardwareThingName(rawCandidate)) {
    return DeviceInfoTarget(
      deviceId: null,
      thingName: rawCandidate!,
      deviceType: (fallback?['deviceType'] ?? (master != null || (gate != null && fallback != null) ? 'MASTER' : 'GATE')).toString().toUpperCase(),
      connectivityStatus: (fallback?['connectivityStatus'] ?? fallback?['computedStatus'] ?? 'OFFLINE').toString().toUpperCase(),
      isVirtualUnlinked: false,
      canQueryTelemetry: true,
    );
  }

  final displayLabel = (rawCandidate != null && rawCandidate.isNotEmpty)
      ? rawCandidate
      : 'Virtual / Unlinked Master';

  return DeviceInfoTarget(
    deviceId: null,
    thingName: displayLabel,
    deviceType: (fallback?['deviceType'] ?? (master != null ? 'MASTER' : 'GATE')).toString().toUpperCase(),
    connectivityStatus: 'VIRTUAL / UNLINKED',
    isVirtualUnlinked: true,
    canQueryTelemetry: false,
  );
}

class _DeviceInfoSheetState extends State<DeviceInfoSheet> {
  bool _isLoading = true;
  Map<String, dynamic>? _manifestPayload;
  String _thingName = 'Virtual / Unlinked Master';
  String _deviceType = 'GATE / CLUSTER';
  String _connectivityStatus = 'OFFLINE';
  int? _deviceId;
  bool _isVirtualUnlinked = false;
  bool _canQueryTelemetry = false;
  bool _showRawJson = false;
  bool _isPinging = false;

  @override
  void initState() {
    super.initState();
    _extractTargetInfo();
    _fetchTelemetry();
  }

  void _extractTargetInfo() {
    final resolved = resolveDeviceInfoTarget(
      device: widget.device,
      master: widget.master,
      gate: widget.gate,
    );
    _deviceId = resolved.deviceId;
    _thingName = resolved.thingName;
    _deviceType = resolved.deviceType;
    _connectivityStatus = resolved.connectivityStatus;
    _isVirtualUnlinked = resolved.isVirtualUnlinked;
    _canQueryTelemetry = resolved.canQueryTelemetry;
  }

  Future<void> _fetchTelemetry() async {
    if (!_canQueryTelemetry) {
      // Virtual / unlinked masters never hit `/devices/:id/telemetry` (avoids MasterUnit.id collision).
      Map<String, dynamic>? meta;
      if (widget.device != null && widget.device!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.device!['metadata'] as Map);
      } else if (widget.master != null && widget.master!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.master!['metadata'] as Map);
      } else if (widget.gate != null && widget.gate!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.gate!['metadata'] as Map);
      }
      if (mounted) {
        setState(() {
          if (meta != null && meta.isNotEmpty) {
            _manifestPayload = meta;
          }
          _isLoading = false;
        });
      }
      return;
    }

    setState(() => _isLoading = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token') ?? '';

      // Try fetching from telemetry API endpoint using linked DeviceRegistry ID or valid ThingName
      final queryId = _deviceId?.toString() ?? Uri.encodeComponent(_thingName);
      final res = await http.get(
        Uri.parse('$baseUrl/devices/$queryId/telemetry'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map) {
          final liveConn = (data['connectivityStatus'] ?? data['computedStatus'] ?? '').toString().trim().toUpperCase();
          if (liveConn.isNotEmpty && mounted) {
            setState(() => _connectivityStatus = liveConn);
          }
          if (data['latestManifest']?['payload'] != null) {
            final p = data['latestManifest']['payload'];
            if (p is Map && mounted) {
              setState(() {
                _manifestPayload = Map<String, dynamic>.from(p);
                _isLoading = false;
              });
              return;
            }
          }
          if (data['latestTelemetry']?['payload'] != null) {
            final p = data['latestTelemetry']['payload'];
            if (p is Map && mounted) {
              setState(() {
                _manifestPayload = Map<String, dynamic>.from(p);
                _isLoading = false;
              });
              return;
            }
          }
          if (data['historicTelemetry'] is List && (data['historicTelemetry'] as List).isNotEmpty) {
            final first = (data['historicTelemetry'] as List).first;
            if (first is Map && first['payload'] is Map && mounted) {
              setState(() {
                _manifestPayload = Map<String, dynamic>.from(first['payload'] as Map);
                _isLoading = false;
              });
              return;
            }
          }
        }
      }

      // Priority 2: In-memory metadata fallback
      Map<String, dynamic>? meta;
      if (widget.device != null && widget.device!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.device!['metadata'] as Map);
      } else if (widget.master != null && widget.master!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.master!['metadata'] as Map);
      } else if (widget.gate != null && widget.gate!['metadata'] is Map) {
        meta = Map<String, dynamic>.from(widget.gate!['metadata'] as Map);
      }

      if (meta != null && meta.isNotEmpty && mounted) {
        setState(() {
          _manifestPayload = meta;
          _isLoading = false;
        });
        return;
      }
    } catch (_) {}

    if (mounted) {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _pingHealthCheck() async {
    if (!_canQueryTelemetry || _isVirtualUnlinked) {
      AppFeedback.showError(context, 'No AWS IoT Thing is linked to "$_thingName". Assign hardware first.');
      return;
    }
    setState(() => _isPinging = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token') ?? '';
      final pingTarget = _deviceId?.toString() ?? Uri.encodeComponent(_thingName);
      final res = await http.post(
        Uri.parse('$baseUrl/devices/$pingTarget/health-check'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          final isDelivered = data['mqttDelivered'] == true;
          if (isDelivered) {
            AppFeedback.showSuccess(context, 'Health check ping sent to $_thingName via AWS IoT MQTT.');
          } else {
            AppFeedback.showError(
              context,
              data['message']?.toString() ?? 'Could not reach AWS IoT Core broker for $_thingName.',
            );
          }
          _fetchTelemetry();
        }
      } else {
        if (mounted) AppFeedback.showError(context, 'Health check failed (HTTP ${res.statusCode})');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Connection error: $e');
    } finally {
      if (mounted) setState(() => _isPinging = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: MediaQuery.of(context).size.height * 0.85,
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
        children: [
          // Drag Notch
          const SizedBox(height: 10),
          Center(
            child: Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: const Color(0xFFCBD5E1),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 12),

          // Header Row
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.developer_board, size: 22, color: AppColors.primary),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              _thingName,
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF0F172A)),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF1F5F9),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              _deviceType,
                              style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: _isVirtualUnlinked
                                  ? const Color(0xFFFEF3C7)
                                  : (_connectivityStatus == 'ONLINE' ? const Color(0xFFDCFCE7) : const Color(0xFFF1F5F9)),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              _connectivityStatus,
                              style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                                color: _isVirtualUnlinked
                                    ? const Color(0xFFB45309)
                                    : (_connectivityStatus == 'ONLINE' ? const Color(0xFF15803D) : const Color(0xFF475569)),
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      const Text(
                        'AWS IoT Core & Hardware Telemetry Manifest',
                        style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: Color(0xFFE2E8F0)),

          // Secondary Bar: View mode toggle & Copy
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Container(
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F5F9),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      InkWell(
                        onTap: () => setState(() => _showRawJson = false),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: !_showRawJson ? AppColors.primary : Colors.transparent,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            'Formatted',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                              color: !_showRawJson ? Colors.white : const Color(0xFF475569),
                            ),
                          ),
                        ),
                      ),
                      InkWell(
                        onTap: () => setState(() => _showRawJson = true),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: _showRawJson ? AppColors.primary : Colors.transparent,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            'Raw JSON',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                              color: _showRawJson ? Colors.white : const Color(0xFF475569),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const Spacer(),
                if (_manifestPayload != null)
                  TextButton.icon(
                    style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: json.encode(_manifestPayload)));
                      AppFeedback.showSuccess(context, 'Telemetry JSON copied to clipboard!');
                    },
                    icon: const Icon(Icons.copy, size: 14),
                    label: const Text('Copy JSON', style: TextStyle(fontSize: 11)),
                  ),
                if (_canQueryTelemetry)
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: _isPinging
                        ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.network_ping, size: 18, color: Color(0xFF2563EB)),
                    tooltip: 'Check Connection',
                    onPressed: _isPinging ? null : _pingHealthCheck,
                  ),
              ],
            ),
          ),
          const Divider(height: 1, color: Color(0xFFE2E8F0)),

          // Body Content
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : _manifestPayload == null || _manifestPayload!.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _isVirtualUnlinked
                                    ? Icons.developer_board_off
                                    : Icons.signal_cellular_connected_no_internet_4_bar,
                                size: 40,
                                color: const Color(0xFF94A3B8),
                              ),
                              const SizedBox(height: 10),
                              Text(
                                _isVirtualUnlinked
                                    ? 'Virtual / Unlinked Master'
                                    : 'No Device Updates Yet for $_thingName',
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 4),
                              Text(
                                _isVirtualUnlinked
                                    ? 'No AWS IoT hardware device is linked to $_thingName. Assign a hardware device from Gate Details to view live telemetry.'
                                    : 'Hardware details and status will appear automatically once the device connects and sends an update.',
                                style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                                textAlign: TextAlign.center,
                              ),
                              if (_canQueryTelemetry) ...[
                                const SizedBox(height: 16),
                                ElevatedButton.icon(
                                  onPressed: _pingHealthCheck,
                                  icon: const Icon(Icons.refresh, size: 16),
                                  label: const Text('Check Connection Now'),
                                ),
                              ],
                            ],
                          ),
                        ),
                      )
                    : _showRawJson
                        ? Container(
                            margin: const EdgeInsets.all(12),
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFF0F172A),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: SingleChildScrollView(
                              child: Text(
                                const JsonEncoder.withIndent('  ').convert(_manifestPayload),
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 11,
                                  color: Color(0xFF38BDF8),
                                ),
                              ),
                            ),
                          )
                        : ListView(
                            padding: const EdgeInsets.all(14),
                            children: [
                              ..._manifestPayload!.entries.map((entry) {
                                return _buildFormattedEntry(entry.key, entry.value, depth: 0);
                              }),
                            ],
                          ),
          ),
        ],
      ),
    );
  }

  dynamic _tryParseJson(dynamic val) {
    if (val is String) {
      final s = val.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          return json.decode(s);
        } catch (_) {}
      }
    }
    return val;
  }

  String _formatKey(String key) {
    if (key == 'S.No.' || key == 'sNo') return 'Serial Number';
    if (key == 'Mfg' || key == 'mfg') return 'Manufacturing Date';
    if (key == 'Desc' || key == 'desc') return 'Description';
    if (key == 'version') return 'Firmware Version';
    if (key == 'Device_Name') return 'Device Name';
    if (key == 'SensorName') return 'Connected Sensors';
    if (key == 'topicThingName') return 'Thing Topic ID';
    if (key == 'thing') return 'Hardware Manifest';
    return key.replaceAll('_', ' ');
  }

  Widget _buildFormattedEntry(String key, dynamic rawVal, {int depth = 0}) {
    final val = _tryParseJson(rawVal);

    if (val is Map) {
      final mapVal = Map<String, dynamic>.from(val);
      return Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: depth == 0 ? Colors.white : const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: depth == 0 ? const Color(0xFFF1F5F9) : const Color(0xFFE2E8F0),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(7)),
              ),
              child: Row(
                children: [
                  Icon(
                    depth == 0 ? Icons.developer_board : Icons.subdirectory_arrow_right,
                    size: 13,
                    color: AppColors.primary,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _formatKey(key),
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                children: mapVal.entries
                    .map((e) => _buildFormattedEntry(e.key, e.value, depth: depth + 1))
                    .toList(),
              ),
            ),
          ],
        ),
      );
    } else if (val is List) {
      final isPrimitiveList = val.every((item) => item is! Map && item is! List);
      if (isPrimitiveList) {
        return Container(
          margin: const EdgeInsets.only(bottom: 5),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: const Color(0xFFF8FAFC),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 2,
                child: Text(
                  _formatKey(key),
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF334155),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 3,
                child: Wrap(
                  spacing: 4,
                  runSpacing: 4,
                  children: val.map((item) {
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(4),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: Text(
                        item.toString(),
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF1D4ED8)),
                      ),
                    );
                  }).toList(),
                ),
              ),
            ],
          ),
        );
      } else {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: val.asMap().entries.map((e) => _buildFormattedEntry('[${e.key}]', e.value, depth: depth + 1)).toList(),
        );
      }
    } else {
      return Container(
        margin: const EdgeInsets.only(bottom: 5),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 2,
              child: Text(
                _formatKey(key),
                style: const TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF334155),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              flex: 3,
              child: Text(
                (val?.toString().toUpperCase() == 'NOT_CLOSED' ? 'OPEN' : val?.toString()) ?? '—',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF0F172A),
                ),
              ),
            ),
          ],
        ),
      );
    }
  }

}
