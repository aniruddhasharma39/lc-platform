import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:io' as io;
import 'package:flutter/foundation.dart' show kIsWeb;
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
  final _seqCtrl = TextEditingController(text: '');
  String _powerSource = 'SOLAR';
  bool _isLoading = false;
  bool _isFetchingSequence = true;
  String? _seqError;

  // Device Registry Integration (Parity with Web CreateMasterForm)
  List<dynamic> _deviceList = [];
  String? _selectedDeviceId;

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
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/devices?limit=100&deviceType=MASTER'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map && data['devices'] is List && mounted) {
          final list = data['devices'] as List;
          setState(() {
            _deviceList = list;
            // Auto-select if a master device matches this gate's LC number
            final gateLc = (widget.gate['lcNumber'] ?? '').toString();
            final matching = list.firstWhere(
              (d) =>
                  (d['thingName']?.toString().startsWith(gateLc) ?? false) &&
                  (d['gateId'] == null || d['gateId'] == widget.gate['id']) &&
                  d['masterId'] == null,
              orElse: () => null,
            );
            if (matching != null) {
              _selectedDeviceId = matching['id'].toString();
            }
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _fetchSequence({bool isManualRetry = false}) async {
    setState(() {
      _isFetchingSequence = true;
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
        if (data['nextSequence'] != null) {
          if (mounted) {
            setState(() {
              _seqCtrl.text = data['nextSequence'].toString().padLeft(2, '0');
              _isFetchingSequence = false;
            });
            if (isManualRetry) {
              AppFeedback.showSuccess(
                context,
                'Master sequence synchronized: Sequence #${data['nextSequence']}',
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
          _isFetchingSequence = false;
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
    final dynamic chosenDevice = _selectedDeviceId != null && _selectedDeviceId!.isNotEmpty
        ? _deviceList.firstWhere((d) => d['id'].toString() == _selectedDeviceId, orElse: () => null)
        : null;

    if (chosenDevice == null && (_seqCtrl.text.isEmpty || _isFetchingSequence)) {
      AppFeedback.showWarning(context, 'Master sequence is not ready yet. Please wait or retry.');
      return;
    }
    setState(() => _isLoading = true);

    try {
      final body = <String, dynamic>{
        'masterSequence': int.tryParse(_seqCtrl.text) ?? 1,
        'powerSource': _powerSource,
      };

      if (chosenDevice != null) {
        body['deviceId'] = chosenDevice['id'];
        body['serialNumber'] = chosenDevice['thingName'];
      }

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
                locationSettings: const LocationSettings(timeLimit: Duration(seconds: 4)),
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
          final identifier = chosenDevice != null
              ? chosenDevice['thingName']
              : '${widget.gate['lcNumber']}-${_seqCtrl.text}';
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
        AppFeedback.showError(context, 'Network error creating master unit: $e');
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

    final canSubmit = !_isLoading && (chosenDevice != null || (!_isFetchingSequence && _seqCtrl.text.isNotEmpty));

    final serialPreview = chosenDevice != null
        ? chosenDevice['thingName'].toString()
        : '${widget.gate['lcNumber']}-${_seqCtrl.text.isEmpty ? "01" : _seqCtrl.text}';

    return Scaffold(
      appBar: AppBar(title: const Text('Add Master Unit', style: TextStyle(fontWeight: FontWeight.bold)), elevation: 0),
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
                  const Text('Master Configuration', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),

                  // 1. Device Registry Selector Card
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.05),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.primary.withValues(alpha: 0.15)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.developer_board, size: 18, color: AppColors.primary),
                            SizedBox(width: 8),
                            Text(
                              'Select Provisioned Master from Registry',
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
                            '— Auto-generate sequence (${widget.gate['lcNumber']}-${_seqCtrl.text.isEmpty ? "01" : _seqCtrl.text}) —',
                            style: const TextStyle(fontSize: 12),
                          ),
                          items: [
                            DropdownMenuItem<String>(
                              value: '',
                              child: Text(
                                '— Auto-generate sequence (${widget.gate['lcNumber']}-${_seqCtrl.text.isEmpty ? "01" : _seqCtrl.text}) —',
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                            ..._deviceList.map((dev) {
                              final idStr = dev['id'].toString();
                              final tName = (dev['thingName'] ?? 'Master').toString();
                              final assigned = dev['gate'] != null ? '[Assigned to ${dev['gate']['lcNumber']}]' : '[Unassigned]';
                              final fw = dev['firmwareVersion'] != null ? '(${dev['firmwareVersion']})' : '';
                              return DropdownMenuItem<String>(
                                value: idStr,
                                child: Text(
                                  '$tName $assigned $fw',
                                  style: const TextStyle(fontSize: 12),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              );
                            }),
                          ],
                          onChanged: (val) => setState(() => _selectedDeviceId = val),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          chosenDevice != null
                              ? 'Using exact Thing Name "${chosenDevice['thingName']}" from Device Registry.'
                              : 'Select a Thing registered via Fleet Provisioning / IoT Core to use its exact identifier.',
                          style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
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
                      helperText: _seqError ??
                          (chosenDevice != null
                              ? 'Using exact Thing Name from Device Registry.'
                              : 'Auto-generated sequence based on gate LC number.'),
                      helperStyle: _seqError != null ? const TextStyle(color: Colors.red) : null,
                    ),
                  ),
                  const SizedBox(height: 16),

                  // 3. Power Source Selector
                  const Text('Power Source *', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: Color(0xFF334155))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    initialValue: _powerSource,
                    decoration: InputDecoration(
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                      prefixIcon: Icon(
                        _powerSource == 'SOLAR' ? Icons.wb_sunny_outlined : Icons.bolt,
                        color: _powerSource == 'SOLAR' ? Colors.amber : Colors.blue,
                      ),
                    ),
                    items: const [
                      DropdownMenuItem(
                        value: 'SOLAR',
                        child: Row(
                          children: [
                            Icon(Icons.wb_sunny_outlined, size: 18, color: Colors.amber),
                            SizedBox(width: 8),
                            Text('Solar Power'),
                          ],
                        ),
                      ),
                      DropdownMenuItem(
                        value: 'DIRECT',
                        child: Row(
                          children: [
                            Icon(Icons.bolt, size: 18, color: Colors.blue),
                            SizedBox(width: 8),
                            Text('Direct Current Supply'),
                          ],
                        ),
                      ),
                    ],
                    onChanged: (val) {
                      if (val != null) setState(() => _powerSource = val);
                    },
                  ),
                  const SizedBox(height: 16),

                  // Optional SIM Card Photo
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
                              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: Color(0xFF166534)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Attach photo of the installed SIM card & ICCID number. You can also view or update it anytime in the Evidence Checklist.',
                          style: TextStyle(fontSize: 11, color: Color(0xFF475569)),
                        ),
                        const SizedBox(height: 10),
                        if (_simImage != null)
                          Row(
                            children: [
                              ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: kIsWeb
                                    ? Image.network(_simImage!.path, width: 64, height: 64, fit: BoxFit.cover)
                                    : Image.file(io.File(_simImage!.path), width: 64, height: 64, fit: BoxFit.cover),
                              ),
                              const SizedBox(width: 12),
                              TextButton.icon(
                                onPressed: () => setState(() => _simImage = null),
                                icon: const Icon(Icons.delete_outline, size: 18, color: Colors.red),
                                label: const Text('Remove', style: TextStyle(color: Colors.red, fontSize: 12)),
                              ),
                            ],
                          )
                        else
                          Row(
                            children: [
                              OutlinedButton.icon(
                                onPressed: () => _pickSimImage(ImageSource.camera),
                                icon: const Icon(Icons.camera_alt, size: 16),
                                label: const Text('Camera', style: TextStyle(fontSize: 12)),
                              ),
                              const SizedBox(width: 8),
                              OutlinedButton.icon(
                                onPressed: () => _pickSimImage(ImageSource.gallery),
                                icon: const Icon(Icons.photo_library, size: 16),
                                label: const Text('Gallery', style: TextStyle(fontSize: 12)),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 28),

                  // 5. Submit Button
                  ElevatedButton(
                    onPressed: canSubmit ? _submit : null,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    child: _isLoading
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text(
                            'Create Master Unit',
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white),
                          ),
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
