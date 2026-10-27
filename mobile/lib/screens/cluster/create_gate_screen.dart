import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:geolocator/geolocator.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import 'railway_data.dart';

class CreateGateScreen extends StatefulWidget {
  final String token;
  const CreateGateScreen({super.key, required this.token});

  @override
  State<CreateGateScreen> createState() => _CreateGateScreenState();
}

class _CreateGateScreenState extends State<CreateGateScreen> {
  final _locationNameCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _lcNumberCtrl = TextEditingController();
  final _latCtrl = TextEditingController();
  final _lngCtrl = TextEditingController();

  List<String> _zones = RailwayData.zones;
  Map<String, List<String>> _divisionsByZone = RailwayData.data;
  String? _zone;
  String? _division;
  bool _loadingReference = true;

  bool _isLoading = false;
  bool _isFetchingLocation = false;

  // Device Registry Integration (Parity with Web CreateGateForm)
  List<dynamic> _deviceList = [];
  String? _selectedDeviceId;

  @override
  void initState() {
    super.initState();
    _fetchReferenceData();
    _fetchDevicesFromRegistry();
  }

  @override
  void dispose() {
    _locationNameCtrl.dispose();
    _nameCtrl.dispose();
    _lcNumberCtrl.dispose();
    _latCtrl.dispose();
    _lngCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchReferenceData() async {
    setState(() => _loadingReference = true);
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/reference-data'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map) {
          final zones = (data['zones'] as List?)?.whereType<String>().toList() ?? [];
          final divisionsRaw = data['divisionsByZone'];
          if (zones.isNotEmpty && mounted) {
            setState(() {
              _zones = zones;
              if (divisionsRaw is Map) {
                _divisionsByZone = divisionsRaw.map(
                  (k, v) => MapEntry(k.toString(), (v as List).whereType<String>().toList()),
                );
              }
            });
          }
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Unable to load railway zones reference: $e');
      }
    } finally {
      if (mounted) setState(() => _loadingReference = false);
    }
  }

  Future<void> _fetchDevicesFromRegistry() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List && mounted) {
          setState(() {
            _deviceList = data['devices'] as List;
          });
        }
      }
    } catch (_) {}
  }

  void _onDeviceSelected(String? devId) {
    setState(() {
      _selectedDeviceId = devId;
      if (devId != null && devId.isNotEmpty) {
        final dev = _deviceList.firstWhere((d) => d['id'].toString() == devId, orElse: () => null);
        if (dev != null && _nameCtrl.text.isEmpty) {
          _nameCtrl.text = dev['thingName'] ?? '';
        }
      }
    });
  }

  Future<void> _getCurrentLocation() async {
    setState(() => _isFetchingLocation = true);
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) throw Exception('Location services are disabled.');

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) throw Exception('Location permissions are denied');
      }

      if (permission == LocationPermission.deniedForever) {
        throw Exception('Location permissions are permanently denied.');
      }

      Position position = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
      if (mounted) {
        setState(() {
          _latCtrl.text = position.latitude.toString();
          _lngCtrl.text = position.longitude.toString();
        });
        AppFeedback.showSuccess(
          context,
          'GPS location acquired: ${position.latitude.toStringAsFixed(5)}, ${position.longitude.toStringAsFixed(5)}',
        );
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, e.toString().replaceAll('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _isFetchingLocation = false);
    }
  }

  Future<void> _submit() async {
    final dynamic chosenDev = _selectedDeviceId != null && _selectedDeviceId!.isNotEmpty
        ? _deviceList.firstWhere((d) => d['id'].toString() == _selectedDeviceId, orElse: () => null)
        : null;

    if (_locationNameCtrl.text.trim().isEmpty) {
      AppFeedback.showWarning(context, 'Location Name is required.');
      return;
    }
    if (_zone == null || _zone!.isEmpty) {
      AppFeedback.showWarning(context, 'Please select a Railway Zone.');
      return;
    }
    if (_division == null || _division!.isEmpty) {
      AppFeedback.showWarning(context, 'Please select a Division.');
      return;
    }

    if (chosenDev == null && _lcNumberCtrl.text.trim().isEmpty) {
      AppFeedback.showWarning(context, 'Please enter an LC Number or select a Device from Registry.');
      return;
    }

    setState(() => _isLoading = true);
    try {
      final lat = double.tryParse(_latCtrl.text);
      final lng = double.tryParse(_lngCtrl.text);

      final gateLcNumber = chosenDev != null
          ? chosenDev['thingName'].toString()
          : 'LC-${_lcNumberCtrl.text.trim()}';

      final body = <String, dynamic>{
        'locationName': _locationNameCtrl.text.trim(),
        'name': _nameCtrl.text.trim().isNotEmpty ? _nameCtrl.text.trim() : null,
        'lcNumber': gateLcNumber,
        'zone': _zone,
        'division': _division,
      };

      if (chosenDev != null) {
        body['deviceId'] = chosenDev['id'];
      }
      if (lat != null) body['latitude'] = lat;
      if (lng != null) body['longitude'] = lng;

      final res = await http.post(
        Uri.parse('$baseUrl/lcgate'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode(body),
      );

      if (res.statusCode == 201) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'LC Gate "$gateLcNumber" created successfully.');
          Navigator.pop(context, true);
        }
      } else {
        String errMsg = 'Failed to create LC Gate.';
        try {
          final err = json.decode(res.body);
          if (err['error'] != null) {
            errMsg = err['error'];
          } else if (err['message'] != null) {
            errMsg = err['message'];
          }
        } catch (_) {
          errMsg = 'Server returned HTTP ${res.statusCode}';
        }
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error creating LC Gate: $e');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final divisions = _zone != null ? (_divisionsByZone[_zone] ?? <String>[]) : <String>[];
    final dynamic chosenDev = _selectedDeviceId != null && _selectedDeviceId!.isNotEmpty
        ? _deviceList.firstWhere((d) => d['id'].toString() == _selectedDeviceId, orElse: () => null)
        : null;

    return Scaffold(
      appBar: AppBar(title: const Text('Create LC Gate', style: TextStyle(fontWeight: FontWeight.bold)), elevation: 0),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Theme.of(context).primaryColor.withValues(alpha: 0.05), Colors.white],
          ),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Card(
            elevation: 2,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Gate Information', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),

                  // 1. Device Registry Integration Card
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.05),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.primary.withValues(alpha: 0.2)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.developer_board, size: 18, color: AppColors.primary),
                            SizedBox(width: 8),
                            Text(
                              'Select Provisioned Device from Registry',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.primary),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        DropdownButtonFormField<String>(
                          initialValue: _selectedDeviceId,
                          isExpanded: true,
                          decoration: InputDecoration(
                            isDense: true,
                            fillColor: Colors.white,
                            filled: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                          ),
                          hint: const Text('— Select from Registry (or enter manual LC# below) —', style: TextStyle(fontSize: 12)),
                          items: [
                            const DropdownMenuItem<String>(
                              value: '',
                              child: Text('— None (Manual LC Number) —', style: TextStyle(fontSize: 12)),
                            ),
                            ..._deviceList.map((dev) {
                              final idStr = dev['id'].toString();
                              final tName = (dev['thingName'] ?? 'Device').toString();
                              final dType = (dev['deviceType'] ?? 'MASTER').toString();
                              final gateInfo = dev['gate'] != null ? '[Assigned to ${dev['gate']['lcNumber']}]' : '★ [Unassigned]';
                              return DropdownMenuItem<String>(
                                value: idStr,
                                child: Text(
                                  '$tName ($dType) $gateInfo',
                                  style: const TextStyle(fontSize: 12),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              );
                            }),
                          ],
                          onChanged: _onDeviceSelected,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          chosenDev != null
                              ? 'Using "${chosenDev['thingName']}" as the Gate ID & cluster identifier.'
                              : 'Optionally pick an unassigned IoT Thing to adopt its hardware identifier automatically.',
                          style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),

                  // 2. Gate Identifier / Manual LC#
                  if (chosenDev != null)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.developer_board, size: 20, color: Color(0xFF2563EB)),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text('Gate / Cluster Identifier (Hardware)', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                                Text(
                                  chosenDev['thingName'] ?? '',
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF1E40AF)),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    TextField(
                      controller: _lcNumberCtrl,
                      decoration: InputDecoration(
                        labelText: 'LC Number (Manual) *',
                        prefixText: 'LC - ',
                        prefixStyle: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                        prefixIcon: const Icon(Icons.numbers),
                        hintText: '0001',
                      ),
                    ),
                  const SizedBox(height: 14),

                  // 3. Railway Zone & Division
                  DropdownButtonFormField<String>(
                    initialValue: _zone,
                    decoration: InputDecoration(
                      labelText: 'Railway Zone *',
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      prefixIcon: const Icon(Icons.map_outlined),
                    ),
                    items: _zones.map((z) => DropdownMenuItem(value: z, child: Text(z, overflow: TextOverflow.ellipsis))).toList(),
                    onChanged: _loadingReference
                        ? null
                        : (val) {
                            setState(() {
                              _zone = val;
                              _division = null;
                            });
                          },
                  ),
                  const SizedBox(height: 14),

                  DropdownButtonFormField<String>(
                    initialValue: _division,
                    decoration: InputDecoration(
                      labelText: 'Division *',
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      prefixIcon: const Icon(Icons.account_tree_outlined),
                    ),
                    items: divisions.map((d) => DropdownMenuItem(value: d, child: Text(d, overflow: TextOverflow.ellipsis))).toList(),
                    onChanged: (_zone == null) ? null : (val) => setState(() => _division = val),
                    hint: Text(_zone == null ? 'Select Zone first…' : 'Select Division…'),
                  ),
                  const SizedBox(height: 14),

                  // 4. Gate Name & Location Description
                  TextField(
                    controller: _nameCtrl,
                    decoration: InputDecoration(
                      labelText: 'Gate Name (Optional)',
                      hintText: 'e.g. North Crossing Gate',
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      prefixIcon: const Icon(Icons.label_outline),
                    ),
                  ),
                  const SizedBox(height: 14),

                  TextField(
                    controller: _locationNameCtrl,
                    decoration: InputDecoration(
                      labelText: 'Location Description *',
                      hintText: 'e.g. KM 42 Near Station X',
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      prefixIcon: const Icon(Icons.location_city_outlined),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // 5. GPS Coordinates Box
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
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Text('GPS Coordinates', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF334155))),
                            TextButton.icon(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              icon: _isFetchingLocation
                                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                  : const Icon(Icons.my_location, size: 16),
                              label: const Text('Auto-fill GPS', style: TextStyle(fontSize: 12)),
                              onPressed: _isFetchingLocation ? null : _getCurrentLocation,
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _latCtrl,
                                decoration: InputDecoration(
                                  labelText: 'Latitude',
                                  isDense: true,
                                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                ),
                                keyboardType: TextInputType.number,
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextField(
                                controller: _lngCtrl,
                                decoration: InputDecoration(
                                  labelText: 'Longitude',
                                  isDense: true,
                                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                ),
                                keyboardType: TextInputType.number,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // 6. Submit Button
                  ElevatedButton(
                    onPressed: _isLoading ? null : _submit,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    child: _isLoading
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Create LC Gate', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
