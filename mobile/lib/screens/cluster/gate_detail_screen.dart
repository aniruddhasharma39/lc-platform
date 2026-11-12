import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
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
import '../../utils/user_utils.dart';
import '../../components/action_feedback_widgets.dart';
import '../../services/home_cache_service.dart';
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
  String _busyMessage = '';
  final Set<String> _deletingEvidenceIds = {};
  final Set<int> _unassigningMasterIds = {};
  final Set<int> _deletingDeviceIds = {};
  final Set<int> _pingingMasterIds = {};

  @override
  void initState() {
    super.initState();
    gate = widget.gate;
  }

  Future<void> _pingGateDevice({int? masterId, String? thingName, String? unitLabel}) async {
    final gateId = gate['id'];
    if (gateId == null) return;
    if (masterId != null && _pingingMasterIds.contains(masterId)) return;

    final lcNumber = gate['lcNumber'] ?? 'LC Gate';
    final targetDesc = unitLabel != null ? '$lcNumber · $unitLabel' : '$lcNumber hardware';

    if (masterId != null) {
      setState(() => _pingingMasterIds.add(masterId));
    }
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/lcgate/$gateId/health-check'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Content-Type': 'application/json',
        },
        body: json.encode({
          if (masterId != null) 'masterId': masterId,
          if (thingName != null) 'thingName': thingName,
        }),
      ).timeout(const Duration(seconds: 10));

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          final isDelivered = data['mqttDelivered'] == true;
          if (isDelivered) {
            AppFeedback.showSuccess(
              context,
              'Health check ping sent to $targetDesc via AWS IoT MQTT.',
            );
          } else {
            AppFeedback.showError(
              context,
              data['message']?.toString() ?? 'Could not reach AWS IoT Core broker for $targetDesc.',
            );
          }
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
    } finally {
      if (mounted && masterId != null) {
        setState(() => _pingingMasterIds.remove(masterId));
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
        final rawGateData = data is Map ? (data['cluster'] ?? data['gate'] ?? data) : null;
        if (rawGateData is Map && mounted) {
          final gateData = Map<String, dynamic>.from(rawGateData);
          if (data is Map) {
            for (final k in ['isOnline', 'deviceStatus', 'onlineMastersCount', 'hardwareMastersCount', 'currentStatus', 'status', 'lastSeenAt', 'isConfigured']) {
              if (data.containsKey(k) && data[k] != null && gateData[k] == null) {
                gateData[k] = data[k];
              }
            }
          }
          setState(() => gate = gateData);
          if (isManual) {
            AppFeedback.showSuccess(context, 'Gate and device details refreshed.');
          }
          try {
            final userId = await loadCurrentUserId();
            LCGatesCacheService.instance.patchGate(userId, gateData);
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
    final evId = evidence['id'];
    final evKey = evId?.toString() ?? itemTitle;
    if (_deletingEvidenceIds.contains(evKey)) return;

    bool isDeleting = false;
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setDialogState) => PopScope(
          canPop: !isDeleting,
          child: AlertDialog(
            title: Text('Delete Photo for "$itemTitle"?'),
            content: const Text('Are you sure you want to delete this uploaded photo? This cannot be undone.'),
            actions: [
              TextButton(
                onPressed: isDeleting ? null : () => Navigator.pop(dialogCtx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  disabledBackgroundColor: Colors.red.shade300,
                  disabledForegroundColor: Colors.white,
                ),
                onPressed: isDeleting
                    ? null
                    : () async {
                        setDialogState(() => isDeleting = true);
                        if (mounted) {
                          setState(() => _deletingEvidenceIds.add(evKey));
                        }
                        try {
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
                            await _refresh();
                            if (mounted) {
                              setState(() => _deletingEvidenceIds.remove(evKey));
                            }
                            if (dialogCtx.mounted) Navigator.pop(dialogCtx, true);
                            if (onDeleted != null) onDeleted();
                            if (mounted) {
                              AppFeedback.showSuccess(this.context, 'Photo deleted successfully.');
                            }
                          } else {
                            if (mounted) {
                              setState(() => _deletingEvidenceIds.remove(evKey));
                              AppFeedback.showError(this.context, 'Failed to delete photo: ${res.body}');
                            }
                            if (dialogCtx.mounted) setDialogState(() => isDeleting = false);
                          }
                        } catch (e) {
                          if (mounted) {
                            setState(() => _deletingEvidenceIds.remove(evKey));
                            AppFeedback.showError(this.context, 'Error deleting photo: $e');
                          }
                          if (dialogCtx.mounted) setDialogState(() => isDeleting = false);
                        }
                      },
                child: ActionButtonContent(
                  isLoading: isDeleting,
                  loadingLabel: 'Deleting Photo...',
                  idleLabel: 'Delete',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _markCacheStale() async {
    try {
      final userId = await loadCurrentUserId();
      await LCGatesCacheService.instance.markStale(userId);
      await HomeCacheService.instance.clearUserCache(userId);
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
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => PopScope(
          canPop: !isSubmitting,
          child: AlertDialog(
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
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.75),
                disabledForegroundColor: Colors.white,
              ),
              onPressed: isSubmitting ? null : () async {
                final lcNum = lcCtrl.text.trim();
                if (lcNum.isEmpty) {
                  AppFeedback.showWarning(this.context, 'LC Gate Number is required.');
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
                    }
                    await _refresh();
                    await _markCacheStale();
                    if (dialogCtx.mounted) Navigator.pop(dialogCtx);
                    if (mounted) {
                      AppFeedback.showSuccess(this.context, 'LC Gate updated successfully.');
                    }
                  } else {
                    String err = 'Failed to update LC Gate';
                    try {
                      final b = json.decode(res.body);
                      if (b['error'] != null) err = b['error'];
                    } catch (_) {}
                    if (mounted) AppFeedback.showError(this.context, err);
                    if (dialogCtx.mounted) setModalState(() => isSubmitting = false);
                  }
                } catch (e) {
                  if (mounted) AppFeedback.showError(this.context, 'Network error updating gate: $e');
                  if (dialogCtx.mounted) setModalState(() => isSubmitting = false);
                }
              },
              child: ActionButtonContent(
                isLoading: isSubmitting,
                loadingLabel: 'Updating LC Gate...',
                idleLabel: 'Save Changes',
                textStyle: const TextStyle(color: Colors.white),
              ),
            ),
          ],
        ),
      ),
      ),
    );
  }

  Future<void> _showAssignModalForMaster(Map<String, dynamic> master) async {
    setState(() {
      _busyMessage = 'Loading available AWS IoT Things...';
      _isLoading = true;
    });
    List unassignedDevices = [];
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100&deviceType=MASTER&unassigned=true'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List) {
          unassignedDevices = (data['devices'] as List).where((d) => d['masterId'] == null).toList();
        }
      }
    } catch (_) {}
    if (mounted) {
      setState(() {
        _isLoading = false;
        _busyMessage = '';
      });
    }

    String? selectedDeviceId;
    bool isAssigning = false;
    final mSeq = master['masterSequence'] ?? 1;

    if (!mounted) return;

    await showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => PopScope(
          canPop: !isAssigning,
          child: AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          title: Row(
            children: [
              const Icon(Icons.memory, color: AppColors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text('Assign Hardware: Master Unit $mSeq', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ),
            ],
          ),
          content: SizedBox(
            width: 440,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Select an unassigned AWS IoT Thing from the registry to link with Master Unit $mSeq of Gate ${gate['lcNumber']}.',
                  style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
                const SizedBox(height: 16),
                if (unassignedDevices.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFFBEB),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFFDE68A)),
                    ),
                    child: const Text(
                      'No unassigned Master hardware devices available in AWS IoT Registry. Please provision a Thing in AWS IoT Core first.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF92400E)),
                    ),
                  )
                else ...[
                  const Text('AVAILABLE AWS IOT MASTER THINGS', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: Color(0xFF475569))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    value: selectedDeviceId,
                    isExpanded: true,
                    hint: const Text('Select AWS IoT Thing', style: TextStyle(fontSize: 12.5)),
                    decoration: InputDecoration(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    items: unassignedDevices.map((d) => DropdownMenuItem<String>(
                      value: d['id'].toString(),
                      child: Text('${d['thingName']} (Type: ${d['deviceType'] ?? 'MASTER'})', style: const TextStyle(fontSize: 12.5), overflow: TextOverflow.ellipsis),
                    )).toList(),
                    onChanged: isAssigning ? null : (val) => setModalState(() => selectedDeviceId = val),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: isAssigning ? null : () => Navigator.pop(dialogCtx),
              child: const Text('Cancel'),
            ),
            if (unassignedDevices.isNotEmpty)
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.7),
                  disabledForegroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: (isAssigning || selectedDeviceId == null) ? null : () async {
                  final chosenDev = unassignedDevices.firstWhere((d) => d['id'].toString() == selectedDeviceId);
                  setModalState(() => isAssigning = true);
                  try {
                    final res = await http.post(
                      Uri.parse('$baseUrl/lcgate/${gate['id']}/assign-device'),
                      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${widget.token}'},
                      body: json.encode({'deviceId': chosenDev['id'], 'masterId': master['id']}),
                    );
                    if (res.statusCode == 200) {
                      await _refresh();
                      await _markCacheStale();
                      if (dialogCtx.mounted) Navigator.pop(dialogCtx);
                      if (mounted) AppFeedback.showSuccess(this.context, 'AWS IoT Thing assigned successfully.');
                    } else {
                      String err = 'Failed to assign AWS IoT Thing.';
                      try {
                        final b = json.decode(res.body);
                        if (b['error'] != null) err = b['error'];
                      } catch (_) {}
                      if (mounted) AppFeedback.showError(this.context, err);
                      if (dialogCtx.mounted) setModalState(() => isAssigning = false);
                    }
                  } catch (e) {
                    if (mounted) AppFeedback.showError(this.context, 'Error assigning AWS IoT Thing: $e');
                    if (dialogCtx.mounted) setModalState(() => isAssigning = false);
                  }
                },
                child: ActionButtonContent(
                  isLoading: isAssigning,
                  loadingLabel: 'Assigning AWS IoT Thing...',
                  idleLabel: 'Assign to Master',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
          ],
          ),
        ),
      ),
    );
  }

  Future<void> _unassignMasterDevice(Map<String, dynamic> dev, Map<String, dynamic> master) async {
    final mSeq = master['masterSequence'] ?? 1;
    final mId = master['id'] is int ? master['id'] as int : int.tryParse(master['id']?.toString() ?? '');
    if (mId != null && _unassigningMasterIds.contains(mId)) return;

    bool isUnassigning = false;
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (c, setModalState) => PopScope(
          canPop: !isUnassigning,
          child: AlertDialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            title: const Text('Unassign Hardware Device?'),
            content: Text('Unassign physical AWS IoT Thing "${dev['thingName']}" from Master Unit $mSeq?\n\nThe physical device will return to the unassigned registry pool.'),
            actions: [
              TextButton(
                onPressed: isUnassigning ? null : () => Navigator.pop(dialogCtx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: Colors.red.shade300,
                  disabledForegroundColor: Colors.white,
                ),
                onPressed: isUnassigning
                    ? null
                    : () async {
                        setModalState(() => isUnassigning = true);
                        if (mounted && mId != null) {
                          setState(() => _unassigningMasterIds.add(mId));
                        }
                        try {
                          final res = await http.post(
                            Uri.parse('$baseUrl/lcgate/${gate['id']}/unassign-device'),
                            headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ${widget.token}'},
                            body: json.encode({'deviceId': dev['id']}),
                          );
                          if (res.statusCode == 200) {
                            await _refresh();
                            await _markCacheStale();
                            if (mounted && mId != null) {
                              setState(() => _unassigningMasterIds.remove(mId));
                            }
                            if (dialogCtx.mounted) Navigator.pop(dialogCtx, true);
                            if (mounted) AppFeedback.showSuccess(context, 'AWS IoT Thing unassigned successfully.');
                          } else {
                            if (mounted && mId != null) {
                              setState(() => _unassigningMasterIds.remove(mId));
                            }
                            if (mounted) AppFeedback.showError(context, 'Failed to unassign AWS IoT Thing.');
                            if (dialogCtx.mounted) setModalState(() => isUnassigning = false);
                          }
                        } catch (e) {
                          if (mounted && mId != null) {
                            setState(() => _unassigningMasterIds.remove(mId));
                          }
                          if (mounted) AppFeedback.showError(context, 'Error unassigning AWS IoT Thing: $e');
                          if (dialogCtx.mounted) setModalState(() => isUnassigning = false);
                        }
                      },
                child: ActionButtonContent(
                  isLoading: isUnassigning,
                  loadingLabel: 'Unassigning AWS IoT Thing...',
                  idleLabel: 'Unassign',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _deleteMaster(Map master) async {
    final ctrl = TextEditingController();
    final serial = (master['serialNumber'] ?? '').toString();
    bool isDeleting = false;

    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => PopScope(
          canPop: !isDeleting,
          child: AlertDialog(
            title: const Text('Delete Master Unit?', style: TextStyle(color: Colors.red)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('This action cannot be undone. This will permanently delete the Master Unit, and all of its Slave Devices and evidence.'),
                const SizedBox(height: 16),
                Text('Please type "$serial" to confirm:'),
                const SizedBox(height: 8),
                TextField(
                  controller: ctrl,
                  enabled: !isDeleting,
                  decoration: const InputDecoration(border: OutlineInputBorder()),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: isDeleting ? null : () => Navigator.pop(dialogCtx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  disabledBackgroundColor: Colors.red.shade300,
                  disabledForegroundColor: Colors.white,
                ),
                onPressed: isDeleting
                    ? null
                    : () async {
                        if (ctrl.text.trim() != serial) {
                          AppFeedback.showWarning(
                            this.context,
                            'Serial number does not match "$serial". Deletion aborted.',
                          );
                          return;
                        }
                        setModalState(() => isDeleting = true);
                        try {
                          final res = await http.delete(
                            Uri.parse('$baseUrl/lcgate/masters/${master['id']}'),
                            headers: {'Authorization': 'Bearer ${widget.token}'},
                          );
                          if (res.statusCode == 204 || res.statusCode == 200) {
                            await _refresh();
                            await _markCacheStale();
                            if (dialogCtx.mounted) Navigator.pop(dialogCtx, true);
                            if (mounted) {
                              AppFeedback.showSuccess(this.context, 'Master Unit deleted successfully.');
                            }
                          } else {
                            String errMsg = 'Failed to delete Master Unit';
                            try {
                              final err = json.decode(res.body);
                              if (err['error'] != null) errMsg = err['error'];
                            } catch (_) {}
                            if (mounted) AppFeedback.showError(this.context, errMsg);
                            if (dialogCtx.mounted) setModalState(() => isDeleting = false);
                          }
                        } catch (e) {
                          if (mounted) {
                            AppFeedback.showError(this.context, 'Network error deleting Master Unit: $e');
                          }
                          if (dialogCtx.mounted) setModalState(() => isDeleting = false);
                        }
                      },
                child: ActionButtonContent(
                  isLoading: isDeleting,
                  loadingLabel: 'Deleting Master Unit...',
                  idleLabel: 'Delete Master Unit',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    ctrl.dispose();
  }

  Future<void> _deleteDevice(Map device) async {
    final devId = device['id'] is int ? device['id'] as int : int.tryParse(device['id']?.toString() ?? '');
    if (devId != null && _deletingDeviceIds.contains(devId)) return;

    final serial = (device['serialNumber'] ?? 'Unknown').toString();
    final deviceTypeName = device['type'] == 'DEVICE_1' ? 'Device 1 (Hall Effect + Limit Switch)' : 'Device 2 (Tilt Sensor)';
    bool isDeleting = false;

    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setModalState) => PopScope(
          canPop: !isDeleting,
          child: AlertDialog(
            title: Text('Delete Slave Device "$serial"?'),
            content: Text('Are you sure you want to permanently delete this $deviceTypeName?'),
            actions: [
              TextButton(
                onPressed: isDeleting ? null : () => Navigator.pop(dialogCtx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  disabledBackgroundColor: Colors.red.shade300,
                  disabledForegroundColor: Colors.white,
                ),
                onPressed: isDeleting
                    ? null
                    : () async {
                        setModalState(() => isDeleting = true);
                        if (mounted && devId != null) {
                          setState(() => _deletingDeviceIds.add(devId));
                        }
                        try {
                          final res = await http.delete(
                            Uri.parse('$baseUrl/lcgate/devices/${device['id']}'),
                            headers: {'Authorization': 'Bearer ${widget.token}'},
                          );
                          if (res.statusCode == 204 || res.statusCode == 200) {
                            await _refresh();
                            await _markCacheStale();
                            if (mounted && devId != null) {
                              setState(() => _deletingDeviceIds.remove(devId));
                            }
                            if (dialogCtx.mounted) Navigator.pop(dialogCtx, true);
                            if (mounted) {
                              AppFeedback.showSuccess(this.context, 'Slave Device deleted successfully.');
                            }
                          } else {
                            String errMsg = 'Failed to delete slave device';
                            try {
                              final err = json.decode(res.body);
                              if (err['error'] != null) errMsg = err['error'];
                            } catch (_) {}
                            if (mounted && devId != null) {
                              setState(() => _deletingDeviceIds.remove(devId));
                            }
                            if (mounted) AppFeedback.showError(this.context, errMsg);
                            if (dialogCtx.mounted) setModalState(() => isDeleting = false);
                          }
                        } catch (e) {
                          if (mounted && devId != null) {
                            setState(() => _deletingDeviceIds.remove(devId));
                          }
                          if (mounted) {
                            AppFeedback.showError(this.context, 'Network error deleting slave device: $e');
                          }
                          if (dialogCtx.mounted) setModalState(() => isDeleting = false);
                        }
                      },
                child: ActionButtonContent(
                  isLoading: isDeleting,
                  loadingLabel: 'Deleting Slave Device...',
                  idleLabel: 'Delete',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
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
    bool isAdding = false;
    bool isCapturingPhoto = false;
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

    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogCtx) => StatefulBuilder(
        builder: (context, setDialogState) => PopScope(
          canPop: !isAdding && !isCapturingPhoto,
          child: AlertDialog(
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
                    onChanged: isAdding
                        ? null
                        : (val) {
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
                              onPressed: (isAdding || isCapturingPhoto)
                                  ? null
                                  : () async {
                                      setDialogState(() => isCapturingPhoto = true);
                                      try {
                                        final img = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
                                        if (img != null) {
                                          if (dialogCtx.mounted) setDialogState(() => slavePhoto = img);
                                          if (mounted) AppFeedback.showSuccess(this.context, 'Photo captured successfully.');
                                        }
                                      } catch (e) {
                                        debugPrint('Camera error: $e');
                                        if (mounted) AppFeedback.showError(this.context, 'Failed to capture photo: $e');
                                      } finally {
                                        if (dialogCtx.mounted) setDialogState(() => isCapturingPhoto = false);
                                      }
                                    },
                              icon: isCapturingPhoto
                                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                  : const Icon(Icons.camera_alt, size: 16, color: Color(0xFF0B3C7A)),
                              label: Text(
                                isCapturingPhoto ? 'Capturing Photo...' : 'Capture Live Photo (Camera)',
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF0B3C7A)),
                              ),
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
                                child: Text('Photo captured & ready', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF065F46))),
                              ),
                              TextButton(
                                style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                                onPressed: isAdding ? null : () => setDialogState(() => slavePhoto = null),
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
              TextButton(
                onPressed: (isAdding || isCapturingPhoto) ? null : () => Navigator.pop(dialogCtx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: (isAdding || isCapturingPhoto || isSyncing || seqCtrl.text.isEmpty)
                    ? null
                    : () async {
                        setDialogState(() => isAdding = true);
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
                            if (dialogCtx.mounted) Navigator.pop(dialogCtx, true);
                            if (mounted) {
                              AppFeedback.showSuccess(
                                this.context,
                                'Slave Device added successfully.',
                              );
                            }
                          } else {
                            String err = 'Failed to add slave device';
                            try {
                              final body = json.decode(res.body);
                              if (body['error'] != null) err = body['error'];
                            } catch (_) {}
                            if (mounted) AppFeedback.showError(this.context, err);
                            if (dialogCtx.mounted) setDialogState(() => isAdding = false);
                          }
                        } catch (e) {
                          if (mounted) AppFeedback.showError(this.context, 'Network error adding slave device: $e');
                          if (dialogCtx.mounted) setDialogState(() => isAdding = false);
                        }
                      },
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.7),
                  disabledForegroundColor: Colors.white,
                ),
                child: ActionButtonContent(
                  isLoading: isAdding,
                  loadingLabel: 'Adding Slave Device...',
                  idleLabel: 'Add Slave Unit',
                  textStyle: const TextStyle(color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    seqCtrl.dispose();
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
      useSafeArea: true,
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

          Future<void> launchUpload(String category, String targetName, [int? childId, bool isReupload = false]) async {
            final res = await Navigator.push(context, MaterialPageRoute(
              builder: (_) => UploadEvidenceScreen(
                token: widget.token,
                masterId: master['id'],
                childDeviceId: childId,
                category: category,
                targetName: targetName,
                isReupload: isReupload,
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
                          Text('Master Unit ${master['masterSequence']} (${(master['serialNumber'] ?? '').toString().replaceAll(RegExp(r'^#+'), '')})', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
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
                        onUpload: () => launchUpload('MASTER', 'Master ESP', null, masterEv != null),
                        onDelete: masterEv != null ? () => _deleteEvidence(masterEv, 'Master ESP', () => removeEvFromSheet(masterEv)) : null,
                      ),
                      const SizedBox(height: 10),
                      _buildEvidenceViewTile(
                        title: 'Installed SIM Card',
                        subtitle: 'SIM Card & ICCID Hardware Proof',
                        icon: Icons.sim_card_outlined,
                        evidence: simEv,
                        onUpload: () => launchUpload('SIM_CARD', 'SIM Card', null, simEv != null),
                        onDelete: simEv != null ? () => _deleteEvidence(simEv!, 'SIM Card', () => removeEvFromSheet(simEv)) : null,
                      ),
                      const SizedBox(height: 10),
                      _buildEvidenceViewTile(
                        title: master['powerSource'] == 'SOLAR' ? 'Solar Power Source' : 'Direct AC Power Source',
                        subtitle: master['powerSource'] == 'SOLAR' ? 'Panels & Battery Installation' : 'Grid AC Power Supply',
                        icon: master['powerSource'] == 'SOLAR' ? Icons.wb_sunny_outlined : Icons.bolt,
                        evidence: powerEv,
                        onUpload: () => launchUpload('POWER_SOURCE', 'Power Source', null, powerEv != null),
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
                          final cleanChildSerial = (child['serialNumber'] ?? '').toString().replaceAll(RegExp(r'^#+'), '');
                          final title = 'Sensor Unit ${child['deviceSequence']}: ${getSlaveName(childType)} ($cleanChildSerial)';
                          final subtitle = getSlaveSubtitle(childType);

                          return Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _buildEvidenceViewTile(
                              title: title,
                              subtitle: subtitle,
                              icon: Icons.sensors,
                              evidence: childEv,
                              onUpload: () => launchUpload(childType, title, childId, childEv != null),
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

    return ActionBusyOverlay(
      isBusy: _isLoading,
      message: _busyMessage.isNotEmpty ? _busyMessage : 'Loading...',
      child: Scaffold(
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
          }
        },
        icon: const Icon(Icons.add),
        label: const Text('Add Master'),
      ),
      body: RefreshIndicator(
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
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
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
                                        'Master Unit ${master['masterSequence'] ?? (index + 1)}',
                                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.primary, letterSpacing: 0.5),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        (master['serialNumber'] ?? 'Master Unit').toString().replaceAll(RegExp(r'^#+'), ''),
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
                            const SizedBox(height: 14),

                            // Master AWS IoT Hardware Assignment Card
                            Builder(
                              builder: (context) {
                                final masterDevs = (master['deviceRegistries'] as List?) ?? [];
                                final gateDevs = (gate['deviceRegistries'] as List?) ?? [];
                                final matchingDev = masterDevs.isNotEmpty
                                    ? masterDevs.first
                                    : gateDevs.firstWhere(
                                        (d) => d is Map && (
                                          (d['masterId'] != null && d['masterId'] == master['id']) ||
                                          (d['thingName'] != null && (
                                            d['thingName'] == master['serialNumber'] ||
                                            d['thingName'] == master['serialNumber']?.toString().replaceAll(RegExp(r'^#+'), '')
                                          ))
                                        ),
                                        orElse: () => null,
                                      );

                                if (matchingDev != null) {
                                  final rawConn = (matchingDev['connectivityStatus'] ?? matchingDev['computedStatus'] ?? '').toString().toUpperCase();
                                  final isDevOnline = rawConn.isNotEmpty
                                      ? rawConn == 'ONLINE'
                                      : (matchingDev['lastSeenAt'] != null &&
                                          DateTime.now().difference(DateTime.tryParse(matchingDev['lastSeenAt'].toString()) ?? DateTime(1970)).inMinutes <= 65);
                                  final devStatus = isDevOnline ? 'ONLINE' : 'OFFLINE';
                                  return Container(
                                    margin: const EdgeInsets.only(bottom: 14),
                                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFF0FDF4),
                                      borderRadius: BorderRadius.circular(10),
                                      border: Border.all(color: const Color(0xFFBBF7D0)),
                                    ),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.stretch,
                                      children: [
                                        Row(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Container(
                                              padding: const EdgeInsets.all(6),
                                              decoration: BoxDecoration(
                                                color: const Color(0xFFDCFCE7),
                                                borderRadius: BorderRadius.circular(6),
                                              ),
                                              child: const Icon(Icons.memory, size: 18, color: Color(0xFF16A34A)),
                                            ),
                                            const SizedBox(width: 10),
                                            Expanded(
                                              child: Column(
                                                crossAxisAlignment: CrossAxisAlignment.start,
                                                children: [
                                                  Wrap(
                                                    spacing: 6,
                                                    runSpacing: 4,
                                                    crossAxisAlignment: WrapCrossAlignment.center,
                                                    children: [
                                                      const Text(
                                                        'ASSIGNED AWS IOT THING',
                                                        style: TextStyle(
                                                          fontSize: 10,
                                                          fontWeight: FontWeight.w800,
                                                          letterSpacing: 0.5,
                                                          color: Color(0xFF15803D),
                                                        ),
                                                      ),
                                                      Container(
                                                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                        decoration: BoxDecoration(
                                                          color: isDevOnline ? const Color(0xFFDCFCE7) : const Color(0xFFFEE2E2),
                                                          borderRadius: BorderRadius.circular(4),
                                                        ),
                                                        child: Text(
                                                          devStatus,
                                                          style: TextStyle(
                                                            fontSize: 9,
                                                            fontWeight: FontWeight.bold,
                                                            color: isDevOnline ? const Color(0xFF15803D) : const Color(0xFFB91C1C),
                                                          ),
                                                        ),
                                                      ),
                                                    ],
                                                  ),
                                                  const SizedBox(height: 3),
                                                  Text(
                                                    '${matchingDev['thingName'] ?? 'Unknown'}',
                                                    style: const TextStyle(
                                                      fontSize: 14,
                                                      fontWeight: FontWeight.bold,
                                                      color: Color(0xFF0F172A),
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ],
                                        ),
                                        const SizedBox(height: 10),
                                        Builder(
                                          builder: (context) {
                                            final mIdInt = master['id'] is int ? master['id'] as int : int.tryParse(master['id']?.toString() ?? '');
                                            final isPinging = mIdInt != null && _pingingMasterIds.contains(mIdInt);
                                            final isUnassigning = mIdInt != null && _unassigningMasterIds.contains(mIdInt);
                                            return Row(
                                              mainAxisAlignment: MainAxisAlignment.end,
                                              children: [
                                                OutlinedButton.icon(
                                                  style: OutlinedButton.styleFrom(
                                                    foregroundColor: const Color(0xFF0284C7),
                                                    side: const BorderSide(color: Color(0xFFBAE6FD)),
                                                    backgroundColor: Colors.white,
                                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                                    minimumSize: Size.zero,
                                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                                  ),
                                                  onPressed: (isPinging || isUnassigning)
                                                      ? null
                                                      : () => _pingGateDevice(
                                                            masterId: mIdInt,
                                                            thingName: matchingDev['thingName']?.toString(),
                                                            unitLabel: 'Master ${master['masterSequence'] ?? ''} (${matchingDev['thingName'] ?? ''})',
                                                          ),
                                                  icon: isPinging
                                                      ? const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2))
                                                      : const Icon(Icons.wifi_tethering, size: 13),
                                                  label: Text(isPinging ? 'Pinging...' : 'Ping', style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
                                                ),
                                                const SizedBox(width: 8),
                                                OutlinedButton(
                                                  style: OutlinedButton.styleFrom(
                                                    foregroundColor: const Color(0xFFDC2626),
                                                    side: const BorderSide(color: Color(0xFFFECACA)),
                                                    backgroundColor: Colors.white,
                                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                                    minimumSize: Size.zero,
                                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                                  ),
                                                  onPressed: (isUnassigning || isPinging)
                                                      ? null
                                                      : () => _unassignMasterDevice(matchingDev, master),
                                                  child: Text(
                                                    isUnassigning ? 'Unassigning...' : 'Unassign',
                                                    style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold),
                                                  ),
                                                ),
                                              ],
                                            );
                                          },
                                        ),
                                      ],
                                    ),
                                  );
                                }

                                return Container(
                                  margin: const EdgeInsets.only(bottom: 14),
                                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFF8FAFC),
                                    borderRadius: BorderRadius.circular(10),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: Row(
                                    children: [
                                      Container(
                                        padding: const EdgeInsets.all(6),
                                        decoration: BoxDecoration(
                                          color: const Color(0xFFF1F5F9),
                                          borderRadius: BorderRadius.circular(6),
                                        ),
                                        child: const Icon(Icons.developer_board_off, size: 18, color: Color(0xFF64748B)),
                                      ),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: const [
                                            Text(
                                              'VIRTUAL MASTER UNIT',
                                              style: TextStyle(
                                                fontSize: 10,
                                                fontWeight: FontWeight.w800,
                                                letterSpacing: 0.5,
                                                color: Color(0xFF64748B),
                                              ),
                                            ),
                                            SizedBox(height: 1),
                                            Text(
                                              'No physical AWS IoT Thing linked',
                                              style: TextStyle(
                                                fontSize: 11.5,
                                                color: Color(0xFF475569),
                                                fontWeight: FontWeight.w500,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                      ElevatedButton.icon(
                                        icon: const Icon(Icons.add_link, size: 14),
                                        label: const Text('Assign Thing', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: AppColors.primary,
                                          foregroundColor: Colors.white,
                                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                          minimumSize: Size.zero,
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                          elevation: 0,
                                        ),
                                        onPressed: () => _showAssignModalForMaster(master),
                                      ),
                                    ],
                                  ),
                                );
                              },
                            ),
                            
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
                                      final cleanDSerial = dSerial.replaceAll(RegExp(r'^#+'), '');
                                      final slaveTitle = 'Sensor Unit $dSeq: $slaveName ($cleanDSerial)';

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
                                                              'Sensor Unit $dSeq: $cleanDSerial',
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
                                                              isReupload: true,
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
                                                              isReupload: false,
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
      ),
    );
  }
}
