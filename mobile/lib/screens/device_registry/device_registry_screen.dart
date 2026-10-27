import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';

class DeviceRegistryScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const DeviceRegistryScreen({super.key, required this.user});

  @override
  State<DeviceRegistryScreen> createState() => _DeviceRegistryScreenState();
}

class _DeviceRegistryScreenState extends State<DeviceRegistryScreen> {
  bool _isLoading = true;
  List<dynamic> _devices = [];
  Map<String, dynamic> _stats = {
    'total': 0,
    'active': 0,
    'inactive': 0,
    'provisioned': 0,
    'maintenance': 0,
  };

  String _searchQuery = '';
  String _selectedStatus = 'ALL';
  Timer? _pollingTimer;

  final TextEditingController _searchCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _fetchDevices(silent: false);
    // Background polling every 8s to update device heartbeat/telemetry status
    _pollingTimer = Timer.periodic(const Duration(seconds: 8), (_) {
      if (mounted) _fetchDevices(silent: true);
    });
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchDevices({bool silent = false}) async {
    if (!silent) setState(() => _isLoading = true);
    try {
      final token = await _getToken();
      final queryParams = <String, String>{};
      if (_searchQuery.trim().isNotEmpty) queryParams['search'] = _searchQuery.trim();
      if (_selectedStatus != 'ALL') queryParams['status'] = _selectedStatus;

      final uri = Uri.parse('$baseUrl/devices').replace(queryParameters: queryParams);
      final res = await http.get(uri, headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      });

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _devices = (data['devices'] as List?) ?? [];
            if (data['summary'] != null && data['summary'] is Map) {
              _stats = Map<String, dynamic>.from(data['summary']);
            } else {
              // Compute from list
              int active = 0, inactive = 0, prov = 0, maint = 0;
              for (final d in _devices) {
                final s = (d['status'] ?? '').toString().toUpperCase();
                if (s == 'ACTIVE') active++;
                else if (s == 'INACTIVE') inactive++;
                else if (s == 'PROVISIONED') prov++;
                else if (s == 'MAINTENANCE') maint++;
              }
              _stats = {
                'total': _devices.length,
                'active': active,
                'inactive': inactive,
                'provisioned': prov,
                'maintenance': maint,
              };
            }
          });
        }
      } else if (!silent && mounted) {
        AppFeedback.showError(context, 'Failed to load device registry (${res.statusCode})');
      }
    } catch (e) {
      if (!silent && mounted) {
        AppFeedback.showError(context, 'Error fetching devices: $e');
      }
    } finally {
      if (!silent && mounted) setState(() => _isLoading = false);
    }
  }

  // Health check ping over AWS IoT Core
  Future<void> _pingHealthCheck(int deviceId, String thingName) async {
    try {
      final token = await _getToken();
      if (mounted) {
        AppFeedback.showInfo(context, 'Publishing health check ping to $thingName...');
      }
      final res = await http.post(
        Uri.parse('$baseUrl/devices/$deviceId/health-check'),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json',
        },
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            'Ping command dispatched! (Topic: ${data['topic'] ?? 'AWS IoT Core'})',
          );
          _fetchDevices(silent: true);
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) {
          AppFeedback.showError(context, err['error'] ?? 'Health check request failed');
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error: $e');
    }
  }

  // Open Inspect Telemetry Modal
  void _openInspectSheet(Map<String, dynamic> device) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _DeviceInspectSheet(
        device: device,
        onHealthCheck: () => _pingHealthCheck(device['id'] as int, device['thingName'] ?? ''),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: RefreshIndicator(
        onRefresh: () => _fetchDevices(silent: false),
        child: CustomScrollView(
          slivers: [
            // Top Summary KPIs Bar
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Header title
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Icon(Icons.developer_board, color: AppColors.primary, size: 24),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'AWS IoT Device Registry',
                                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                              ),
                              Text(
                                'Real-time telemetry, master & slave barrier pairings',
                                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.refresh, color: AppColors.primary),
                          onPressed: () => _fetchDevices(silent: false),
                          tooltip: 'Refresh Devices',
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),

                    // Quick Stat Chips Row
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _buildStatCard('TOTAL THINGS', '${_stats['total'] ?? 0}', const Color(0xFF0B3C7A), Icons.devices),
                          const SizedBox(width: 8),
                          _buildStatCard('ONLINE / ACTIVE', '${_stats['active'] ?? 0}', const Color(0xFF16A34A), Icons.check_circle_outline),
                          const SizedBox(width: 8),
                          _buildStatCard('PROVISIONED', '${_stats['provisioned'] ?? 0}', const Color(0xFF0284C7), Icons.hourglass_top),
                          const SizedBox(width: 8),
                          _buildStatCard('MAINTENANCE', '${_stats['maintenance'] ?? 0}', const Color(0xFFEA580C), Icons.build_circle_outlined),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),

                    // Search input
                    TextField(
                      controller: _searchCtrl,
                      decoration: InputDecoration(
                        hintText: 'Search by Thing Name, Serial, or LC#...',
                        hintStyle: const TextStyle(fontSize: 13, color: Color(0xFF94A3B8)),
                        prefixIcon: const Icon(Icons.search, size: 20, color: Color(0xFF94A3B8)),
                        suffixIcon: _searchQuery.isNotEmpty
                            ? IconButton(
                                icon: const Icon(Icons.close, size: 18),
                                onPressed: () {
                                  _searchCtrl.clear();
                                  setState(() => _searchQuery = '');
                                  _fetchDevices();
                                },
                              )
                            : null,
                        filled: true,
                        fillColor: Colors.white,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
                        ),
                      ),
                      onChanged: (val) {
                        setState(() => _searchQuery = val);
                        _fetchDevices();
                      },
                    ),
                    const SizedBox(height: 10),

                    // Status Filter Pills
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          _buildFilterChip('ALL', 'All Statuses'),
                          _buildFilterChip('ACTIVE', 'Active'),
                          _buildFilterChip('INACTIVE', 'Inactive'),
                          _buildFilterChip('PROVISIONED', 'Provisioned'),
                          _buildFilterChip('MAINTENANCE', 'Maintenance'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // Devices List or Empty State
            if (_isLoading)
              const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_devices.isEmpty)
              SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.developer_board_off, size: 56, color: Colors.grey.shade400),
                      const SizedBox(height: 12),
                      const Text(
                        'No Registered IoT Devices Found',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _searchQuery.isNotEmpty
                            ? 'Try clearing your search query or status filter.'
                            : 'No devices have been provisioned in the AWS IoT registry yet.',
                        style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 24),
                sliver: SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (ctx, idx) => _buildDeviceCard(_devices[idx]),
                    childCount: _devices.length,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatCard(String label, String value, Color color, IconData icon) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.02),
            blurRadius: 4,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: color.withOpacity(0.1),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Icon(icon, color: color, size: 16),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
              Text(value, style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: color)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildFilterChip(String key, String label) {
    final isSelected = _selectedStatus == key;
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: ChoiceChip(
        label: Text(label),
        selected: isSelected,
        selectedColor: AppColors.primary,
        backgroundColor: Colors.white,
        labelStyle: TextStyle(
          fontSize: 12,
          fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
          color: isSelected ? Colors.white : const Color(0xFF475569),
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: isSelected ? AppColors.primary : const Color(0xFFE2E8F0)),
        ),
        onSelected: (selected) {
          setState(() => _selectedStatus = key);
          _fetchDevices();
        },
      ),
    );
  }

  Widget _buildDeviceCard(dynamic device) {
    final thingName = (device['thingName'] ?? 'Unnamed Thing').toString();
    final serial = (device['serialNumber'] ?? 'N/A').toString();
    final status = (device['status'] ?? 'ACTIVE').toString().toUpperCase();
    final deviceType = (device['deviceType'] ?? 'MASTER').toString().toUpperCase();
    final gate = device['gate'] as Map<String, dynamic>?;
    final gateLcNumber = gate?['lcNumber'] ?? 'Unassigned LC';
    final gateLocation = gate?['locationName'] ?? '';
    final fw = device['firmwareVersion'] ?? 'v1.0.0';

    final isClosed = (device['latestPayload']?['status'] ?? '').toString().toUpperCase() == 'CLOSED';
    final hasTelemetry = device['latestPayload'] != null;

    Color statusColor;
    switch (status) {
      case 'ACTIVE': statusColor = const Color(0xFF16A34A); break;
      case 'INACTIVE': statusColor = const Color(0xFFDC2626); break;
      case 'PROVISIONED': statusColor = const Color(0xFF0284C7); break;
      case 'MAINTENANCE': statusColor = const Color(0xFFEA580C); break;
      default: statusColor = const Color(0xFF64748B);
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE2E8F0)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top row: Thing Name & Status Pill
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              thingName,
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.primary.withOpacity(0.08),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              deviceType,
                              style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppColors.primary),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Serial: $serial • FW: $fw',
                        style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: statusColor.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: statusColor.withOpacity(0.3)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 5),
                      Text(
                        status,
                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: statusColor),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const Divider(height: 20, color: Color(0xFFF1F5F9)),

            // Gate Association Row
            Row(
              children: [
                const Icon(Icons.meeting_room_outlined, size: 16, color: Color(0xFF64748B)),
                const SizedBox(width: 6),
                Text(
                  gateLcNumber,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF1E293B)),
                ),
                if (gateLocation.isNotEmpty) ...[
                  Text(' • $gateLocation', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                ],
                const Spacer(),
                if (hasTelemetry) ...[
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: isClosed ? const Color(0xFFDCFCE7) : const Color(0xFFFEE2E2),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      isClosed ? 'CLOSED' : 'OPEN',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                        color: isClosed ? const Color(0xFF15803D) : const Color(0xFFB91C1C),
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 12),

            // Actions row: Inspect & Ping
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      side: const BorderSide(color: Color(0xFFCBD5E1)),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    onPressed: () => _openInspectSheet(Map<String, dynamic>.from(device)),
                    icon: const Icon(Icons.analytics_outlined, size: 16, color: AppColors.primary),
                    label: const Text('Inspect Telemetry', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  style: IconButton.styleFrom(
                    backgroundColor: const Color(0xFFF1F5F9),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                  tooltip: 'Ping Health Check',
                  onPressed: () => _pingHealthCheck(device['id'] as int, thingName),
                  icon: const Icon(Icons.network_ping, size: 18, color: Color(0xFF0F172A)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECT TELEMETRY BOTTOM SHEET
// ─────────────────────────────────────────────────────────────────────────────
class _DeviceInspectSheet extends StatefulWidget {
  final Map<String, dynamic> device;
  final VoidCallback onHealthCheck;

  const _DeviceInspectSheet({required this.device, required this.onHealthCheck});

  @override
  State<_DeviceInspectSheet> createState() => _DeviceInspectSheetState();
}

class _DeviceInspectSheetState extends State<_DeviceInspectSheet> {
  bool _isLoading = true;
  List<dynamic> _historicPayloads = [];
  bool _showRawJson = false;

  @override
  void initState() {
    super.initState();
    _loadTelemetry();
  }

  Future<void> _loadTelemetry() async {
    setState(() => _isLoading = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token') ?? '';
      final deviceId = widget.device['id'];

      final res = await http.get(
        Uri.parse('$baseUrl/devices/$deviceId/telemetry'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _historicPayloads = (data['payloads'] as List?) ?? [];
          });
        }
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final thingName = widget.device['thingName'] ?? 'Device';
    final serial = widget.device['serialNumber'] ?? 'N/A';
    final latestPayload = widget.device['latestPayload'] ?? (_historicPayloads.isNotEmpty ? _historicPayloads[0]['payload'] : null);

    return Container(
      height: MediaQuery.of(context).size.height * 0.85,
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
        children: [
          // Drag handle
          Container(
            width: 40,
            height: 4,
            margin: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(color: Colors.grey.shade300, borderRadius: BorderRadius.circular(2)),
          ),

          // Header
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        thingName,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      Text('Serial: $serial • AWS IoT Shadow', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                    ],
                  ),
                ),
                IconButton(
                  icon: Icon(_showRawJson ? Icons.table_chart : Icons.code, color: AppColors.primary),
                  tooltip: _showRawJson ? 'View Table' : 'View Raw JSON',
                  onPressed: () => setState(() => _showRawJson = !_showRawJson),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1),

          // Body
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Quick Ping Button
                        ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary,
                            minimumSize: const Size.fromHeight(42),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          onPressed: () {
                            widget.onHealthCheck();
                            Navigator.pop(context);
                          },
                          icon: const Icon(Icons.network_ping, size: 18, color: Colors.white),
                          label: const Text('Trigger Health Check Ping', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
                        ),
                        const SizedBox(height: 16),

                        const Text('LATEST TELEMETRY PAYLOAD', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                        const SizedBox(height: 8),

                        if (latestPayload == null || (latestPayload is Map && latestPayload.isEmpty))
                          Container(
                            padding: const EdgeInsets.all(16),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFE2E8F0)),
                            ),
                            child: const Center(
                              child: Text('No telemetry reports received for this device yet.', style: TextStyle(color: Color(0xFF64748B), fontSize: 13)),
                            ),
                          )
                        else if (_showRawJson)
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFF0F172A),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: SelectableText(
                              const JsonEncoder.withIndent('  ').convert(latestPayload),
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Color(0xFF38BDF8)),
                            ),
                          )
                        else
                          _buildTelemetryTable(latestPayload),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildTelemetryTable(dynamic payload) {
    if (payload is! Map) return Text('$payload');
    final entries = payload.entries.toList();

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: entries.length,
        separatorBuilder: (_, _) => const Divider(height: 1, color: Color(0xFFF1F5F9)),
        itemBuilder: (ctx, idx) {
          final k = entries[idx].key.toString();
          final v = entries[idx].value;
          final strVal = v.toString();
          final isStatus = k.toLowerCase() == 'status';

          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  flex: 2,
                  child: Text(
                    k,
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155)),
                  ),
                ),
                Expanded(
                  flex: 3,
                  child: isStatus
                      ? Align(
                          alignment: Alignment.centerLeft,
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(
                              color: strVal.toUpperCase() == 'CLOSED' ? const Color(0xFFDCFCE7) : const Color(0xFFFEE2E2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              strVal,
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                color: strVal.toUpperCase() == 'CLOSED' ? const Color(0xFF15803D) : const Color(0xFFB91C1C),
                              ),
                            ),
                          ),
                        )
                      : Text(
                          strVal,
                          style: const TextStyle(fontSize: 12, color: Color(0xFF0F172A)),
                        ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
