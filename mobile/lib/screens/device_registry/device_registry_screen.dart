import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../utils/file_download_helper.dart';

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
            final rawList = (data['devices'] as List?) ?? [];
            _devices = rawList.where((d) => (d['thingName'] ?? '').toString().toUpperCase().startsWith('LC-')).toList();
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

  // Open SIM Management Modal
  void _openSimManagementSheet(Map<String, dynamic> device) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _DeviceSimManagementSheet(
        device: device,
        onSaved: () => _fetchDevices(silent: false),
      ),
    );
  }

  // Open Quick Recharge Dialog
  void _openQuickRechargeDialog(Map<String, dynamic> device) {
    int? selectedPreset = 28;
    DateTime? selectedExpiry = DateTime.now().add(const Duration(days: 28));
    DateTime selectedRechargeDate = DateTime.now();
    bool isSubmitting = false;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) {
          final thingName = (device['thingName'] ?? 'Device').toString();
          final provider = (device['simProvider'] ?? 'SIM').toString();
          final phone = (device['simNumber'] ?? '').toString();

          Widget buildDialogPresetChip(int days, String label) {
            final isSelected = selectedPreset == days;
            return InkWell(
              borderRadius: BorderRadius.circular(20),
              onTap: () {
                setDialogState(() {
                  selectedPreset = days;
                  selectedExpiry = DateTime.now().add(Duration(days: days));
                });
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 180),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(
                  color: isSelected ? AppColors.primary : Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: isSelected ? AppColors.primary : const Color(0xFFCBD5E1),
                    width: isSelected ? 1.8 : 1.0,
                  ),
                  boxShadow: isSelected
                      ? [
                          BoxShadow(
                            color: AppColors.primary.withOpacity(0.3),
                            blurRadius: 6,
                            offset: const Offset(0, 2),
                          )
                        ]
                      : null,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      isSelected ? Icons.check_circle : Icons.add_circle_outline,
                      size: 14,
                      color: isSelected ? Colors.white : const Color(0xFF64748B),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      label,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                        color: isSelected ? Colors.white : const Color(0xFF334155),
                      ),
                    ),
                  ],
                ),
              ),
            );
          }

          return AlertDialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            title: const Row(
              children: [
                Icon(Icons.bolt, color: Colors.amber, size: 22),
                SizedBox(width: 8),
                Text('Log SIM Recharge', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '$thingName • $provider ${phone.isNotEmpty ? "($phone)" : ""}',
                  style: const TextStyle(fontSize: 13, color: Color(0xFF64748B)),
                ),
                const SizedBox(height: 16),
                const Text('Quick Extend Validity:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    buildDialogPresetChip(28, '+28 Days'),
                    buildDialogPresetChip(84, '+84 Days'),
                    buildDialogPresetChip(365, '+365 Days'),
                  ],
                ),
                const SizedBox(height: 16),
                InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () async {
                    final picked = await showDatePicker(
                      context: context,
                      initialDate: selectedExpiry ?? DateTime.now().add(const Duration(days: 28)),
                      firstDate: DateTime.now().subtract(const Duration(days: 30)),
                      lastDate: DateTime.now().add(const Duration(days: 1000)),
                    );
                    if (picked != null) {
                      final diff = picked.difference(DateTime.now()).inDays;
                      setDialogState(() {
                        selectedExpiry = picked;
                        if (diff == 28 || diff == 84 || diff == 365) {
                          selectedPreset = diff;
                        } else {
                          selectedPreset = null;
                        }
                      });
                    }
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF8FAFC),
                      border: Border.all(color: const Color(0xFFCBD5E1)),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          selectedExpiry != null
                              ? 'New Expiry: ${selectedExpiry!.day}/${selectedExpiry!.month}/${selectedExpiry!.year}'
                              : 'Select Expiry Date',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                        ),
                        const Icon(Icons.calendar_today, size: 18, color: AppColors.primary),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            actions: [
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: Color(0xFFCBD5E1)),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Cancel', style: TextStyle(color: Color(0xFF475569))),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  disabledBackgroundColor: AppColors.primary,
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: isSubmitting || selectedExpiry == null
                    ? null
                    : () async {
                        setDialogState(() => isSubmitting = true);
                        try {
                          final token = await _getToken();
                          final res = await http.post(
                            Uri.parse('$baseUrl/devices/${device['id']}/recharge'),
                            headers: {
                              'Authorization': 'Bearer $token',
                              'Content-Type': 'application/json',
                            },
                            body: json.encode({
                              'lastRechargeDate': selectedRechargeDate.toIso8601String(),
                              'validityExpiryDate': selectedExpiry!.toIso8601String(),
                            }),
                          );
                          if (res.statusCode == 200) {
                            if (mounted) {
                              AppFeedback.showSuccess(context, 'Recharge logged and validity extended!');
                              _fetchDevices(silent: false);
                            }
                            Navigator.pop(ctx);
                          } else {
                            final err = json.decode(res.body);
                            if (mounted) {
                              AppFeedback.showError(context, err['error'] ?? 'Failed to log recharge');
                            }
                          }
                        } catch (e) {
                          if (mounted) AppFeedback.showError(context, 'Network error: $e');
                        } finally {
                          if (mounted) setDialogState(() => isSubmitting = false);
                        }
                      },
                child: isSubmitting
                    ? const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SizedBox(width: 14, height: 14, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2)),
                          SizedBox(width: 8),
                          Text('Saving...', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
                        ],
                      )
                    : const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.check, size: 16, color: Colors.white),
                          SizedBox(width: 6),
                          Text('Confirm Recharge', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
                        ],
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  // Full-screen image preview
  void _viewPhoto(BuildContext context, String rawUrl) {
    final fullUrl = rawUrl.startsWith('http') ? rawUrl : '$baseUrl$rawUrl';
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          alignment: Alignment.topRight,
          children: [
            InteractiveViewer(
              child: Center(
                child: Image.network(
                  fullUrl,
                  fit: BoxFit.contain,
                  loadingBuilder: (_, child, prog) => prog == null
                      ? child
                      : const Center(child: CircularProgressIndicator(color: Colors.white)),
                  errorBuilder: (_, __, ___) => const Center(
                    child: Text('Failed to load image', style: TextStyle(color: Colors.white)),
                  ),
                ),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.close, color: Colors.white, size: 28),
              onPressed: () => Navigator.pop(ctx),
            ),
          ],
        ),
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
                          icon: const Icon(Icons.description_outlined, color: AppColors.primary),
                          onPressed: _showExportMappingModal,
                          tooltip: 'Export Developer Mapping Report',
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

    final simProvider = (device['simProvider'] ?? '').toString().trim();
    final simNumber = (device['simNumber'] ?? '').toString().trim();
    final simPhotoUrl = (device['simPhotoUrl'] ?? '').toString().trim();
    final validityExpiryStr = device['validityExpiryDate']?.toString();
    DateTime? validityExpiry;
    if (validityExpiryStr != null && validityExpiryStr.isNotEmpty) {
      try {
        validityExpiry = DateTime.parse(validityExpiryStr);
      } catch (_) {}
    }

    Color simBadgeBg = const Color(0xFFF1F5F9);
    Color simBadgeText = const Color(0xFF64748B);
    String simStatusLabel = 'No Expiry';

    if (validityExpiry != null) {
      final now = DateTime.now();
      final diff = validityExpiry.difference(DateTime(now.year, now.month, now.day)).inDays;
      if (diff > 15) {
        simBadgeBg = const Color(0xFFDCFCE7);
        simBadgeText = const Color(0xFF15803D);
        simStatusLabel = '$diff d left';
      } else if (diff >= 0) {
        simBadgeBg = const Color(0xFFFEF3C7);
        simBadgeText = const Color(0xFFD97706);
        simStatusLabel = diff == 0 ? 'Today' : '$diff d left';
      } else {
        simBadgeBg = const Color(0xFFFEE2E2);
        simBadgeText = const Color(0xFFDC2626);
        simStatusLabel = 'Expired';
      }
    }

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
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
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
                    const SizedBox(width: 6),
                    IconButton(
                      icon: const Icon(Icons.delete_outline, size: 18, color: Color(0xFFEF4444)),
                      tooltip: 'Delete Device (GitHub Style Confirmation)',
                      onPressed: () => _confirmDeleteDeviceGitHubStyle(Map<String, dynamic>.from(device)),
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                    ),
                  ],
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
            const SizedBox(height: 8),

            // SIM & Connectivity Information Preview Box
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFF8FAFC),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: Row(
                children: [
                  if (simPhotoUrl.isNotEmpty) ...[
                    GestureDetector(
                      onTap: () => _viewPhoto(context, simPhotoUrl),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(6),
                        child: Image.network(
                          simPhotoUrl.startsWith('http') ? simPhotoUrl : '$baseUrl$simPhotoUrl',
                          width: 38,
                          height: 38,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                            width: 38,
                            height: 38,
                            color: Colors.grey.shade200,
                            child: const Icon(Icons.sim_card, size: 20, color: Color(0xFF64748B)),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                  ] else ...[
                    GestureDetector(
                      onTap: () => _openSimManagementSheet(Map<String, dynamic>.from(device)),
                      child: Container(
                        width: 38,
                        height: 38,
                        decoration: BoxDecoration(
                          color: Colors.amber.shade50,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: Colors.amber.shade300),
                        ),
                        child: const Icon(Icons.add_a_photo_outlined, size: 18, color: Colors.amber),
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.sim_card_outlined, size: 13, color: AppColors.primary),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                simProvider.isNotEmpty ? simProvider : 'SIM Not Configured',
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF1E293B)),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (simNumber.isNotEmpty) ...[
                              const SizedBox(width: 5),
                              Flexible(
                                child: Text('• $simNumber', style: const TextStyle(fontSize: 12, color: Color(0xFF475569)), overflow: TextOverflow.ellipsis),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          simPhotoUrl.isEmpty
                              ? '⚠️ Photo missing (Mandatory)'
                              : (validityExpiry != null
                                  ? 'Valid until ${validityExpiry.day}/${validityExpiry.month}/${validityExpiry.year}'
                                  : 'SIM photo recorded • No expiry date'),
                          style: TextStyle(
                            fontSize: 11,
                            color: simPhotoUrl.isEmpty ? const Color(0xFFB45309) : const Color(0xFF64748B),
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  if (validityExpiry != null) ...[
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: simBadgeBg,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        simStatusLabel,
                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: simBadgeText),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 10),

            // Unified Action: SIM Details & Recharge
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  backgroundColor: const Color(0xFFF8FAFC),
                  foregroundColor: const Color(0xFF0F172A),
                  elevation: 0,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                    side: const BorderSide(color: Color(0xFFCBD5E1)),
                  ),
                ),
                onPressed: () => _openSimManagementSheet(Map<String, dynamic>.from(device)),
                icon: const Icon(Icons.sim_card_outlined, size: 16, color: AppColors.primary),
                label: const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('SIM Details & Recharge', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold)),
                    SizedBox(width: 6),
                    Icon(Icons.bolt, size: 15, color: Colors.amber),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),

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

  void _showExportMappingModal() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(color: const Color(0xFF003580).withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
                  child: const Icon(Icons.description, color: Color(0xFF003580), size: 22),
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Export Developer Mapping Registry', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15.5)),
                      Text('Download compiled LC Gate · Master Unit · AWS IoT Thing report', style: TextStyle(fontSize: 11.5, color: Colors.grey)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF107C41),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    icon: const Icon(Icons.table_view_rounded),
                    label: const Text('Excel (.xlsx)', style: TextStyle(fontWeight: FontWeight.bold)),
                    onPressed: () {
                      Navigator.pop(ctx);
                      _downloadReport('xlsx');
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFE11D48),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    icon: const Icon(Icons.picture_as_pdf_rounded),
                    label: const Text('PDF (.pdf)', style: TextStyle(fontWeight: FontWeight.bold)),
                    onPressed: () {
                      Navigator.pop(ctx);
                      _downloadReport('pdf');
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Future<void> _downloadReport(String format) async {
    try {
      AppFeedback.showInfo(context, 'Generating official ${format.toUpperCase()} report with Indian Railways crest...');
      final token = await _getToken();
      final uri = Uri.parse('$baseUrl/reports/export?reportType=device_mapping&format=$format');
      final res = await http.get(uri, headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      }).timeout(const Duration(seconds: 25));

      if (res.statusCode == 200) {
        final timestamp = DateTime.now().millisecondsSinceEpoch;
        final filename = 'LC_Gate_Device_IoT_Mapping_$timestamp.$format';
        final mimeType = format == 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

        await downloadFileUniversal(
          bytes: res.bodyBytes,
          filename: filename,
          mimeType: mimeType,
        );
        if (mounted) {
          AppFeedback.showSuccess(context, 'Exported $filename (${(res.bodyBytes.length / 1024).toStringAsFixed(1)} KB)');
        }
      } else {
        if (mounted) AppFeedback.showError(context, 'Export failed: HTTP ${res.statusCode}');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Download error: $e');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GITHUB STYLE: DELETE AWS IOT THING CONFIRMATION MODAL
  // ─────────────────────────────────────────────────────────────
  void _confirmDeleteDeviceGitHubStyle(Map<String, dynamic> device) {
    final thingName = (device['thingName'] ?? '').toString();
    final deviceId = device['id'];
    final confirmController = TextEditingController();
    bool isDeleting = false;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dCtx) {
        return StatefulBuilder(
          builder: (dCtx, setDlgState) {
            final matches = confirmController.text.trim() == thingName;

            return Dialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              backgroundColor: Colors.white,
              child: Container(
                constraints: const BoxConstraints(maxWidth: 480),
                padding: const EdgeInsets.all(22),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Header with red warning badge
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFEE2E2),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Icon(Icons.warning_amber_rounded, color: Color(0xFFDC2626), size: 24),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Delete AWS IoT Thing',
                                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                              ),
                              Text(
                                'Permanent database & registry cleanup',
                                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, size: 20),
                          onPressed: isDeleting ? null : () => Navigator.pop(dCtx),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),

                    // GitHub Warning Callout
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFF1F2),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFFECDD3)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.shield_outlined, size: 16, color: Color(0xFFBE123C)),
                              SizedBox(width: 6),
                              Text(
                                'Unexpected bad things will happen if you don’t read this!',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11.5, color: Color(0xFFBE123C)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          RichText(
                            text: TextSpan(
                              style: const TextStyle(fontSize: 12, color: Color(0xFF4C0519), height: 1.4),
                              children: [
                                const TextSpan(text: 'This action '),
                                const TextSpan(text: 'cannot be undone. ', style: TextStyle(fontWeight: FontWeight.bold)),
                                const TextSpan(text: 'This will permanently delete the '),
                                TextSpan(text: thingName, style: const TextStyle(fontWeight: FontWeight.bold, fontFamily: 'monospace')),
                                const TextSpan(text: ' AWS IoT Thing record from the database, purge all associated telemetries, and disconnect it from any assigned LC Gate.'),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),

                    // Confirmation Prompt
                    RichText(
                      text: TextSpan(
                        style: const TextStyle(fontSize: 13, color: Color(0xFF334155)),
                        children: [
                          const TextSpan(text: 'Please type '),
                          TextSpan(
                            text: thingName,
                            style: const TextStyle(fontWeight: FontWeight.bold, fontFamily: 'monospace', color: Color(0xFF0F172A)),
                          ),
                          const TextSpan(text: ' to confirm:'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),

                    // Monospace text field
                    TextField(
                      controller: confirmController,
                      enabled: !isDeleting,
                      autofocus: true,
                      style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 14),
                      decoration: InputDecoration(
                        hintText: thingName,
                        hintStyle: TextStyle(color: Colors.grey.shade400, fontFamily: 'monospace'),
                        filled: true,
                        fillColor: const Color(0xFFF8FAFC),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide(
                            color: matches ? const Color(0xFFDC2626) : const Color(0xFFCBD5E1),
                            width: matches ? 1.5 : 1.0,
                          ),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: Color(0xFFDC2626), width: 2),
                        ),
                      ),
                      onChanged: (_) => setDlgState(() {}),
                    ),
                    const SizedBox(height: 20),

                    // Action Button (GitHub Red or Disabled Grey)
                    SizedBox(
                      width: double.infinity,
                      height: 44,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: matches ? const Color(0xFFDC2626) : const Color(0xFFF1F5F9),
                          disabledBackgroundColor: const Color(0xFFF1F5F9),
                          foregroundColor: matches ? Colors.white : const Color(0xFF94A3B8),
                          disabledForegroundColor: const Color(0xFF94A3B8),
                          elevation: 0,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: BorderSide(
                              color: matches ? const Color(0xFFB91C1C) : const Color(0xFFE2E8F0),
                            ),
                          ),
                        ),
                        onPressed: (!matches || isDeleting)
                            ? null
                            : () async {
                                setDlgState(() => isDeleting = true);
                                try {
                                  final token = await _getToken();
                                  final uri = Uri.parse('$baseUrl/devices/$deviceId');
                                  final res = await http.delete(uri, headers: {
                                    'Authorization': 'Bearer $token',
                                    'Content-Type': 'application/json',
                                  }).timeout(const Duration(seconds: 15));

                                  if (res.statusCode == 200) {
                                    Navigator.pop(dCtx);
                                    if (mounted) {
                                      AppFeedback.showSuccess(context, 'Device $thingName deleted from database');
                                      _fetchDevices(silent: false);
                                    }
                                  } else {
                                    final err = json.decode(res.body);
                                    if (mounted) {
                                      AppFeedback.showError(context, err['error'] ?? 'Failed to delete device');
                                    }
                                    setDlgState(() => isDeleting = false);
                                  }
                                } catch (e) {
                                  if (mounted) AppFeedback.showError(context, 'Delete error: $e');
                                  setDlgState(() => isDeleting = false);
                                }
                              },
                        child: isDeleting
                            ? const Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                  ),
                                  SizedBox(width: 10),
                                  Text('Deleting Thing...', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white)),
                                ],
                              )
                            : const Text(
                                'I understand the consequences, delete this thing',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5),
                              ),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
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
                              color: (strVal.toUpperCase() == 'NOT_CLOSED' ? 'OPEN' : strVal).toUpperCase() == 'CLOSED' ? const Color(0xFFDCFCE7) : const Color(0xFFFEE2E2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              strVal.toUpperCase() == 'NOT_CLOSED' ? 'OPEN' : strVal,
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                color: (strVal.toUpperCase() == 'NOT_CLOSED' ? 'OPEN' : strVal).toUpperCase() == 'CLOSED' ? const Color(0xFF15803D) : const Color(0xFFB91C1C),
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

// ─────────────────────────────────────────────────────────────────────────────
// SIM & CONNECTIVITY MANAGEMENT BOTTOM SHEET (OPTION A)
// ─────────────────────────────────────────────────────────────────────────────
class _DeviceSimManagementSheet extends StatefulWidget {
  final Map<String, dynamic> device;
  final VoidCallback onSaved;

  const _DeviceSimManagementSheet({required this.device, required this.onSaved});

  @override
  State<_DeviceSimManagementSheet> createState() => _DeviceSimManagementSheetState();
}

class _DeviceSimManagementSheetState extends State<_DeviceSimManagementSheet> {
  final ImagePicker _picker = ImagePicker();
  Uint8List? _imageBytes;
  String? _existingPhotoUrl;

  late TextEditingController _phoneCtrl;
  late TextEditingController _iccidCtrl;

  String _provider = 'Airtel';
  String _simType = 'M2M';
  DateTime? _lastRechargeDate;
  DateTime? _validityExpiryDate;
  int? _selectedPresetDays;

  bool _isSaving = false;

  final List<String> _providerOptions = ['Airtel', 'Jio', 'Vodafone Idea (Vi)', 'BSNL', 'Other'];
  final List<String> _typeOptions = ['M2M', 'Regular', 'eSIM'];

  @override
  void initState() {
    super.initState();
    _existingPhotoUrl = (widget.device['simPhotoUrl'] ?? '').toString().trim();
    if (_existingPhotoUrl!.isEmpty) _existingPhotoUrl = null;

    _phoneCtrl = TextEditingController(text: widget.device['simNumber'] ?? '');
    _iccidCtrl = TextEditingController(text: widget.device['iccid'] ?? '');

    final devProvider = (widget.device['simProvider'] ?? '').toString().trim();
    if (_providerOptions.contains(devProvider)) {
      _provider = devProvider;
    } else if (devProvider.isNotEmpty) {
      _provider = 'Other';
    }

    final devType = (widget.device['simType'] ?? '').toString().trim();
    if (_typeOptions.contains(devType)) {
      _simType = devType;
    }

    if (widget.device['lastRechargeDate'] != null) {
      try {
        _lastRechargeDate = DateTime.parse(widget.device['lastRechargeDate'].toString());
      } catch (_) {}
    }

    if (widget.device['validityExpiryDate'] != null) {
      try {
        _validityExpiryDate = DateTime.parse(widget.device['validityExpiryDate'].toString());
        final diff = _validityExpiryDate!.difference(DateTime.now()).inDays;
        if (diff == 28 || diff == 84 || diff == 365) {
          _selectedPresetDays = diff;
        }
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _iccidCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickImage(ImageSource source) async {
    try {
      final photo = await _picker.pickImage(source: source, imageQuality: 70);
      if (photo != null) {
        final bytes = await photo.readAsBytes();
        setState(() {
          _imageBytes = bytes;
        });
        if (mounted) {
          AppFeedback.showSuccess(context, 'SIM Card photo captured!');
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Failed to pick image: $e');
    }
  }

  Widget _buildPresetChip(int days, String label) {
    final isSelected = _selectedPresetDays == days;
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: () {
        setState(() {
          _selectedPresetDays = days;
          _validityExpiryDate = DateTime.now().add(Duration(days: days));
        });
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: isSelected ? AppColors.primary : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: isSelected ? AppColors.primary : const Color(0xFFCBD5E1),
            width: isSelected ? 1.8 : 1.0,
          ),
          boxShadow: isSelected
              ? [
                  BoxShadow(
                    color: AppColors.primary.withOpacity(0.3),
                    blurRadius: 6,
                    offset: const Offset(0, 2),
                  )
                ]
              : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              isSelected ? Icons.check_circle : Icons.add_circle_outline,
              size: 14,
              color: isSelected ? Colors.white : const Color(0xFF64748B),
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                color: isSelected ? Colors.white : const Color(0xFF334155),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _save() async {
    final hasPhoto = _imageBytes != null || (_existingPhotoUrl != null && _existingPhotoUrl!.isNotEmpty);
    if (!hasPhoto) {
      AppFeedback.showError(context, 'SIM Card photograph is mandatory. Please capture or select a photo.');
      return;
    }

    setState(() => _isSaving = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token') ?? '';

      final body = <String, dynamic>{
        'simProvider': _provider,
        'simNumber': _phoneCtrl.text.trim(),
        'iccid': _iccidCtrl.text.trim(),
        'simType': _simType,
        if (_imageBytes != null)
          'imageBase64': 'data:image/jpeg;base64,${base64Encode(_imageBytes!)}',
        if (_existingPhotoUrl != null && _imageBytes == null)
          'simPhotoUrl': _existingPhotoUrl,
        if (_lastRechargeDate != null)
          'lastRechargeDate': _lastRechargeDate!.toIso8601String(),
        if (_validityExpiryDate != null)
          'validityExpiryDate': _validityExpiryDate!.toIso8601String(),
      };

      final res = await http.put(
        Uri.parse('$baseUrl/devices/${widget.device['id']}/sim'),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json',
        },
        body: json.encode(body),
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'SIM details and connectivity record updated!');
          widget.onSaved();
          Navigator.pop(context);
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) {
          AppFeedback.showError(context, err['error'] ?? 'Failed to save SIM details');
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error: $e');
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final thingName = (widget.device['thingName'] ?? 'Device').toString();
    final hasPhoto = _imageBytes != null || (_existingPhotoUrl != null && _existingPhotoUrl!.isNotEmpty);

    return Container(
      height: MediaQuery.of(context).size.height * 0.90,
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
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.sim_card, color: AppColors.primary, size: 22),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'SIM & Connectivity Registry',
                        style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      Text(
                        'Device: $thingName • LC Gate Physical Controller',
                        style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
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
          const Divider(height: 1),

          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(18),
              children: [
                // ─────────────────────────────────────────────────────────
                // SECTION 1: SIM CARD & IDENTITY
                // ─────────────────────────────────────────────────────────
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.primary.withOpacity(0.2)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.sim_card, size: 18, color: AppColors.primary),
                      SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'SECTION 1: SIM CARD & OPERATOR IDENTITY',
                              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary),
                            ),
                            Text(
                              'Physical SIM photograph, telecom provider, ICCID serial & mobile number',
                              style: TextStyle(fontSize: 10.5, color: Color(0xFF64748B)),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),

                // 1. Mandatory SIM Photo Card
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: hasPhoto ? const Color(0xFFF8FAFC) : const Color(0xFFFFFBEB),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: hasPhoto ? const Color(0xFFE2E8F0) : const Color(0xFFFDE68A),
                      width: 1.5,
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.photo_camera_outlined, size: 18, color: AppColors.primary),
                          const SizedBox(width: 6),
                          const Text(
                            'SIM Card Photograph',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                          ),
                          const SizedBox(width: 4),
                          const Text(
                            '* Mandatory',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFFDC2626)),
                          ),
                          const Spacer(),
                          if (hasPhoto)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFFDCFCE7),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: const Text(
                                'Photo Attached',
                                style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF15803D)),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Upload a clear picture of the installed SIM showing barcode or printed ICCID digits.',
                        style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                      ),
                      const SizedBox(height: 12),

                      // Image Preview Box
                      if (_imageBytes != null) ...[
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Stack(
                            alignment: Alignment.topRight,
                            children: [
                              Image.memory(_imageBytes!, height: 180, width: double.infinity, fit: BoxFit.cover),
                              Container(
                                margin: const EdgeInsets.all(8),
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                decoration: BoxDecoration(
                                  color: Colors.black.withOpacity(0.6),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: const Text('New Photo', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
                              ),
                            ],
                          ),
                        ),
                      ] else if (_existingPhotoUrl != null && _existingPhotoUrl!.isNotEmpty) ...[
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Stack(
                            alignment: Alignment.topRight,
                            children: [
                              Image.network(
                                _existingPhotoUrl!.startsWith('http') ? _existingPhotoUrl! : '$baseUrl$_existingPhotoUrl',
                                height: 180,
                                width: double.infinity,
                                fit: BoxFit.cover,
                                errorBuilder: (_, __, ___) => Container(
                                  height: 120,
                                  color: Colors.grey.shade100,
                                  alignment: Alignment.center,
                                  child: const Text('Failed to load image preview'),
                                ),
                              ),
                              Container(
                                margin: const EdgeInsets.all(8),
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                decoration: BoxDecoration(
                                  color: Colors.black.withOpacity(0.6),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: const Text('Current Photo', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
                              ),
                            ],
                          ),
                        ),
                      ] else ...[
                        Container(
                          height: 110,
                          width: double.infinity,
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.amber.shade200, style: BorderStyle.solid),
                          ),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.add_a_photo_outlined, size: 36, color: Colors.amber.shade600),
                              const SizedBox(height: 6),
                              const Text('No photo uploaded yet', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFFB45309))),
                              const Text('Take camera snapshot or choose from gallery', style: TextStyle(fontSize: 11, color: Color(0xFF92400E))),
                            ],
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),

                      // Camera / Gallery Buttons
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(vertical: 8),
                                side: const BorderSide(color: AppColors.primary),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                              onPressed: () => _pickImage(ImageSource.camera),
                              icon: const Icon(Icons.camera_alt, size: 16, color: AppColors.primary),
                              label: const Text('Live Camera', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary)),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton.icon(
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(vertical: 8),
                                side: const BorderSide(color: Color(0xFFCBD5E1)),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                              ),
                              onPressed: () => _pickImage(ImageSource.gallery),
                              icon: const Icon(Icons.photo_library, size: 16, color: Color(0xFF475569)),
                              label: const Text('Gallery', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),

                // 2. Telecom Operator & SIM Type (Optional)
                Row(
                  children: [
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Telecom Provider (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                          const SizedBox(height: 6),
                          DropdownButtonFormField<String>(
                            value: _provider,
                            decoration: InputDecoration(
                              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                            items: _providerOptions
                                .map((p) => DropdownMenuItem(value: p, child: Text(p, style: const TextStyle(fontSize: 13))))
                                .toList(),
                            onChanged: (val) => setState(() => _provider = val ?? 'Airtel'),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('SIM Type', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                          const SizedBox(height: 6),
                          DropdownButtonFormField<String>(
                            value: _simType,
                            decoration: InputDecoration(
                              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                            items: _typeOptions
                                .map((t) => DropdownMenuItem(value: t, child: Text(t, style: const TextStyle(fontSize: 13))))
                                .toList(),
                            onChanged: (val) => setState(() => _simType = val ?? 'M2M'),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),

                // 3. Mobile Number & ICCID (Optional)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('ICCID / Barcode Digits (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                    const SizedBox(height: 6),
                    TextField(
                      controller: _iccidCtrl,
                      decoration: InputDecoration(
                        hintText: 'e.g. 89910009238472910',
                        prefixIcon: const Icon(Icons.qr_code, size: 18),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),

                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('SIM Mobile Number (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                    const SizedBox(height: 6),
                    TextField(
                      controller: _phoneCtrl,
                      keyboardType: TextInputType.phone,
                      decoration: InputDecoration(
                        hintText: 'e.g. 9876543210',
                        prefixIcon: const Icon(Icons.phone_android, size: 18),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),

                // ─────────────────────────────────────────────────────────
                // SECTION 2: RECHARGE & VALIDITY MANAGEMENT
                // ─────────────────────────────────────────────────────────
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFFBEB),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFFDE68A)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.bolt, size: 18, color: Color(0xFFD97706)),
                      SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'SECTION 2: RECHARGE & PLAN VALIDITY',
                              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFFB45309)),
                            ),
                            Text(
                              'Service expiry schedule, quick renewal presets & recharge payment logs',
                              style: TextStyle(fontSize: 10.5, color: Color(0xFF92400E)),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),

                // 4. Validity Expiry Date & Presets
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Validity Expiry Date (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                        if (_validityExpiryDate != null)
                          GestureDetector(
                            onTap: () => setState(() {
                              _validityExpiryDate = null;
                              _selectedPresetDays = null;
                            }),
                            child: const Text('Clear', style: TextStyle(fontSize: 11, color: Colors.red, fontWeight: FontWeight.bold)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: () async {
                        final picked = await showDatePicker(
                          context: context,
                          initialDate: _validityExpiryDate ?? DateTime.now().add(const Duration(days: 28)),
                          firstDate: DateTime.now().subtract(const Duration(days: 365)),
                          lastDate: DateTime.now().add(const Duration(days: 1500)),
                        );
                        if (picked != null) {
                          final diff = picked.difference(DateTime.now()).inDays;
                          setState(() {
                            _validityExpiryDate = picked;
                            if (diff == 28 || diff == 84 || diff == 365) {
                              _selectedPresetDays = diff;
                            } else {
                              _selectedPresetDays = null;
                            }
                          });
                        }
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          border: Border.all(color: const Color(0xFFCBD5E1)),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              _validityExpiryDate != null
                                  ? '${_validityExpiryDate!.day}/${_validityExpiryDate!.month}/${_validityExpiryDate!.year}'
                                  : 'Select Expiry Date',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                                color: _validityExpiryDate != null ? const Color(0xFF0F172A) : Colors.grey.shade500,
                              ),
                            ),
                            const Icon(Icons.event, size: 18, color: AppColors.primary),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    // Quick duration presets with active selection color changes
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        _buildPresetChip(28, '+28d'),
                        _buildPresetChip(84, '+84d'),
                        _buildPresetChip(365, '+365d (1 Yr)'),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 14),

                // 5. Last Recharge Date
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Last Recharge Date (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF475569))),
                        if (_lastRechargeDate != null)
                          GestureDetector(
                            onTap: () => setState(() => _lastRechargeDate = null),
                            child: const Text('Clear', style: TextStyle(fontSize: 11, color: Colors.red, fontWeight: FontWeight.bold)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: () async {
                        final picked = await showDatePicker(
                          context: context,
                          initialDate: _lastRechargeDate ?? DateTime.now(),
                          firstDate: DateTime.now().subtract(const Duration(days: 730)),
                          lastDate: DateTime.now(),
                        );
                        if (picked != null) {
                          setState(() => _lastRechargeDate = picked);
                        }
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          border: Border.all(color: const Color(0xFFCBD5E1)),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              _lastRechargeDate != null
                                  ? '${_lastRechargeDate!.day}/${_lastRechargeDate!.month}/${_lastRechargeDate!.year}'
                                  : 'Select Recharge Date',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                                color: _lastRechargeDate != null ? const Color(0xFF0F172A) : Colors.grey.shade500,
                              ),
                            ),
                            const Icon(Icons.history, size: 18, color: AppColors.primary),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),

                // Save Action Button with clear active acknowledgement
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      disabledBackgroundColor: AppColors.primary,
                      elevation: _isSaving ? 0 : 2,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    onPressed: _isSaving ? null : _save,
                    child: _isSaving
                        ? const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5),
                              ),
                              SizedBox(width: 10),
                              Text(
                                'Saving SIM & Recharge Details...',
                                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                              ),
                            ],
                          )
                        : const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.check_circle_outline, size: 18, color: Colors.white),
                              SizedBox(width: 8),
                              Text(
                                'Save SIM & Recharge Details',
                                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                              ),
                            ],
                          ),
                  ),
                ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
