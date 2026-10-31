import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';

class CreateMasterScreen extends StatefulWidget {
  final String token;
  final Map gate;

  const CreateMasterScreen({super.key, required this.token, required this.gate});

  @override
  State<CreateMasterScreen> createState() => _CreateMasterScreenState();
}

class _CreateMasterScreenState extends State<CreateMasterScreen> {
  final _seqCtrl = TextEditingController();
  String _powerSource = 'SOLAR';
  bool _isLoading = false;
  String? _seqError;

  // AWS IoT Device Registry Integration
  List<dynamic> _deviceList = [];
  String? _selectedDeviceId;
  bool _isFetchingDevices = true;

  // SIM Card Photo Attachment
  XFile? _simImage;
  final ImagePicker _picker = ImagePicker();

  Future<void> _pickSimImage(ImageSource source) async {
    try {
      final img = await _picker.pickImage(source: source, imageQuality: 85);
      if (img != null && mounted) {
        setState(() => _simImage = img);
      }
    } catch (e) {
      debugPrint('Error picking SIM image: $e');
    }
  }

  @override
  void initState() {
    super.initState();
    _fetchSequence();
    _fetchMasterDevices();
  }

  @override
  void dispose() {
    _seqCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchMasterDevices() async {
    setState(() => _isFetchingDevices = true);
    try {
      // Fetch only eligible unassigned MASTER Things from backend AWS IoT Device Registry
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100&deviceType=MASTER&unassigned=true'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List && mounted) {
          final list = (data['devices'] as List).where((d) => d['masterId'] == null).toList();
          setState(() {
            _deviceList = list;
            _isFetchingDevices = false;
          });
          return;
        }
      }
    } catch (_) {}
    if (mounted) setState(() => _isFetchingDevices = false);
  }

  Future<void> _fetchSequence({bool isManualRetry = false}) async {
    setState(() {
      _seqError = null;
      _seqCtrl.text = '';
    });

    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/${widget.gate['id']}/next-master-sequence'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final nextSeq = data['formattedSequence'] ?? data['nextSequence']?.toString().padLeft(2, '0');
        if (nextSeq != null) {
          if (mounted) {
            setState(() {
              _seqCtrl.text = nextSeq.toString();
            });
            if (isManualRetry) {
              AppFeedback.showSuccess(
                context,
                'Master sequence synchronized: Master #$nextSeq',
              );
            }
          }
          return;
        }
      }
      throw Exception('Server returned invalid sequence');
    } catch (e) {
      debugPrint('Error fetching master sequence: $e');
      if (mounted) {
        setState(() {
          _seqError = 'Could not load next sequence. Tap to retry.';
        });
        if (isManualRetry) {
          AppFeedback.showError(
            context,
            'Unable to synchronize next master sequence. Please retry.',
          );
        }
      }
    }
  }

  Future<void> _submit() async {
    if (_isLoading) return;

    if (_selectedDeviceId == null || _selectedDeviceId!.isEmpty) {
      AppFeedback.showWarning(context, 'Please select a provisioned Master device from AWS IoT Registry.');
      return;
    }

    final dynamic chosenDevice = _deviceList.firstWhere(
      (d) => d['id'].toString() == _selectedDeviceId,
      orElse: () => null,
    );

    if (chosenDevice == null) {
      AppFeedback.showWarning(context, 'Invalid device selection. Please choose an AWS IoT device from the list.');
      return;
    }
    setState(() => _isLoading = true);

    try {
      final seqNum = int.tryParse(_seqCtrl.text) ?? 1;

      final body = <String, dynamic>{
        'masterSequence': seqNum,
        'powerSource': _powerSource,
        'deviceId': chosenDevice['id'],
      };

      final res = await http.post(
        Uri.parse('$baseUrl/lcgate/${widget.gate['id']}/masters'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode(body),
      );

      if (res.statusCode == 201) {
        final masterData = json.decode(res.body);
        final createdMasterId = masterData['id'];

        if (_simImage != null && createdMasterId != null) {
          try {
            final bytes = await _simImage!.readAsBytes();
            final base64Img = 'data:image/jpeg;base64,${base64Encode(bytes)}';

            double? lat;
            double? lng;
            try {
              final pos = await Geolocator.getCurrentPosition(
                locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 4)),
              );
              lat = pos.latitude;
              lng = pos.longitude;
            } catch (_) {
              lat = double.tryParse((widget.gate['latitude'] ?? '0').toString());
              lng = double.tryParse((widget.gate['longitude'] ?? '0').toString());
            }

            await http.post(
              Uri.parse('$baseUrl/evidence'),
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ${widget.token}',
              },
              body: json.encode({
                'masterId': createdMasterId,
                'category': 'SIM_CARD',
                'imageBase64': base64Img,
                'latitude': lat ?? 0.0,
                'longitude': lng ?? 0.0,
              }),
            );
          } catch (e) {
            debugPrint('Failed to upload SIM card evidence: $e');
          }
        }

        if (mounted) {
          final identifier = chosenDevice['thingName'] ?? 'Master Unit';
          AppFeedback.showSuccess(context, 'Master Unit "$identifier" added successfully${_simImage != null ? ' with SIM photo' : ''}.');
          Navigator.pop(context, true);
        }
      } else {
        String errMsg = 'Failed to create master unit';
        try {
          final b = json.decode(res.body);
          if (b['error'] != null) errMsg = b['error'];
        } catch (_) {}
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error: $e');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dynamic chosenDevice = _selectedDeviceId != null && _selectedDeviceId!.isNotEmpty
        ? _deviceList.firstWhere((d) => d['id'].toString() == _selectedDeviceId, orElse: () => null)
        : null;

    final serialPreview = chosenDevice != null
        ? (chosenDevice['thingName'] ?? 'Selected Device').toString()
        : '';

    return Scaffold(
      appBar: AppBar(title: const Text('Add Master Unit', style: TextStyle(fontWeight: FontWeight.bold)), elevation: 0),
      body: SingleChildScrollView(
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
                      'Master Configuration',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Configure Master Unit under Gate ${widget.gate['lcNumber']}',
                      style: const TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
                    ),
                    const SizedBox(height: 20),

                    // 1. Select Provisioned Master from AWS IoT Registry (Mandatory)
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
                                'Select Provisioned Master from Registry *',
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
                            hint: Text(
                              _isFetchingDevices
                                  ? 'Loading available devices...'
                                  : (_deviceList.isEmpty
                                      ? 'No unassigned Master devices found'
                                      : 'Select AWS IoT Thing Name *'),
                              style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                            ),
                            items: _deviceList.map((dev) {
                              final idStr = dev['id'].toString();
                              final tName = (dev['thingName'] ?? 'Device').toString();
                              return DropdownMenuItem<String>(
                                value: idStr,
                                child: Text(
                                  tName,
                                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              );
                            }).toList(),
                            onChanged: (val) {
                              setState(() {
                                _selectedDeviceId = val;
                              });
                            },
                          ),
                          const SizedBox(height: 6),
                          if (!_isFetchingDevices && _deviceList.isEmpty)
                            Container(
                              margin: const EdgeInsets.only(top: 4),
                              padding: const EdgeInsets.all(8),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFFBEB),
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFFFDE68A)),
                              ),
                              child: const Row(
                                children: [
                                  Icon(Icons.info_outline, size: 15, color: Color(0xFFD97706)),
                                  SizedBox(width: 6),
                                  Expanded(
                                    child: Text(
                                      'No unassigned Master devices in registry. Please provision a Master in AWS IoT Core first.',
                                      style: TextStyle(fontSize: 11, color: Color(0xFF92400E)),
                                    ),
                                  ),
                                ],
                              ),
                            )
                          else
                            const Text(
                              'Mandatory: Select an unassigned Master hardware device provisioned in AWS IoT Core.',
                              style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),

                    // 2. Master Serial Identifier Display
                    TextField(
                      readOnly: true,
                      controller: TextEditingController(text: serialPreview),
                      decoration: InputDecoration(
                        labelText: 'Master Serial Identifier *',
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                        prefixIcon: const Icon(Icons.confirmation_number_outlined),
                        filled: true,
                        fillColor: const Color(0xFFF8FAFC),
                        hintText: 'Select an AWS IoT device above',
                        helperText: _seqError ??
                            (chosenDevice != null
                                ? 'Authoritative identifier strictly from AWS IoT Device Registry.'
                                : 'Mandatory: Select a provisioned AWS IoT Master device above.'),
                        helperStyle: TextStyle(
                          color: chosenDevice != null ? const Color(0xFF047857) : const Color(0xFFDC2626),
                          fontWeight: chosenDevice != null ? FontWeight.normal : FontWeight.w500,
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),

                    // 3. Power Source Selector (Single icon, no duplicates)
                    const Text('Power Source *', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: Color(0xFF334155))),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      initialValue: _powerSource,
                      decoration: InputDecoration(
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                        prefixIcon: Icon(
                          _powerSource == 'SOLAR' ? Icons.wb_sunny_outlined : Icons.bolt,
                          color: _powerSource == 'SOLAR' ? Colors.amber.shade700 : Colors.blue.shade700,
                        ),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'SOLAR',
                          child: Text('Solar Power'),
                        ),
                        DropdownMenuItem(
                          value: 'DIRECT',
                          child: Text('Direct Current Supply'),
                        ),
                      ],
                      onChanged: (val) {
                        if (val != null) setState(() => _powerSource = val);
                      },
                    ),
                    const SizedBox(height: 16),

                    // 4. Optional SIM Card Photo
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF0FDF4),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFF86EFAC)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.sim_card_outlined, size: 18, color: Color(0xFF166534)),
                              SizedBox(width: 8),
                              Text(
                                'Upload SIM Card Photo (Optional)',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF166534)),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            'Attach photo of the installed SIM card & ICCID number. You can also view or update it anytime in the Evidence Checklist.',
                            style: TextStyle(fontSize: 11.5, color: Color(0xFF15803D)),
                          ),
                          const SizedBox(height: 10),
                          if (_simImage != null)
                            Row(
                              children: [
                                const Icon(Icons.check_circle, size: 16, color: Color(0xFF16A34A)),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    'Selected: ${_simImage!.name}',
                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF166534)),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.close, size: 18, color: Colors.red),
                                  onPressed: () => setState(() => _simImage = null),
                                ),
                              ],
                            )
                          else
                            Row(
                              children: [
                                Expanded(
                                  child: OutlinedButton.icon(
                                    icon: const Icon(Icons.camera_alt_outlined, size: 16),
                                    label: const Text('Camera', style: TextStyle(fontSize: 12)),
                                    onPressed: () => _pickSimImage(ImageSource.camera),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: OutlinedButton.icon(
                                    icon: const Icon(Icons.photo_library_outlined, size: 16),
                                    label: const Text('Gallery', style: TextStyle(fontSize: 12)),
                                    onPressed: () => _pickSimImage(ImageSource.gallery),
                                  ),
                                ),
                              ],
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),

                    // 5. Submit Button
                    ElevatedButton(
                      onPressed: (_isLoading || _selectedDeviceId == null || _selectedDeviceId!.isEmpty || chosenDevice == null)
                          ? null
                          : _submit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      ),
                      child: _isLoading
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Create Master Unit', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white)),
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
