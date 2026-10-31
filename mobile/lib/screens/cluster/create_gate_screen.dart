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
  final _lcNumberCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _locationNameCtrl = TextEditingController();
  final _latCtrl = TextEditingController();
  final _lngCtrl = TextEditingController();

  List<String> _zones = RailwayData.zones;
  Map<String, List<String>> _divisionsByZone = RailwayData.data;
  String? _zone;
  String? _division;
  bool _loadingReference = true;

  bool _isLoading = false;
  bool _isFetchingLocation = false;

  @override
  void initState() {
    super.initState();
    _fetchReferenceData();
  }

  @override
  void dispose() {
    _lcNumberCtrl.dispose();
    _nameCtrl.dispose();
    _locationNameCtrl.dispose();
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

      Position position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      );
      if (mounted) {
        setState(() {
          _latCtrl.text = position.latitude.toString();
          _lngCtrl.text = position.longitude.toString();
        });
        AppFeedback.showSuccess(
          context,
          'GPS coordinates acquired: ${position.latitude.toStringAsFixed(5)}, ${position.longitude.toStringAsFixed(5)}',
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
    if (_isLoading) return;

    final rawLc = _lcNumberCtrl.text.trim();
    if (rawLc.isEmpty) {
      AppFeedback.showWarning(context, 'LC Number is mandatory. Please enter a valid number.');
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

    if (_locationNameCtrl.text.trim().isEmpty) {
      AppFeedback.showWarning(context, 'Location Description is mandatory.');
      return;
    }

    setState(() => _isLoading = true);
    try {
      final cleanLc = rawLc.toUpperCase().startsWith('LC-')
          ? rawLc.toUpperCase()
          : 'LC-${rawLc.toUpperCase()}';

      final lat = double.tryParse(_latCtrl.text);
      final lng = double.tryParse(_lngCtrl.text);

      final body = <String, dynamic>{
        'lcNumber': cleanLc,
        'locationName': _locationNameCtrl.text.trim(),
        'name': _nameCtrl.text.trim().isNotEmpty ? _nameCtrl.text.trim() : null,
        'zone': _zone,
        'division': _division,
      };

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
          AppFeedback.showSuccess(context, 'LC Gate "$cleanLc" created successfully.');
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

    return Scaffold(
      appBar: AppBar(
        title: const Text('Create LC Gate', style: TextStyle(fontWeight: FontWeight.bold)),
        elevation: 0,
      ),
      body: _loadingReference
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 500),
                  child: Card(
                    elevation: 2,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text(
                            'Gate Information',
                            style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            'Enter railway infrastructure specifications for this Level Crossing.',
                            style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
                          ),
                          const SizedBox(height: 20),

                          // 1. Mandatory Manual LC Number
                          TextField(
                            controller: _lcNumberCtrl,
                            textCapitalization: TextCapitalization.characters,
                            decoration: InputDecoration(
                              labelText: 'LC Number (Manual) *',
                              hintText: 'e.g. LC-M-001 or 001',
                              prefixIcon: const Icon(Icons.tag),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                              helperText: 'Mandatory railway identifier. Must be unique.',
                            ),
                          ),
                          const SizedBox(height: 16),

                          // 2. Railway Zone Dropdown
                          DropdownButtonFormField<String>(
                            value: _zone,
                            decoration: InputDecoration(
                              labelText: 'Railway Zone *',
                              prefixIcon: const Icon(Icons.map_outlined),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            items: _zones
                                .map((z) => DropdownMenuItem(value: z, child: Text(z, overflow: TextOverflow.ellipsis)))
                                .toList(),
                            onChanged: (val) {
                              setState(() {
                                _zone = val;
                                _division = null;
                              });
                            },
                          ),
                          const SizedBox(height: 16),

                          // 3. Division Dropdown
                          DropdownButtonFormField<String>(
                            value: _division,
                            decoration: InputDecoration(
                              labelText: 'Division *',
                              prefixIcon: const Icon(Icons.account_tree_outlined),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            items: divisions
                                .map((d) => DropdownMenuItem(value: d, child: Text(d, overflow: TextOverflow.ellipsis)))
                                .toList(),
                            onChanged: _zone == null
                                ? null
                                : (val) {
                                    setState(() => _division = val);
                                  },
                            hint: Text(_zone == null ? 'Select Zone first...' : 'Select Division'),
                          ),
                          const SizedBox(height: 16),

                          // 4. Optional Gate Name
                          TextField(
                            controller: _nameCtrl,
                            decoration: InputDecoration(
                              labelText: 'Gate Name (Optional)',
                              hintText: 'e.g. Sangli North Crossing',
                              prefixIcon: const Icon(Icons.label_outline),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                          ),
                          const SizedBox(height: 16),

                          // 5. Mandatory Location Description
                          TextField(
                            controller: _locationNameCtrl,
                            decoration: InputDecoration(
                              labelText: 'Location Description *',
                              hintText: 'e.g. Sangli (Central Railway) KM 24/8',
                              prefixIcon: const Icon(Icons.location_city_outlined),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                          ),
                          const SizedBox(height: 20),

                          // 6. GPS Coordinates
                          Container(
                            padding: const EdgeInsets.all(14),
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
                                    const Text('GPS Coordinates', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                                    TextButton.icon(
                                      onPressed: _isFetchingLocation ? null : _getCurrentLocation,
                                      icon: _isFetchingLocation
                                          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                          : const Icon(Icons.my_location, size: 16),
                                      label: Text(
                                        _isFetchingLocation ? 'Acquiring...' : 'Auto-fill GPS',
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Row(
                                  children: [
                                    Expanded(
                                      child: TextField(
                                        controller: _latCtrl,
                                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                        decoration: InputDecoration(
                                          labelText: 'Latitude',
                                          isDense: true,
                                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: TextField(
                                        controller: _lngCtrl,
                                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                        decoration: InputDecoration(
                                          labelText: 'Longitude',
                                          isDense: true,
                                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 24),

                          // 7. Submit Button
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
            ),
    );
  }
}
