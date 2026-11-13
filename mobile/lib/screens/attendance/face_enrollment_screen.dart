import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import '../../config.dart';
import '../../widgets/face_scanner_overlay.dart';

class FaceEnrollmentScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final String token;
  final VoidCallback? onEnrollmentComplete;

  const FaceEnrollmentScreen({
    super.key,
    required this.user,
    required this.token,
    this.onEnrollmentComplete,
  });

  @override
  State<FaceEnrollmentScreen> createState() => _FaceEnrollmentScreenState();
}

class _FaceEnrollmentScreenState extends State<FaceEnrollmentScreen> {
  final ImagePicker _picker = ImagePicker();

  bool _isLoading = false;
  bool _isCheckingStatus = true;
  bool _isEnrolled = false;
  String? _enrolledAt;
  double? _enrollConfidence;
  String? _faceId;

  XFile? _capturedImage;
  bool _screenFlashEnabled = false;
  String _guidanceMessage = 'Align your face inside the oval frame';

  @override
  void initState() {
    super.initState();
    _fetchEnrollmentStatus();
  }

  Future<void> _fetchEnrollmentStatus() async {
    setState(() => _isCheckingStatus = true);
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/attendance/enrollment-status'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        setState(() {
          _isEnrolled = data['isFaceEnrolled'] == true;
          _enrolledAt = data['faceEnrolledAt'];
          _enrollConfidence = data['faceEnrollConfidence'] != null
              ? (data['faceEnrollConfidence'] as num).toDouble()
              : null;
          _faceId = data['faceId'];
        });
      }
    } catch (e) {
      debugPrint('Error fetching face enrollment status: $e');
    } finally {
      if (mounted) setState(() => _isCheckingStatus = false);
    }
  }

  Future<void> _captureSelfie() async {
    try {
      final photo = await _picker.pickImage(
        source: ImageSource.camera,
        preferredCameraDevice: CameraDevice.front,
        imageQuality: 92,
        maxWidth: 1200,
        maxHeight: 1200,
      );

      if (photo != null && mounted) {
        setState(() {
          _capturedImage = photo;
          _guidanceMessage = 'Photo captured! Review below and register.';
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Camera error: $e'), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _submitEnrollment() async {
    if (_capturedImage == null) return;

    setState(() => _isLoading = true);
    try {
      final uri = Uri.parse('$baseUrl/attendance/enroll-face');
      final request = http.MultipartRequest('POST', uri);
      request.headers['Authorization'] = 'Bearer ${widget.token}';

      request.files.add(
        await http.MultipartFile.fromPath('image', _capturedImage!.path),
      );

      final streamedResponse = await request.send();
      final response = await http.Response.fromStream(streamedResponse);

      if (!mounted) return;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        final data = json.decode(response.body);
        final confidence = data['confidence'] ?? 99.0;

        await _showSuccessDialog(confidence);
        widget.onEnrollmentComplete?.call();
        await _fetchEnrollmentStatus();
      } else {
        final errorData = json.decode(response.body);
        final errorMsg = errorData['error'] ?? 'Facial indexing failed. Please try again.';
        _showErrorDialog(errorMsg);
      }
    } catch (e) {
      if (mounted) {
        _showErrorDialog('Network connection error: $e');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _showSuccessDialog(dynamic confidence) async {
    return showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(
          children: [
            Icon(Icons.check_circle, color: Color(0xFF2E7D32), size: 28),
            SizedBox(width: 10),
            Text('Enrolled Successfully', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Your facial profile has been indexed in Amazon Rekognition and locked for official shift attendance.',
              style: TextStyle(fontSize: 14, color: Colors.black87),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFE8F5E9),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFF81C784)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Biometric Confidence: $confidence%', style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF1B5E20))),
                  const SizedBox(height: 4),
                  const Text('Status: Profile Locked (Tamper-Proof)', style: TextStyle(fontSize: 12, color: Color(0xFF2E7D32))),
                ],
              ),
            ),
          ],
        ),
        actions: [
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF1976D2),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              Navigator.pop(context, true); // Return success to caller
            },
            child: const Text('Proceed to Duty Console', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }

  void _showErrorDialog(String message) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(
          children: [
            Icon(Icons.error_outline, color: Colors.red, size: 26),
            SizedBox(width: 8),
            Text('Registration Notice', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
          ],
        ),
        content: Text(message, style: const TextStyle(fontSize: 14, color: Colors.black87)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Try Again'),
          ),
        ],
      ),
    );
  }

  void _showReenrollmentRequestSheet() {
    final reasonController = TextEditingController();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          left: 20,
          right: 20,
          top: 20,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Request Biometric Re-Enrollment',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0D47A1)),
            ),
            const SizedBox(height: 8),
            const Text(
              'Your face profile is currently locked. To update your photo (due to facial surgery, injury, or appearance change), submit a reason for Restkeeper / Admin approval.',
              style: TextStyle(fontSize: 13, color: Colors.black87),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: reasonController,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: 'Enter reason (e.g. Facial surgery, new prescription glasses, camera quality issue)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1976D2),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                onPressed: () async {
                  final reason = reasonController.text.trim();
                  if (reason.length < 5) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Please enter a detailed reason')),
                    );
                    return;
                  }
                  Navigator.pop(ctx);
                  await _submitReenrollmentRequest(reason);
                },
                child: const Text('Submit Request for Review', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submitReenrollmentRequest(String reason) async {
    setState(() => _isLoading = true);
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/attendance/request-reenrollment'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Content-Type': 'application/json',
        },
        body: json.encode({'reason': reason}),
      );

      if (!mounted) return;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Re-enrollment request submitted to supervisor!'),
            backgroundColor: Color(0xFF2E7D32),
          ),
        );
      } else {
        final data = json.decode(res.body);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(data['error'] ?? 'Submission failed'), backgroundColor: Colors.red),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isCheckingStatus) {
      return Scaffold(
        appBar: AppBar(title: const Text('Facial Registration')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    // If already enrolled, show profile view with re-enrollment option
    if (_isEnrolled) {
      return _buildEnrolledProfileView();
    }

    // Active Enrollment Flow
    return Scaffold(
      backgroundColor: _screenFlashEnabled ? Colors.white : const Color(0xFF121212),
      appBar: AppBar(
        title: const Text('Facial Biometric Enrollment', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'Night Screen Flash',
            icon: Icon(
              _screenFlashEnabled ? Icons.flashlight_on : Icons.flashlight_off,
              color: _screenFlashEnabled ? Colors.amber : Colors.white70,
            ),
            onPressed: () {
              setState(() => _screenFlashEnabled = !_screenFlashEnabled);
            },
          ),
        ],
      ),
      body: Stack(
        children: [
          Column(
            children: [
              // Top Staff Info Strip
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                color: const Color(0xFF1E293B),
                child: Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: const Color(0xFF0288D1),
                      radius: 18,
                      child: Text(
                        (widget.user['fullName'] ?? 'U')[0].toUpperCase(),
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.user['fullName'] ?? 'Railway Staff',
                            style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.bold),
                          ),
                          Text(
                            '${widget.user['designation'] ?? 'Gateman'} • Emp ID: ${widget.user['employeeId'] ?? 'N/A'}',
                            style: const TextStyle(color: Colors.white70, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: Colors.amber.shade900,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Text('Action Required', style: TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold)),
                    ),
                  ],
                ),
              ),

              // Camera Frame / Preview Area
              Expanded(
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    // Captured image preview or placeholder
                    if (_capturedImage != null)
                      Positioned.fill(
                        child: Image.file(
                          File(_capturedImage!.path),
                          fit: BoxFit.cover,
                        ),
                      )
                    else
                      Container(
                        color: _screenFlashEnabled ? Colors.white : Colors.black87,
                        child: Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.face_retouching_natural, size: 70, color: Colors.cyan.shade300),
                              const SizedBox(height: 16),
                              const Text(
                                'Tap Camera Button Below\nto Capture Biometric Selfie',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Colors.white70, fontSize: 14, height: 1.4),
                              ),
                            ],
                          ),
                        ),
                      ),

                    // Railway Guided Oval Overlay
                    FaceScannerOverlay(
                      statusText: _guidanceMessage,
                      isFaceDetected: _capturedImage != null,
                    ),

                    if (_isLoading)
                      Container(
                        color: Colors.black54,
                        child: const Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              CircularProgressIndicator(color: Colors.cyan),
                              SizedBox(height: 16),
                              Text(
                                'Analyzing facial features with Amazon Rekognition...',
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),

              // Bottom Control Bar
              Container(
                padding: const EdgeInsets.all(16),
                decoration: const BoxDecoration(
                  color: Color(0xFF1E293B),
                  borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
                ),
                child: SafeArea(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Instructions Checklist
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceAround,
                        children: [
                          _buildInstructionPill(Icons.wb_sunny_outlined, 'Good Light'),
                          _buildInstructionPill(Icons.remove_red_eye_outlined, 'Eyes Open'),
                          _buildInstructionPill(Icons.no_accounts_outlined, 'No Sunglasses'),
                        ],
                      ),
                      const SizedBox(height: 16),

                      if (_capturedImage == null)
                        SizedBox(
                          width: double.infinity,
                          height: 48,
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF00E5FF),
                              foregroundColor: Colors.black87,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            ),
                            icon: const Icon(Icons.camera_alt, color: Colors.black87),
                            label: const Text(
                              'Capture Front-Facing Photo',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                            ),
                            onPressed: _isLoading ? null : _captureSelfie,
                          ),
                        )
                      else
                        Row(
                          children: [
                            Expanded(
                              flex: 1,
                              child: OutlinedButton.icon(
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: Colors.white,
                                  side: const BorderSide(color: Colors.white38),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                ),
                                icon: const Icon(Icons.refresh, size: 18),
                                label: const Text('Retake'),
                                onPressed: _isLoading ? null : _captureSelfie,
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              flex: 2,
                              child: ElevatedButton.icon(
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF00E676),
                                  foregroundColor: Colors.black,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                ),
                                icon: const Icon(Icons.cloud_upload, color: Colors.black),
                                label: const Text(
                                  'Confirm & Register',
                                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                ),
                                onPressed: _isLoading ? null : _submitEnrollment,
                              ),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildInstructionPill(IconData icon, String text) {
    return Row(
      children: [
        Icon(icon, size: 14, color: Colors.white60),
        const SizedBox(width: 4),
        Text(text, style: const TextStyle(color: Colors.white60, fontSize: 11)),
      ],
    );
  }

  Widget _buildEnrolledProfileView() {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Biometric Profile', style: TextStyle(fontWeight: FontWeight.bold)),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            // Status Card
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFFE8F5E9),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFF81C784), width: 1.5),
              ),
              child: Column(
                children: [
                  const Icon(Icons.verified_user, color: Color(0xFF2E7D32), size: 56),
                  const SizedBox(height: 10),
                  const Text(
                    'Facial Biometrics Registered',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF1B5E20)),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Amazon Rekognition Index Verified',
                    style: TextStyle(fontSize: 13, color: Color(0xFF388E3C)),
                  ),
                  const Divider(height: 24),
                  _buildDetailRow('Employee Name', widget.user['fullName'] ?? 'N/A'),
                  _buildDetailRow('Employee ID', widget.user['employeeId'] ?? 'N/A'),
                  _buildDetailRow('Designation', widget.user['designation'] ?? 'Gateman'),
                  _buildDetailRow('Confidence', '${_enrollConfidence ?? 99.0}%'),
                  if (_faceId != null)
                    _buildDetailRow('Rekognition FaceId', _faceId!.length > 18 ? '${_faceId!.substring(0, 16)}...' : _faceId!),
                  if (_enrolledAt != null)
                    _buildDetailRow('Enrolled On', _enrolledAt!.split('T')[0]),
                  _buildDetailRow('Profile Lock', 'LOCKED (Tamper-Proof)'),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // Security Policy Card
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFFF1F5F9),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFCBD5E1)),
              ),
              child: const Row(
                children: [
                  Icon(Icons.shield_outlined, color: Color(0xFF475569), size: 28),
                  SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Railway Security Rule: Registered facial feature vectors cannot be edited or overwritten by users directly.',
                      style: TextStyle(fontSize: 12.5, color: Color(0xFF334155), height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 28),

            // Re-enrollment Request Button
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFF0D47A1),
                side: const BorderSide(color: Color(0xFF0D47A1)),
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              icon: const Icon(Icons.history_edu),
              label: const Text('Request Face Profile Re-Enrollment', style: TextStyle(fontWeight: FontWeight.bold)),
              onPressed: _showReenrollmentRequestSheet,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDetailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, color: Colors.black54)),
          Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.black87)),
        ],
      ),
    );
  }
}
