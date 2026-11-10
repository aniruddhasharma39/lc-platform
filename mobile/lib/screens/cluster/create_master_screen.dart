import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../../components/action_feedback_widgets.dart';

class CreateMasterScreen extends StatefulWidget {
  final String token;
  final Map gate;

  const CreateMasterScreen({super.key, required this.token, required this.gate});

  @override
  State<CreateMasterScreen> createState() => _CreateMasterScreenState();
}

class _CreateMasterScreenState extends State<CreateMasterScreen> {
  final _seqCtrl = TextEditingController();
  final _serialCtrl = TextEditingController();
  String _powerSource = 'SOLAR';
  bool _isLoading = false;
  bool _isFetchingSeq = true;
  String? _seqError;

  // AWS IoT Device Registry Integration
  List<dynamic> _deviceList = [];
  String? _selectedDeviceId;
  bool _isFetchingDevices = true;

  // SIM Card Photo Attachment
  XFile? _simImage;
  final ImagePicker _picker = ImagePicker();
  bool _isCapturingSimPhoto = false;
  String _submitPhaseLabel = 'Creating Master Unit...';

  Future<void> _pickSimImage(ImageSource source) async {
    if (_isLoading || _isCapturingSimPhoto) return;
    setState(() => _isCapturingSimPhoto = true);
    try {
      final img = await _picker.pickImage(source: source, imageQuality: 85);
      if (!mounted) return;
      if (img != null) {
        setState(() => _simImage = img);
        AppFeedback.showSuccess(context, 'Photo captured successfully.');
      }
    } catch (e) {
      debugPrint('Error picking SIM image: $e');
      if (mounted) {
        AppFeedback.showError(context, 'Failed to capture photo: $e');
      }
    } finally {
      if (mounted) setState(() => _isCapturingSimPhoto = false);
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
    _serialCtrl.dispose();
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
      _isFetchingSeq = true;
      _seqError = null;
      _seqCtrl.text = '';
      _serialCtrl.text = '';
    });

    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate/${widget.gate['id']}/next-master-sequence'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        final nextSeq = data['formattedSequence'] ?? data['nextSequence']?.toString().padLeft(2, '0');
        final nextSerial = data['nextSerialNumber']?.toString() ?? '${widget.gate['lcNumber']}-$nextSeq';
        if (nextSeq != null) {
          if (mounted) {
            setState(() {
              _isFetchingSeq = false;
              _seqCtrl.text = nextSeq.toString();
              _serialCtrl.text = nextSerial;
            });
            if (isManualRetry) {
              AppFeedback.showSuccess(
                context,
                'Master sequence synchronized: $nextSerial',
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
          _isFetchingSeq = false;
          _seqError = 'Could not load next sequence. Tap retry.';
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

    final dynamic chosenDevice = _selectedDeviceId != null && _selectedDeviceId!.isNotEmpty
        ? _deviceList.firstWhere(
            (d) => d['id'].toString() == _selectedDeviceId,
            orElse: () => null,
          )
        : null;

    setState(() {
      _isLoading = true;
      _submitPhaseLabel = 'Creating Master Unit...';
    });

    try {
      final seqNum = int.tryParse(_seqCtrl.text);
      final body = <String, dynamic>{
        if (seqNum != null) 'masterSequence': seqNum,
        'powerSource': _powerSource,
        'autoGenerate': true,
        if (_serialCtrl.text.trim().isNotEmpty) 'serialNumber': _serialCtrl.text.trim(),
      };

      if (chosenDevice != null) {
        body['deviceId'] = chosenDevice['id'];
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
        bool simUploadFailed = false;

        if (_simImage != null && createdMasterId != null) {
          if (mounted) {
            setState(() => _submitPhaseLabel = 'Uploading Photo...');
          }
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

            final evRes = await http.post(
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
            if (evRes.statusCode != 201 && evRes.statusCode != 200) {
              simUploadFailed = true;
            }
          } catch (e) {
            debugPrint('Failed to upload SIM card evidence: $e');
            simUploadFailed = true;
          }
        }

        if (mounted) {
          if (simUploadFailed) {
            AppFeedback.showWarning(
              context,
              'Master Unit created successfully, but SIM photo upload failed. Please upload it in the Evidence Checklist.',
            );
          } else {
            AppFeedback.showSuccess(
              context,
              _simImage != null
                  ? 'Master Unit created and SIM photo uploaded successfully.'
                  : 'Master Unit created successfully.',
            );
          }
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

    return PopScope(
      canPop: !_isLoading && !_isCapturingSimPhoto,
      child: Scaffold(
        appBar: AppBar(
          automaticallyImplyLeading: !_isLoading && !_isCapturingSimPhoto,
          title: const Text('Add Master Unit', style: TextStyle(fontWeight: FontWeight.bold)),
          elevation: 0,
        ),
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
                                'Link AWS IoT Master Device (Optional)',
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
                                      : 'Virtual Master (Assign Hardware Later)'),
                              style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                            ),
                            items: [
                              const DropdownMenuItem<String>(
                                value: '',
                                child: Text('Virtual Master (Assign Hardware Later)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF64748B))),
                              ),
                              ..._deviceList.map((dev) {
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
                            }),
                            ],
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
                              'Optional: Select an unassigned Master hardware device or leave virtual to assign later.',
                              style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),

                    // 2. Auto-Generated Master Serial Identifier Display
                    TextField(
                      controller: _serialCtrl,
                      readOnly: true,
                      style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      decoration: InputDecoration(
                        labelText: 'Master Serial Identifier (Auto-Generated)',
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
                        prefixIcon: const Icon(Icons.confirmation_number_outlined),
                        suffixIcon: _isFetchingSeq
                            ? const Padding(
                                padding: EdgeInsets.all(12),
                                child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                              )
                            : (_seqError != null
                                ? IconButton(
                                    icon: const Icon(Icons.refresh, color: Colors.orange),
                                    tooltip: 'Retry sequence fetch',
                                    onPressed: () => _fetchSequence(isManualRetry: true),
                                  )
                                : Container(
                                    margin: const EdgeInsets.all(8),
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFE0F2FE),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: const Text(
                                      'AUTO',
                                      style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Color(0xFF0369A1)),
                                    ),
                                  )),
                        filled: true,
                        fillColor: const Color(0xFFF1F5F9),
                        hintText: _isFetchingSeq ? 'Generating next ID...' : 'e.g. ${widget.gate['lcNumber']}-01',
                        helperText: _seqError ??
                            (chosenDevice != null
                                ? 'Hardware Mapped: ${chosenDevice['thingName']} (AWS IoT Core)'
                                : 'Automatically incremented per gate. AWS IoT hardware can be linked anytime.'),
                        helperStyle: TextStyle(
                          color: chosenDevice != null ? const Color(0xFF047857) : const Color(0xFF64748B),
                          fontWeight: FontWeight.normal,
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
                            SizedBox(
                              width: double.infinity,
                              child: OutlinedButton.icon(
                                icon: _isCapturingSimPhoto
                                    ? const SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2))
                                    : const Icon(Icons.camera_alt_outlined, size: 16),
                                label: Text(
                                  _isCapturingSimPhoto ? 'Capturing Photo...' : 'Capture Live Photo (Camera)',
                                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold),
                                ),
                                onPressed: (_isLoading || _isCapturingSimPhoto) ? null : () => _pickSimImage(ImageSource.camera),
                                style: OutlinedButton.styleFrom(
                                  padding: const EdgeInsets.symmetric(vertical: 10),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),

                    // 5. Submit Button
                    ElevatedButton(
                      onPressed: (_isLoading || _isCapturingSimPhoto) ? null : _submit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.75),
                        disabledForegroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      ),
                      child: ActionButtonContent(
                        isLoading: _isLoading,
                        loadingLabel: _submitPhaseLabel,
                        idleLabel: 'Create Master Unit',
                        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
      ),
    );
  }
}
