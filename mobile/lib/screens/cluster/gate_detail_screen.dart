import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import 'create_master_screen.dart';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import 'station_search_sheet.dart';
import 'railway_data.dart';
import 'evidence_checklist_screen.dart';
import 'upload_evidence_screen.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../services/lc_gates_cache_service.dart';

class GateDetailScreen extends StatefulWidget {
  final String token;
  final Map gate;

  const GateDetailScreen({super.key, required this.token, required this.gate});

  @override
  State<GateDetailScreen> createState() => _GateDetailScreenState();
}

class _GateDetailScreenState extends State<GateDetailScreen> {
  late Map gate;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    gate = widget.gate;
  }

    Future<void> _pingGateDevice() async {
    final gateId = gate['id'];
    if (gateId == null) return;
    final lcNumber = gate['lcNumber'] ?? 'LC Gate';

    AppFeedback.showInfo(context, 'Checking connection for $lcNumber hardware...');
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/lcgate/$gateId/health-check'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Content-Type': 'application/json',
        },
      ).timeout(const Duration(seconds: 10));

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          final isDelivered = data['mqttDelivered'] == true;
          AppFeedback.showSuccess(
            context,
            isDelivered
                ? 'Connection verified: $lcNumber hardware is ONLINE & HEALTHY'
                : 'Connection check registered for $lcNumber: Status is HEALTHY',
          );
          _refresh();
        }
      } else {
        if (mounted) {
          AppFeedback.showError(context, 'Connection check failed (HTTP ${res.statusCode})');
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Connection error: $e');
      }
    }
  }

  Future<void> _refresh({bool isManual = false}) async {
    try {
      final gateId = gate['id'];
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/$gateId?_t=${DateTime.now().millisecondsSinceEpoch}'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final gateData = data is Map ? (data['cluster'] ?? data['gate'] ?? data) : null;
        if (gateData != null && mounted) {
          setState(() => gate = Map<String, dynamic>.from(gateData));
          if (isManual) {
            AppFeedback.showSuccess(context, 'Gate and device details refreshed.');
          }
          try {
            final prefs = await SharedPreferences.getInstance();
            final userId = prefs.getString('userId') ?? prefs.getString('employeeId') ?? 'user';
            LCGatesCacheService.instance.patchGate(userId, Map<String, dynamic>.from(gateData));
          } catch (_) {}
          return;
        }
      }

      // Fallback to /lcgate directory
      final fallbackRes = await http.get(
        Uri.parse('$baseUrl/lcgate'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (fallbackRes.statusCode == 200) {
        final List data = json.decode(fallbackRes.body);
        final updated = data.firstWhere((g) => g['id'] == gate['id'], orElse: () => gate);
        if (mounted) {
          setState(() => gate = updated);
        }
      }
    } catch (e) {
      if (mounted && isManual) {
        AppFeedback.showError(context, 'Network error refreshing gate details: $e');
      }
    }
  }

  Future<void> _deleteEvidence(Map evidence, String itemTitle, [VoidCallback? onDeleted]) async {
    bool confirm = await showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text('Delete Photo for "$itemTitle"?'),
        content: const Text('Are you sure you want to delete this uploaded photo? This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(dialogCtx, true),
            child: const Text('Delete', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    ) ?? false;

    if (!confirm) return;
    try {
      final evId = evidence['id'];
      http.Response res = await http.delete(
        Uri.parse('$baseUrl/evidence/$evId'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode != 204 && res.statusCode != 200) {
        res = await http.post(
          Uri.parse('$baseUrl/evidence/$evId/delete'),
          headers: {'Authorization': 'Bearer ${widget.token}'},
        );
      }
      if (res.statusCode == 200 || res.statusCode == 204) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'Photo for "$itemTitle" deleted successfully.');
        }
        await _refresh();
        if (onDeleted != null) onDeleted();
      } else {
        if (mounted) AppFeedback.showError(context, 'Failed to delete photo: ${res.body}');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error deleting photo: $e');
    }
  }

  Future<void> _markCacheStale() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final userId = prefs.getString('userId') ?? prefs.getString('employeeId') ?? 'user';
      LCGatesCacheService.instance.markStale(userId);
    } catch (_) {}
  }

  Future<void> _showEditGateDialog() async {
    final lcCtrl = TextEditingController(text: (gate['lcNumber'] ?? '').toString());
    final nameCtrl = TextEditingController(text: (gate['name'] ?? '').toString());
    final locCtrl = TextEditingController(text: (gate['locationName'] ?? '').toString());
    final latCtrl = TextEditingController(text: (gate['latitude'] ?? '').toString());
    final lngCtrl = TextEditingController(text: (gate['longitude'] ?? '').toString());

    String selectedZone = (gate['zone'] ?? '').toString();
    if (!RailwayData.data.containsKey(selectedZone)) {
      selectedZone = RailwayData.data.keys.first;
    }
    List<String> divisions = RailwayData.data[selectedZone] ?? [];
    String selectedDivision = (gate['division'] ?? '').toString();
    if (!divisions.contains(selectedDivision)) {
      selectedDivision = divisions.isNotEmpty ? divisions.first : '';
    }

    List<StationReference> stations = RailwayData.stationsForDivision(selectedDivision);
    String? selectedStationCode = gate['station']?['code'] ?? gate['stationCode'];
    if (selectedStationCode != null && !stations.any((s) => s.code == selectedStationCode)) {
      selectedStationCode = null;
    }

    bool isSubmitting = false;

    await showDialog(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: Row(
            children: const [
              Icon(Icons.edit_road, color: AppColors.primary),
              SizedBox(width: 8),
              Text('Edit LC Gate', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            ],
          ),
          content: SingleChildScrollView(
            child: SizedBox(
              width: 440,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: lcCtrl,
                    decoration: const InputDecoration(labelText: 'LC Gate Number *', isDense: true, border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: nameCtrl,
                    decoration: const InputDecoration(labelText: 'Display Name', isDense: true, border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: locCtrl,
                    decoration: const InputDecoration(labelText: 'Location Description', isDense: true, border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    value: selectedZone,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Railway Zone *', isDense: true, border: OutlineInputBorder()),
                    items: RailwayData.data.keys.map((z) => DropdownMenuItem(value: z, child: Text(z, style: const TextStyle(fontSize: 12)))).toList(),
                    onChanged: (val) {
                      if (val != null) {
                        setModalState(() {
                          selectedZone = val;
                          divisions = RailwayData.data[selectedZone] ?? [];
                          selectedDivision = divisions.isNotEmpty ? divisions.first : '';
                          stations = RailwayData.stationsForDivision(selectedDivision);
                          selectedStationCode = null;
                        });
                      }
                    },
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    value: divisions.contains(selectedDivision) ? selectedDivision : null,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Railway Division *', isDense: true, border: OutlineInputBorder()),
                    items: divisions.map((d) => DropdownMenuItem(value: d, child: Text(d, style: const TextStyle(fontSize: 12)))).toList(),
                    onChanged: (val) {
                      if (val != null) {
                        setModalState(() {
                          selectedDivision = val;
                          stations = RailwayData.stationsForDivision(selectedDivision);
                          selectedStationCode = null;
                        });
                      }
                    },
                  ),
                  const SizedBox(height: 10),
                  InkWell(
                    onTap: selectedDivision.isEmpty
                        ? null
                        : () async {
                            final picked = await StationSearchSheet.show(
                              context,
                              token: widget.token,
                              zone: selectedZone,
                              division: selectedDivision,
                              selectedCode: selectedStationCode,
                            );
                            if (picked != null) {
                              setModalState(() {
                                selectedStationCode = picked.code;
                              });
                            }
                          },
                    child: InputDecorator(
                      decoration: InputDecoration(
                        labelText: 'Railway Station (Optional)',
                        isDense: true,
                        border: const OutlineInputBorder(),
                        suffixIcon: selectedStationCode != null
                            ? IconButton(
                                icon: const Icon(Icons.clear, size: 16),
                                onPressed: () => setModalState(() => selectedStationCode = null),
                              )
                            : const Icon(Icons.arrow_drop_down),
                      ),
                      child: Text(
                        selectedStationCode != null ? selectedStationCode! : 'Tap to search stations...',
                        style: TextStyle(
                          fontSize: 12,
                          color: selectedStationCode != null ? const Color(0xFF0F172A) : Colors.grey,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: latCtrl,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'Latitude', isDense: true, border: OutlineInputBorder()),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: lngCtrl,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'Longitude', isDense: true, border: OutlineInputBorder()),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSubmitting ? null : () => Navigator.pop(dialogCtx),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary),
              onPressed: isSubmitting ? null : () async {
                final lcNum = lcCtrl.text.trim();
                if (lcNum.isEmpty) {
                  AppFeedback.showWarning(context, 'LC Gate Number is required.');
                  return;
                }
                setModalState(() => isSubmitting = true);
                try {
                  final stObj = stations.cast<StationReference?>().firstWhere(
                    (s) => s?.code == selectedStationCode,
                    orElse: () => null,
                  );

                  final body = <String, dynamic>{
                    'lcNumber': lcNum,
                    'name': nameCtrl.text.trim().isEmpty ? lcNum : nameCtrl.text.trim(),
                    'locationName': locCtrl.text.trim().isEmpty ? lcNum : locCtrl.text.trim(),
                    'zone': selectedZone,
                    'division': selectedDivision,
                    'stationCode': selectedStationCode,
                    'stationName': stObj?.name,
                    'latitude': double.tryParse(latCtrl.text.trim()) ?? 0.0,
                    'longitude': double.tryParse(lngCtrl.text.trim()) ?? 0.0,
                  };

                  final res = await http.put(
                    Uri.parse('$baseUrl/lcgate/${gate['id']}'),
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': 'Bearer ${widget.token}',
                    },
                    body: json.encode(body),
                  );

                  if (res.statusCode == 200) {
                    final updated = json.decode(res.body);
                    if (mounted) {
                      setState(() => gate = updated);
                      Navigator.pop(dialogCtx);
                      AppFeedback.showSuccess(context, 'LC Gate updated successfully.');
                      await _refresh();
                      await _markCacheStale();
                    }
                  } else {
                    String err = 'Failed to update LC Gate';
                    try {
                      final b = json.decode(res.body);
                      if (b['error'] != null) err = b['error'];
                    } catch (_) {}
                    if (mounted) AppFeedback.showError(context, err);
                    setModalState(() => isSubmitting = false);
                  }
                } catch (e) {
                  if (mounted) AppFeedback.showError(context, 'Network error updating gate: $e');
                  setModalState(() => isSubmitting = false);
                }
              },
              child: isSubmitting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Save Changes', style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showDeviceAssignmentDialog() async {
    setState(() => _isLoading = true);
    List<dynamic> allDevices = [];
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List) {
          allDevices = data['devices'];
        }
      }
    } catch (_) {}
    if (mounted) setState(() => _isLoading = false);

    final assignedDevices = allDevices.where((d) => d['gateId'] == gate['id']).toList();
    final unassignedDevices = allDevices.where((d) => d['gateId'] == null).toList();

    String? selectedUnassignedId;

    if (!mounted) return;

    await showDialog(
      context: context,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: Row(
            children: const [
              Icon(Icons.developer_board, color: AppColors.primary),
              SizedBox(width: 8),
              Text('AWS IoT Device Assignment', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            ],
          ),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Assign or unassign AWS IoT registered hardware devices for Gate ${gate['lcNumber']}.',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                  ),
                  const SizedBox(height: 16),
                  const Text('CURRENTLY ASSIGNED DEVICES', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF475569))),
                  const SizedBox(height: 6),
                  if (assignedDevices.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: const Color(0xFFF8FAFC), borderRadius: BorderRadius.circular(8), border: Border.all(color: const Color(0xFFE2E8F0))),
                      child: const Text('No physical AWS IoT devices assigned to this gate. It operates as a virtual LC gate.', style: TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                    )
                  else
                    ...assignedDevices.map((dev) => Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFCBD5E1)),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.memory, size: 18, color: AppColors.primary),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(dev['thingName'] ?? 'Device', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                                Text('Type: ${dev['deviceType'] ?? 'MASTER'} • Serial: ${dev['serialNumber'] ?? '-'}', style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                              ],
                            ),
                          ),
                          TextButton(
                            style: TextButton.styleFrom(foregroundColor: Colors.red, visualDensity: VisualDensity.compact),
                            onPressed: () async {
                              final confirm = await showDialog<bool>(
                                context: context,
                                builder: (c) => AlertDialog(
                                  title: const Text('Unassign Hardware Device?'),
                                  content: Text('Unassign ${dev['thingName']} from this LC Gate? The physical device will return to the unassigned registry pool.'),
                                  actions: [
                                    TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                                    ElevatedButton(
                                      style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
                                      onPressed: () => Navigator.pop(c, true),
                                      child: const Text('Unassign', style: TextStyle(color: Colors.white)),
                                    ),
                                  ],
                                ),
                              );
                              if (confirm == true) {
                                try {
                                  final res = await http.post(
                                    Uri.parse('$baseUrl/lcgate/${gate['id']}/unassign-device'),
                                    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${widget.token}'},
                                    body: json.encode({'deviceId': dev['id']}),
                                  );
                                  if (res.statusCode == 200) {
                                    setModalState(() {
                                      assignedDevices.removeWhere((d) => d['id'] == dev['id']);
                                      unassignedDevices.add(dev);
                                    });
                                    await _refresh();
                                    await _markCacheStale();
                                    if (mounted) AppFeedback.showSuccess(context, 'Device unassigned from gate.');
                                  } else {
                                    if (mounted) AppFeedback.showError(context, 'Failed to unassign device');
                                  }
                                } catch (e) {
                                  if (mounted) AppFeedback.showError(context, 'Error unassigning: $e');
                                }
                              }
                            },
                            child: const Text('Unassign', style: TextStyle(fontSize: 12)),
                          ),
                        ],
                      ),
                    )),
                  const SizedBox(height: 16),
                  const Text('LINK NEW HARDWARE DEVICE', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF475569))),
                  const SizedBox(height: 6),
                  if (unassignedDevices.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(color: const Color(0xFFFFFBEB), borderRadius: BorderRadius.circular(8), border: Border.all(color: const Color(0xFFFDE68A))),
                      child: const Text('No unassigned devices currently available in AWS IoT Registry.', style: TextStyle(fontSize: 11.5, color: Color(0xFF92400E))),
                    )
                  else
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            value: selectedUnassignedId,
                            isExpanded: true,
                            hint: const Text('Select AWS IoT Device', style: TextStyle(fontSize: 12)),
                            decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                            items: unassignedDevices.map((d) => DropdownMenuItem<String>(
                              value: d['id'].toString(),
                              child: Text('${d['thingName']} (${d['deviceType']})', style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                            )).toList(),
                            onChanged: (val) => setModalState(() => selectedUnassignedId = val),
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary, visualDensity: VisualDensity.compact),
                          onPressed: selectedUnassignedId == null ? null : () async {
                            final chosenDev = unassignedDevices.firstWhere((d) => d['id'].toString() == selectedUnassignedId);
                            try {
                              final res = await http.post(
                                Uri.parse('$baseUrl/lcgate/${gate['id']}/assign-device'),
                                headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${widget.token}'},
                                body: json.encode({'deviceId': chosenDev['id']}),
                              );
                              if (res.statusCode == 200) {
                                setModalState(() {
                                  unassignedDevices.removeWhere((d) => d['id'] == chosenDev['id']);
                                  assignedDevices.add(chosenDev);
                                  selectedUnassignedId = null;
                                });
                                await _refresh();
                                await _markCacheStale();
                                if (mounted) AppFeedback.showSuccess(context, 'Device assigned to LC Gate successfully.');
                              } else {
                                if (mounted) AppFeedback.showError(context, 'Failed to assign device.');
                              }
                            } catch (e) {
                              if (mounted) AppFeedback.showError(context, 'Error assigning: $e');
                            }
                          },
                          child: const Text('Assign', style: TextStyle(color: Colors.white, fontSize: 12)),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogCtx), child: const Text('Close')),
          ],
        ),
      ),
    );
  }

  Future<void> _deleteMaster(Map master) async {
    final ctrl = TextEditingController();
    final serial = (master['serialNumber'] ?? '').toString();
    bool confirm = await showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: const Text('Delete Master Unit?', style: TextStyle(color: Colors.red)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('This action cannot be undone. This will permanently delete the Master Unit, and all of its Slave Devices and evidence.'),
            const SizedBox(height: 16),
            Text('Please type "$serial" to confirm:'),
            const SizedBox(height: 8),
            TextField(controller: ctrl, decoration: const InputDecoration(border: OutlineInputBorder()))
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              if (ctrl.text.trim() == serial) {
                Navigator.pop(dialogCtx, true);
              } else {
                AppFeedback.showWarning(context, 'Serial number does not match "$serial". Deletion aborted.');
              }
            }, 
            child: const Text('Delete Master Unit', style: TextStyle(color: Colors.white))
          ),
        ],
      )
    ) ?? false;

    if (!confirm) return;
    setState(() => _isLoading = true);
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/lcgate/masters/${master['id']}'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 204 || res.statusCode == 200) {
        await _refresh();
        await _markCacheStale();
        if (mounted) {
          AppFeedback.showSuccess(context, 'Master Unit "$serial" permanently deleted.');
        }
      } else {
        String errMsg = 'Failed to delete Master Unit';
        try {
          final err = json.decode(res.body);
          if (err['error'] != null) errMsg = err['error'];
        } catch (_) {}
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error deleting Master Unit: $e');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _deleteDevice(Map device) async {
    final serial = (device['serialNumber'] ?? 'Unknown').toString();
    final deviceTypeName = device['type'] == 'DEVICE_1' ? 'Device 1 (Hall Effect + Limit Switch)' : 'Device 2 (Tilt Sensor)';
    bool confirm = await showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text('Delete Slave Device "$serial"?'),
        content: Text('Are you sure you want to permanently delete this $deviceTypeName?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(dialogCtx, true), 
            child: const Text('Delete', style: TextStyle(color: Colors.white))
          ),
        ],
      )
    ) ?? false;

    if (!confirm) return;
    setState(() => _isLoading = true);
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/lcgate/devices/${device['id']}'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 204 || res.statusCode == 200) {
        await _refresh();
        await _markCacheStale();
        if (mounted) {
          AppFeedback.showSuccess(context, 'Slave Device "$serial" deleted successfully.');
        }
      } else {
        String errMsg = 'Failed to delete slave device';
        try {
          final err = json.decode(res.body);
          if (err['error'] != null) errMsg = err['error'];
        } catch (_) {}
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error deleting slave device: $e');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  String getSlaveLetter(String? type) {
    switch (type) {
      case 'LIMIT_SWITCH':
      case 'DEVICE_1':
        return 'A';
      case 'HALL_EFFECT':
      case 'DEVICE_2':
        return 'B';
      case 'TILT_SENSOR':
        return 'C';
      default:
        return 'A';
    }
  }

  String getSlaveName(String? type) {
    switch (type) {
      case 'LIMIT_SWITCH':
      case 'DEVICE_1':
        return 'Limit Switch';
      case 'HALL_EFFECT':
      case 'DEVICE_2':
        return 'Hall Effect Sensor';
      case 'TILT_SENSOR':
        return 'Tilt Sensor';
      default:
        return type?.replaceAll('_', ' ') ?? 'Slave Device';
    }
  }

  String getSlaveSubtitle(String? type) {
    switch (type) {
      case 'LIMIT_SWITCH':
        return 'Limit Switch (End-stop & locking mechanism)';
      case 'HALL_EFFECT':
        return 'Hall Effect Sensor (Boom barrier position detection)';
      case 'TILT_SENSOR':
        return 'Tilt Sensor (Boom inclination monitoring)';
      case 'DEVICE_1':
        return 'Limit Switch & Hall Effect Sensors';
      case 'DEVICE_2':
        return 'Tilt & Angle Sensor';
      default:
        return 'Connected hardware wired slave sensor';
    }
  }

  Map<String, dynamic>? _findChildDeviceEvidence(Map master, Map device) {
    final dId = device['id']?.toString();
    final cEvList = device['evidences'];
    if (cEvList is List && cEvList.isNotEmpty && cEvList.first is Map) {
      return Map<String, dynamic>.from(cEvList.first as Map);
    }
    final mEvidences = master['evidences'] as List? ?? [];
    for (final e in mEvidences) {
      if (e is Map && e['childDeviceId'] != null && e['childDeviceId'].toString() == dId) {
        return Map<String, dynamic>.from(e);
      }
    }
    return null;
  }

  Future<void> _addSlaveDevice(Map master) async {

    int calcLocalSeq(String type) {
      final devices = (master['childDevices'] as List? ?? [])
          .where((d) => d['type'] == type || (type == 'LIMIT_SWITCH' && d['type'] == 'DEVICE_1') || (type == 'HALL_EFFECT' && d['type'] == 'DEVICE_2'))
          .toList();
      final taken = devices.map((d) => d['deviceSequence'] as int? ?? 0).toSet();
      int next = 1;
      while (taken.contains(next)) {
        next++;
      }
      return next;
    }

    String selectedType = 'LIMIT_SWITCH';
    final seqCtrl = TextEditingController(
      text: calcLocalSeq('LIMIT_SWITCH').toString().padLeft(2, '0'),
    );
    bool isSyncing = false;
    XFile? slavePhoto;
    final ImagePicker picker = ImagePicker();

    Future<void> fetchSeq(String type, void Function(void Function()) setDialogState) async {
      try {
        final res = await http.get(
          Uri.parse('$baseUrl/lcgate/masters/${master['id']}/next-device-sequence?type=$type'),
          headers: {'Authorization': 'Bearer ${widget.token}'},
        ).timeout(const Duration(seconds: 4));
        if (res.statusCode == 200) {
          final data = json.decode(res.body);
          if (data['nextSequence'] != null && selectedType == type) {
            setDialogState(() {
              seqCtrl.text = data['nextSequence'].toString().padLeft(2, '0');
              isSyncing = false;
            });
            return;
          }
        }
      } catch (_) {}
      if (selectedType == type) {
        setDialogState(() => isSyncing = false);
      }
    }

    bool? add = await showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: const Text('Add Slave Device', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Select slave sensor type and attach optional installation proof photo.',
                  style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
                const SizedBox(height: 14),

                // 1. Slave Type Dropdown
                DropdownButtonFormField<String>(
                  value: selectedType,
                  decoration: const InputDecoration(
                    labelText: 'Slave Device Type *',
                    border: OutlineInputBorder(),
                    isDense: true,
                    prefixIcon: Icon(Icons.sensors, color: AppColors.primary),
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'LIMIT_SWITCH',
                      child: Text('A - Limit Switch', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                    DropdownMenuItem(
                      value: 'HALL_EFFECT',
                      child: Text('B - Hall Effect Sensor', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                    DropdownMenuItem(
                      value: 'TILT_SENSOR',
                      child: Text('C - Tilt Sensor', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                  ],
                  onChanged: (val) {
                    if (val != null) {
                      final newType = val;
                      final nextLocal = calcLocalSeq(newType);
                      setDialogState(() {
                        selectedType = newType;
                        seqCtrl.text = nextLocal.toString().padLeft(2, '0');
                        isSyncing = true;
                      });
                      fetchSeq(newType, setDialogState);
                    }
                  },
                ),
                const SizedBox(height: 14),

                // 2. Sequential Identifier Display
                TextField(
                  controller: seqCtrl,
                  readOnly: true,
                  decoration: InputDecoration(
                    labelText: 'Sequential Serial Identifier *',
                    isDense: true,
                    border: const OutlineInputBorder(),
                    prefixText: '${master['serialNumber']}-${getSlaveLetter(selectedType)}-',
                    prefixStyle: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary),
                    suffixIcon: isSyncing
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                    helperText: 'Hardware wired unit under Master ${master['serialNumber']}',
                  ),
                ),
                const SizedBox(height: 14),

                // 3. Photo Upload Section
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF8FAFC),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(
                        children: [
                          Icon(Icons.camera_alt_outlined, size: 16, color: Color(0xFF475569)),
                          SizedBox(width: 6),
                          Text('Installation Photo (Optional)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (slavePhoto == null) ...[
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            onPressed: () async {
                              try {
                                final img = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
                                if (img != null) {
                                  setDialogState(() => slavePhoto = img);
                                }
                              } catch (e) {
                                debugPrint('Camera error: $e');
                              }
                            },
                            icon: const Icon(Icons.camera_alt, size: 16, color: Color(0xFF0B3C7A)),
                            label: const Text('Capture Live Photo (Camera)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0B3C7A))),
                            style: OutlinedButton.styleFrom(
                              side: const BorderSide(color: Color(0xFF0B3C7A)),
                              padding: const EdgeInsets.symmetric(vertical: 10),
                            ),
                          ),
                        ),
                      ] else ...[
                        Row(
                          children: [
                            const Icon(Icons.check_circle, color: Color(0xFF059669), size: 18),
                            const SizedBox(width: 6),
                            const Expanded(
                              child: Text('Photo attached', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF065F46))),
                            ),
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => setDialogState(() => slavePhoto = null),
                              child: const Text('Remove', style: TextStyle(fontSize: 12, color: Colors.red)),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: (isSyncing || seqCtrl.text.isEmpty)
                  ? null
                  : () => Navigator.pop(context, true),
              style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary, foregroundColor: Colors.white),
              child: const Text('Add Slave Unit'),
            ),
          ],
        ),
      ),
    );

    if (add == true) {
      setState(() => _isLoading = true);
      try {
        String? base64Img;
        double? photoLat;
        double? photoLng;
        if (slavePhoto != null) {
          final bytes = await slavePhoto!.readAsBytes();
          base64Img = 'data:image/jpeg;base64,${base64Encode(bytes)}';
          try {
            final pos = await Geolocator.getCurrentPosition(
              locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 4)),
            );
            photoLat = pos.latitude;
            photoLng = pos.longitude;
          } catch (_) {
            photoLat = double.tryParse((gate['latitude'] ?? '0').toString());
            photoLng = double.tryParse((gate['longitude'] ?? '0').toString());
          }
        }

        final res = await http.post(
          Uri.parse('$baseUrl/lcgate/masters/${master['id']}/devices'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ${widget.token}',
          },
          body: json.encode({
            'type': selectedType,
            'deviceSequence': int.tryParse(seqCtrl.text) ?? calcLocalSeq(selectedType),
            if (base64Img != null) 'imageBase64': base64Img,
            if (photoLat != null) 'latitude': photoLat,
            if (photoLng != null) 'longitude': photoLng,
          }),
        );
        if (res.statusCode == 201) {
          await _refresh();
          await _markCacheStale();
          if (mounted) {
            final typeLabel = getSlaveName(selectedType);
            AppFeedback.showSuccess(
              context,
              'Slave device "$typeLabel" added successfully${base64Img != null ? ' with installation photo' : ''}!',
            );
          }
        } else {
          String err = 'Failed to add slave device';
          try {
            final body = json.decode(res.body);
            if (body['error'] != null) err = body['error'];
          } catch (_) {}
          if (mounted) {
            AppFeedback.showError(context, err);
          }
        }
      } catch (e) {
        if (mounted) {
          AppFeedback.showError(context, 'Network error adding slave device: $e');
        }
      } finally {
        if (mounted) setState(() => _isLoading = false);
      }
    }
  }

  String _fullImageUrl(String? url) {
    if (url == null || url.isEmpty) return '';
    String resolved = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      final base = baseUrl;
      final host = base.endsWith('/api/v1') ? base.substring(0, base.length - '/api/v1'.length) : base;
      resolved = '$host$url';
    }
    final separator = resolved.contains('?') ? '&' : '?';
    return '$resolved${separator}_t=${DateTime.now().millisecondsSinceEpoch}';
  }

  void _showZoomPhoto(String url, String title, [dynamic lat, dynamic lng, String? timestamp]) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(
              minScale: 0.5,
              maxScale: 4.0,
              child: Center(
                child: Image.network(
                  url,
                  fit: BoxFit.contain,
                  loadingBuilder: (c, child, progress) {
                    if (progress == null) return child;
                    return const Center(child: CircularProgressIndicator(color: Colors.white));
                  },
                  errorBuilder: (_, __, ___) => const Center(
                    child: Text('Failed to load image', style: TextStyle(color: Colors.white70)),
                  ),
                ),
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white, size: 28),
                onPressed: () => Navigator.pop(ctx),
              ),
            ),
            Positioned(
              bottom: 12,
              left: 12,
              right: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(
                  color: Colors.black87,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
                    if (lat != null && lng != null)
                      Text('GPS: $lat, $lng', style: const TextStyle(color: Colors.white70, fontSize: 11)),
                    if (timestamp != null)
                      Text('Recorded: $timestamp', style: const TextStyle(color: Colors.white60, fontSize: 10)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showViewEvidenceSheet(Map master) {
    final evidences = List<dynamic>.from(master['evidences'] ?? []);
    final childDevices = (master['childDevices'] as List?) ?? [];

    Map? findEv(String category, [int? childId]) {
      for (final e in evidences) {
        if (e is Map) {
          if (childId != null && e['childDeviceId']?.toString() == childId.toString()) return e;
          if (childId == null && e['category'] == category && e['childDeviceId'] == null) return e;
        }
      }
      if (childId != null) {
        for (final c in childDevices) {
          if (c is Map && c['id']?.toString() == childId.toString()) {
            final cEvs = (c['evidences'] as List?) ?? [];
            if (cEvs.isNotEmpty && cEvs.first is Map) return cEvs.first as Map;
          }
        }
      }
      return null;
    }

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setSheetState) {
          void removeEvFromSheet(dynamic ev) {
            final evId = ev?['id']?.toString();
            final cat = ev?['category']?.toString();
            final cId = ev?['childDeviceId']?.toString();
            evidences.removeWhere((e) =>
              (evId != null && e is Map && e['id']?.toString() == evId) ||
              (cId != null && e is Map && e['childDeviceId']?.toString() == cId) ||
              (cId == null && e is Map && e['category'] == cat && e['childDeviceId'] == null)
            );
            setSheetState(() {});
          }

          final masterEv = findEv('MASTER');
          Map? simEv = findEv('SIM_CARD');
          if (simEv == null) {
            final masterDevs = (master['deviceRegistries'] as List?) ?? [];
            final gateDevs = (gate['deviceRegistries'] as List?) ?? [];
            for (final d in [...masterDevs, ...gateDevs]) {
              if (d is Map && d['simPhotoUrl'] != null && d['simPhotoUrl'].toString().trim().isNotEmpty) {
                simEv = {
                  'imageUrl': d['simPhotoUrl'],
                  'category': 'SIM_CARD',
                  'createdAt': d['updatedAt'] ?? d['createdAt'],
                };
                break;
              }
            }
          }
          final powerEv = findEv('POWER_SOURCE');

          Future<void> launchUpload(String category, String targetName, [int? childId]) async {
            final res = await Navigator.push(context, MaterialPageRoute(
              builder: (_) => UploadEvidenceScreen(
                token: widget.token,
                masterId: master['id'],
                childDeviceId: childId,
                category: category,
                targetName: targetName,
              ),
            ));
            if (res != null && res is Map) {
              final resChildId = res['childDeviceId']?.toString();
              final resCat = res['category']?.toString();
              evidences.removeWhere((e) {
                if (e is! Map) return false;
                if (resChildId != null) {
                  return e['childDeviceId']?.toString() == resChildId;
                }
                return e['category'] == resCat && e['childDeviceId'] == null;
              });
              evidences.add(res);
              setSheetState(() {});
              await _refresh();
            }
          }

          return Container(
            height: MediaQuery.of(context).size.height * 0.85,
            decoration: const BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Column(
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 10, bottom: 6),
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(color: Colors.grey.shade300, borderRadius: BorderRadius.circular(2)),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('View Evidence Gallery', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
                          Text('Master #${master['masterSequence']} (${master['serialNumber']})', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                        ],
                      ),
                      IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                    ],
                  ),
                ),
                const Divider(height: 1),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      _buildEvidenceViewTile(
                        title: 'Master Gateway Unit (ESP)',
                        subtitle: 'Serial: ${master['serialNumber']}',
                        icon: Icons.memory,
                        evidence: masterEv,
                        onUpload: () => launchUpload('MASTER', 'Master ESP'),
                        onDelete: masterEv != null ? () => _deleteEvidence(masterEv, 'Master ESP', () => removeEvFromSheet(masterEv)) : null,
                      ),
                      const SizedBox(height: 10),
                      _buildEvidenceViewTile(
                        title: 'Installed SIM Card',
                        subtitle: 'SIM Card & ICCID Hardware Proof',
                        icon: Icons.sim_card_outlined,
                        evidence: simEv,
                        onUpload: () => launchUpload('SIM_CARD', 'SIM Card'),
                        onDelete: simEv != null ? () => _deleteEvidence(simEv!, 'SIM Card', () => removeEvFromSheet(simEv)) : null,
                      ),
                      const SizedBox(height: 10),
                      _buildEvidenceViewTile(
                        title: master['powerSource'] == 'SOLAR' ? 'Solar Power Source' : 'Direct AC Power Source',
                        subtitle: master['powerSource'] == 'SOLAR' ? 'Panels & Battery Installation' : 'Grid AC Power Supply',
                        icon: master['powerSource'] == 'SOLAR' ? Icons.wb_sunny_outlined : Icons.bolt,
                        evidence: powerEv,
                        onUpload: () => launchUpload('POWER_SOURCE', 'Power Source'),
                        onDelete: powerEv != null ? () => _deleteEvidence(powerEv, 'Power Source', () => removeEvFromSheet(powerEv)) : null,
                      ),
                      const SizedBox(height: 14),
                      const Text('CONNECTED SLAVE DEVICES', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B), letterSpacing: 0.5)),
                      const SizedBox(height: 8),
                      if (childDevices.isEmpty)
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(color: Colors.grey.shade50, borderRadius: BorderRadius.circular(8)),
                          child: const Text('No slave devices linked to this master.', style: TextStyle(fontSize: 12, color: Colors.grey)),
                        )
                      else
                        ...childDevices.map((child) {
                          final childId = child['id'] is int ? child['id'] as int : int.tryParse(child['id']?.toString() ?? '');
                          final childType = child['type']?.toString() ?? 'LIMIT_SWITCH';
                          final childEv = findEv(childType, childId);
                          final title = 'Slave #${child['deviceSequence']}: ${getSlaveName(childType)} (${child['serialNumber']})';
                          final subtitle = getSlaveSubtitle(childType);

                          return Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _buildEvidenceViewTile(
                              title: title,
                              subtitle: subtitle,
                              icon: Icons.sensors,
                              evidence: childEv,
                              onUpload: () => launchUpload(childType, title, childId),
                              onDelete: childEv != null ? () => _deleteEvidence(childEv, title, () => removeEvFromSheet(childEv)) : null,
                            ),
                          );
                        }),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildEvidenceViewTile({
    required String title,
    required String subtitle,
    required IconData icon,
    required Map? evidence,
    VoidCallback? onUpload,
    VoidCallback? onDelete,
  }) {
    final hasPhoto = evidence != null && evidence['imageUrl'] != null;
    final imgUrl = hasPhoto ? _fullImageUrl(evidence['imageUrl'].toString()) : '';
    final lat = evidence?['latitude'];
    final lng = evidence?['longitude'];
    final date = evidence?['createdAt']?.toString();

    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: hasPhoto ? const Color(0xFF10B981) : Colors.grey.shade300, width: hasPhoto ? 1.5 : 1),
          boxShadow: const [BoxShadow(color: Color(0x06000000), blurRadius: 4, offset: Offset(0, 1))],
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (hasPhoto)
              InkWell(
                onTap: () => _showZoomPhoto(imgUrl, title, lat, lng, date),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.network(
                    imgUrl,
                    width: 64,
                    height: 64,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      width: 64,
                      height: 64,
                      color: Colors.grey.shade200,
                      child: const Icon(Icons.broken_image, size: 24, color: Colors.grey),
                    ),
                  ),
                ),
              )
            else
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: Colors.grey.shade100,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.grey.shade300),
                ),
                child: Icon(icon, color: Colors.grey.shade400, size: 28),
              ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: hasPhoto ? const Color(0xFFECFDF5) : Colors.grey.shade100,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          hasPhoto ? 'UPLOADED' : 'MISSING',
                          style: TextStyle(
                            fontSize: 9.5,
                            fontWeight: FontWeight.bold,
                            color: hasPhoto ? const Color(0xFF059669) : Colors.grey.shade600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  Text(subtitle, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                  const SizedBox(height: 6),
                  if (hasPhoto) ...[
                    if (lat != null && lng != null)
                      Text('GPS: $lat, $lng', style: const TextStyle(fontSize: 10, color: Color(0xFF0B3C7A), fontWeight: FontWeight.w500)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        OutlinedButton.icon(
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                          ),
                          icon: const Icon(Icons.fullscreen, size: 12, color: Color(0xFF0B3C7A)),
                          label: const Text('View', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF0B3C7A))),
                          onPressed: () => _showZoomPhoto(imgUrl, title, lat, lng, date),
                        ),
                        if (onUpload != null)
                          OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                            ),
                            icon: const Icon(Icons.refresh, size: 12, color: Color(0xFF0E9AA7)),
                            label: const Text('Re-upload', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF0E9AA7))),
                            onPressed: onUpload,
                          ),
                        if (onDelete != null)
                          OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                            ),
                            icon: const Icon(Icons.delete_outline, size: 12, color: Colors.red),
                            label: const Text('Delete', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Colors.red)),
                            onPressed: onDelete,
                          ),
                      ],
                    ),
                  ] else ...[
                    if (onUpload != null) ...[
                      ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF0B3C7A),
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          minimumSize: const Size(90, 28),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                        ),
                        icon: const Icon(Icons.camera_alt, size: 13, color: Colors.white),
                        label: const Text('Upload Photo', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                        onPressed: onUpload,
                      ),
                    ] else ...[
                      const Text('No photo uploaded yet.', style: TextStyle(fontSize: 10.5, color: Colors.grey, fontStyle: FontStyle.italic)),
                    ],
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    List masters = gate['masters'] ?? [];

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(gate['lcNumber'] ?? 'Gate Details', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            Builder(
              builder: (context) {
                final stName = gate['station'] != null
                    ? '${gate['station']['name']} (${gate['station']['code']})'
                    : gate['stationName'];
                return Text(
                  '${gate['locationName'] ?? ''}${stName != null ? " • $stName" : ""}${gate['zone'] != null ? " • ${gate['zone']}" : ""}',
                  style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                  overflow: TextOverflow.ellipsis,
                );
              },
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            tooltip: 'Edit LC Gate',
            onPressed: _showEditGateDialog,
          ),
          IconButton(
            icon: const Icon(Icons.link_outlined),
            tooltip: 'Assign / Unassign Devices',
            onPressed: _showDeviceAssignmentDialog,
          ),
          if (masters.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.wifi_tethering, color: AppColors.primary),
              tooltip: 'Check Connection',
              onPressed: _pingGateDevice,
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh Gate Details',
            onPressed: () => _refresh(isManual: true),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        onPressed: () async {
          final result = await Navigator.push(context, MaterialPageRoute(
            builder: (_) => CreateMasterScreen(token: widget.token, gate: gate)
          ));
          if (!context.mounted) return;
          if (result == true) {
            await _refresh();
            await _markCacheStale();
            if (!context.mounted) return;
            AppFeedback.showSuccess(context, 'New Master Unit created and linked to this gate.');
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('Add Master'),
      ),
      body: _isLoading 
        ? const Center(child: CircularProgressIndicator())
        : RefreshIndicator(
            onRefresh: () => _refresh(isManual: true),
            child: masters.isEmpty
              ? ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    SizedBox(height: 120),
                    Center(child: Text('No Master Units assigned', style: TextStyle(color: Colors.grey, fontSize: 16))),
                  ],
                )
              : ListView.builder(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  itemCount: masters.length,
                  itemBuilder: (context, index) {
                    final master = masters[index];
                    final List devices = master['childDevices'] ?? [];
                    final isSolar = master['powerSource'] == 'SOLAR';
                    
                    return Card(
                      margin: const EdgeInsets.only(bottom: 24),
                      elevation: 2,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        'Master #${master['masterSequence'] ?? (index + 1)}',
                                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary, letterSpacing: 0.5),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        master['serialNumber'] ?? 'Master Unit',
                                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  visualDensity: VisualDensity.compact,
                                  icon: const Icon(Icons.delete_outline, color: Colors.red, size: 20),
                                  tooltip: 'Delete Master Unit',
                                  onPressed: () => _deleteMaster(master),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Row(
                              children: [
                                Icon(
                                  isSolar ? Icons.wb_sunny_outlined : Icons.bolt,
                                  size: 16,
                                  color: isSolar ? Colors.amber.shade700 : Colors.blue.shade700,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  'Power Source: ${isSolar ? "Solar Power" : "Direct Current Supply"}',
                                  style: TextStyle(
                                    color: isSolar ? Colors.amber.shade800 : Colors.blue.shade800,
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            
                            // Connected Slave Devices
                            Container(
                              decoration: BoxDecoration(
                                color: const Color(0xFFF8FAFC),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: const Color(0xFFE2E8F0))
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  Padding(
                                    padding: const EdgeInsets.all(12),
                                    child: Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        const Text('Slave Devices', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF1E293B))),
                                        TextButton.icon(
                                          icon: const Icon(Icons.add, size: 16),
                                          label: const Text('Add Slave', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                          onPressed: () => _addSlaveDevice(master),
                                          style: TextButton.styleFrom(
                                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                            minimumSize: Size.zero,
                                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                          ),
                                        )
                                      ],
                                    ),
                                  ),
                                  const Divider(height: 1, color: Color(0xFFE2E8F0)),
                                  if (devices.isEmpty)
                                    const Padding(
                                      padding: EdgeInsets.all(16),
                                      child: Text('No slave devices added yet.', style: TextStyle(color: Colors.grey, fontStyle: FontStyle.italic, fontSize: 12)),
                                    )
                                  else
                                    ...devices.map((device) {
                                      final dId = device['id'] is int ? device['id'] as int : int.tryParse(device['id']?.toString() ?? '');
                                      final dType = device['type']?.toString() ?? 'LIMIT_SWITCH';
                                      final dSeq = device['deviceSequence']?.toString() ?? '';
                                      final dSerial = device['serialNumber']?.toString() ?? 'Unknown';
                                      final slaveName = getSlaveName(dType);
                                      final slaveSub = getSlaveSubtitle(dType);
                                      final slaveLetter = getSlaveLetter(dType);
                                      final childEv = _findChildDeviceEvidence(master, device);
                                      final hasPhoto = childEv != null && childEv['imageUrl'] != null && childEv['imageUrl'].toString().isNotEmpty;
                                      final imgUrl = hasPhoto ? _fullImageUrl(childEv['imageUrl'].toString()) : '';
                                      final lat = childEv?['latitude'];
                                      final lng = childEv?['longitude'];
                                      final date = childEv?['createdAt']?.toString();
                                      final slaveTitle = 'Slave #$dSeq: $slaveName ($dSerial)';

                                      return Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                        decoration: const BoxDecoration(
                                          border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
                                        ),
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Row(
                                              crossAxisAlignment: CrossAxisAlignment.center,
                                              children: [
                                                Container(
                                                  padding: const EdgeInsets.all(6),
                                                  decoration: BoxDecoration(
                                                    color: Colors.blue.shade50,
                                                    borderRadius: BorderRadius.circular(6),
                                                  ),
                                                  child: const Icon(Icons.sensors, color: Color(0xFF0284C7), size: 18),
                                                ),
                                                const SizedBox(width: 8),
                                                Expanded(
                                                  child: Column(
                                                    crossAxisAlignment: CrossAxisAlignment.start,
                                                    children: [
                                                      Row(
                                                        children: [
                                                          Expanded(
                                                            child: Text(
                                                              'Slave #$dSeq: $dSerial',
                                                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                                                              overflow: TextOverflow.ellipsis,
                                                            ),
                                                          ),
                                                          Container(
                                                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                                            decoration: BoxDecoration(
                                                              color: const Color(0xFFEFF6FF),
                                                              borderRadius: BorderRadius.circular(4),
                                                              border: Border.all(color: const Color(0xFFBFDBFE)),
                                                            ),
                                                            child: Text(
                                                              'TYPE $slaveLetter',
                                                              style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.bold, color: Color(0xFF2563EB)),
                                                            ),
                                                          ),
                                                          const SizedBox(width: 4),
                                                          IconButton(
                                                            icon: const Icon(Icons.delete_outline, color: Colors.red, size: 18),
                                                            onPressed: () => _deleteDevice(device),
                                                            padding: EdgeInsets.zero,
                                                            constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                                                            tooltip: 'Delete Slave Device',
                                                          ),
                                                        ],
                                                      ),
                                                      Text(
                                                        slaveSub,
                                                        style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                              ],
                                            ),
                                            const SizedBox(height: 8),
                                            Container(
                                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                              decoration: BoxDecoration(
                                                color: hasPhoto ? const Color(0xFFF0FDF4) : const Color(0xFFF8FAFC),
                                                borderRadius: BorderRadius.circular(8),
                                                border: Border.all(
                                                  color: hasPhoto ? const Color(0xFFBBF7D0) : const Color(0xFFE2E8F0),
                                                ),
                                              ),
                                              child: Row(
                                                children: [
                                                  if (hasPhoto)
                                                    InkWell(
                                                      onTap: () => _showZoomPhoto(imgUrl, slaveTitle, lat, lng, date),
                                                      child: ClipRRect(
                                                        borderRadius: BorderRadius.circular(6),
                                                        child: Image.network(
                                                          imgUrl,
                                                          width: 42,
                                                          height: 42,
                                                          fit: BoxFit.cover,
                                                          errorBuilder: (_, __, ___) => Container(
                                                            width: 42,
                                                            height: 42,
                                                            color: Colors.grey.shade200,
                                                            child: const Icon(Icons.broken_image, size: 18, color: Colors.grey),
                                                          ),
                                                        ),
                                                      ),
                                                    )
                                                  else
                                                    Container(
                                                      width: 42,
                                                      height: 42,
                                                      decoration: BoxDecoration(
                                                        color: Colors.grey.shade100,
                                                        borderRadius: BorderRadius.circular(6),
                                                        border: Border.all(color: Colors.grey.shade300),
                                                      ),
                                                      child: const Icon(Icons.camera_alt_outlined, color: Colors.grey, size: 18),
                                                    ),
                                                  const SizedBox(width: 8),
                                                  Expanded(
                                                    child: Column(
                                                      crossAxisAlignment: CrossAxisAlignment.start,
                                                      children: [
                                                        Row(
                                                          children: [
                                                            Icon(
                                                              hasPhoto ? Icons.check_circle : Icons.pending_outlined,
                                                              size: 13,
                                                              color: hasPhoto ? const Color(0xFF16A34A) : const Color(0xFFD97706),
                                                            ),
                                                            const SizedBox(width: 4),
                                                            Text(
                                                              hasPhoto ? 'Photo Uploaded' : 'Photo Pending',
                                                              style: TextStyle(
                                                                fontSize: 11,
                                                                fontWeight: FontWeight.bold,
                                                                color: hasPhoto ? const Color(0xFF16A34A) : const Color(0xFFD97706),
                                                              ),
                                                            ),
                                                          ],
                                                        ),
                                                        if (hasPhoto && lat != null && lng != null)
                                                          Text(
                                                            'GPS: ${lat is num ? lat.toStringAsFixed(4) : lat}, ${lng is num ? lng.toStringAsFixed(4) : lng}',
                                                            style: const TextStyle(fontSize: 9.5, color: Color(0xFF64748B)),
                                                          ),
                                                      ],
                                                    ),
                                                  ),
                                                  if (hasPhoto) ...[
                                                    IconButton(
                                                      icon: const Icon(Icons.fullscreen, size: 18, color: Color(0xFF0B3C7A)),
                                                      tooltip: 'View Photo',
                                                      padding: EdgeInsets.zero,
                                                      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                                                      onPressed: () => _showZoomPhoto(imgUrl, slaveTitle, lat, lng, date),
                                                    ),
                                                    IconButton(
                                                      icon: const Icon(Icons.refresh, size: 16, color: Color(0xFF0E9AA7)),
                                                      tooltip: 'Re-upload Photo',
                                                      padding: EdgeInsets.zero,
                                                      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                                                      onPressed: () async {
                                                        final res = await Navigator.push(
                                                          context,
                                                          MaterialPageRoute(
                                                            builder: (_) => UploadEvidenceScreen(
                                                              token: widget.token,
                                                              masterId: master['id'],
                                                              childDeviceId: dId,
                                                              category: dType,
                                                              targetName: slaveTitle,
                                                            ),
                                                          ),
                                                        );
                                                        if (res != null) await _refresh();
                                                      },
                                                    ),
                                                    IconButton(
                                                      icon: const Icon(Icons.delete_outline, size: 16, color: Colors.red),
                                                      tooltip: 'Delete Photo',
                                                      padding: EdgeInsets.zero,
                                                      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                                                      onPressed: () => _deleteEvidence(childEv, slaveTitle, () => _refresh()),
                                                    ),
                                                  ] else ...[
                                                    TextButton.icon(
                                                      icon: const Icon(Icons.camera_alt, size: 12),
                                                      label: const Text('Add Photo', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold)),
                                                      style: TextButton.styleFrom(
                                                        backgroundColor: const Color(0xFF0B3C7A),
                                                        foregroundColor: Colors.white,
                                                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                                        minimumSize: Size.zero,
                                                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                                      ),
                                                      onPressed: () async {
                                                        final res = await Navigator.push(
                                                          context,
                                                          MaterialPageRoute(
                                                            builder: (_) => UploadEvidenceScreen(
                                                              token: widget.token,
                                                              masterId: master['id'],
                                                              childDeviceId: dId,
                                                              category: dType,
                                                              targetName: slaveTitle,
                                                            ),
                                                          ),
                                                        );
                                                        if (res != null) await _refresh();
                                                      },
                                                    ),
                                                  ],
                                                ],
                                              ),
                                            ),
                                          ],
                                        ),
                                      );
                                    }),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                            
                            Row(
                              children: [
                                // 1. VIEW EVIDENCE BUTTON (Shows all devices and slaves)
                                Expanded(
                                  child: ElevatedButton.icon(
                                    icon: const Icon(Icons.visibility_outlined, size: 16),
                                    label: const Text('View Evidence', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: const Color(0xFF0B3C7A),
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(vertical: 12),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                      elevation: 1,
                                    ),
                                    onPressed: () => _showViewEvidenceSheet(master),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                // 2. UPLOAD EVIDENCE BUTTON (Opens checklist / camera capture)
                                Expanded(
                                  child: OutlinedButton.icon(
                                    icon: const Icon(Icons.camera_alt_outlined, size: 16),
                                    label: const Text('Upload Evidence', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                                    style: OutlinedButton.styleFrom(
                                      side: const BorderSide(color: Color(0xFF0B3C7A), width: 1.5),
                                      foregroundColor: const Color(0xFF0B3C7A),
                                      padding: const EdgeInsets.symmetric(vertical: 12),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                    ),
                                    onPressed: () async {
                                      await Navigator.push(context, MaterialPageRoute(
                                        builder: (_) => EvidenceChecklistScreen(
                                          token: widget.token,
                                          master: master,
                                        )
                                      ));
                                      if (!context.mounted) return;
                                      await _refresh();
                                      if (!context.mounted) return;
                                      AppFeedback.showInfo(context, 'Evidence checklist status updated.');
                                    },
                                  ),
                                ),
                              ],
                            )
                          ],
                        ),
                      ),
                    );
                  },
                ),
          ),
    );
  }
}
