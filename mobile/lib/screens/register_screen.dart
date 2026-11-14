import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';
import 'package:image_picker/image_picker.dart';

import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  // Dynamic hierarchy from backend (installed locations only)
  List<dynamic> _zones = [];
  List<dynamic> _departments = [];
  bool _isLoadingHierarchy = true;

  // Form Controllers
  final _fullNameCtrl = TextEditingController();
  final _mobileCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _empIdCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();

  // Mobile OTP Verification State
  final _otpCtrl = TextEditingController();
  bool _isMobileVerified = false;
  String _verifiedMobile = '';
  bool _isSendingOtp = false;
  bool _isVerifyingOtp = false;
  bool _otpSent = false;
  int _otpResendCountdown = 0;
  Timer? _countdownTimer;

  // Selected Railway Jurisdiction & Designation
  String? _selectedZone;
  String? _selectedDivision;
  String _selectedDepartment = 'Operations';
  String? _selectedDesignation;
  int? _selectedStationId;
  final Set<int> _selectedStationIds = {};
  final Set<int> _selectedGateIds = {};

  // Railway Safety & Medical Qualifications (PME & RC)
  DateTime? _pmeDate;
  DateTime? _pmeExpiryDate;
  final _pmeCertCtrl = TextEditingController();

  DateTime? _rcDate;
  DateTime? _rcExpiryDate;
  final _rcInstituteCtrl = TextEditingController();

  XFile? _pmeCertificateFile;
  XFile? _rcCertificateFile;

  // Official ID Card Document
  XFile? _idCardFile;
  final ImagePicker _picker = ImagePicker();

  // Security Declaration
  bool _declarationConfirmed = false;

  // State
  bool _isSubmitting = false;
  String _error = '';
  bool _success = false;

  @override
  void initState() {
    super.initState();
    _mobileCtrl.addListener(_onMobileChanged);
    _fetchHierarchy();
  }

  void _onMobileChanged() {
    final current = _mobileCtrl.text.replaceAll(RegExp(r'\D'), '');
    if (_isMobileVerified && current != _verifiedMobile) {
      setState(() {
        _isMobileVerified = false;
        _verifiedMobile = '';
        _otpSent = false;
        _otpCtrl.clear();
      });
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _fullNameCtrl.dispose();
    _mobileCtrl.removeListener(_onMobileChanged);
    _mobileCtrl.dispose();
    _otpCtrl.dispose();
    _emailCtrl.dispose();
    _empIdCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    _pmeCertCtrl.dispose();
    _rcInstituteCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchHierarchy() async {
    setState(() => _isLoadingHierarchy = true);
    try {
      final res = await http.get(Uri.parse('$baseUrl/auth/installed-hierarchy'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _zones = data['zones'] ?? [];
            _departments = data['departments'] ?? [];

            if (_zones.isNotEmpty) {
              _selectedZone = _zones[0]['name'];
              final divs = (_zones[0]['divisions'] as List?) ?? [];
              if (divs.isNotEmpty) {
                _selectedDivision = divs[0]['name'];
              }
            }

            if (_departments.isNotEmpty) {
              _selectedDepartment = _departments[0]['name'] ?? 'Operations';
              final desigs = (_departments[0]['designations'] as List?) ?? [];
              if (desigs.isNotEmpty) {
                _selectedDesignation = desigs[0]['name'];
              }
            }
            _isLoadingHierarchy = false;
          });
          return;
        }
      }
    } catch (e) {
      debugPrint('Error loading hierarchy: $e');
    }
    if (mounted) setState(() => _isLoadingHierarchy = false);
  }

  // Cascading helpers
  Map<String, dynamic>? get _currentZoneObj {
    try {
      return _zones.firstWhere((z) => z['name'] == _selectedZone);
    } catch (_) {
      return null;
    }
  }

  List<dynamic> get _availableDivisions {
    return (_currentZoneObj?['divisions'] as List?) ?? [];
  }

  Map<String, dynamic>? get _currentDivisionObj {
    try {
      return _availableDivisions.firstWhere((d) => d['name'] == _selectedDivision);
    } catch (_) {
      return null;
    }
  }

  List<dynamic> get _availableStations {
    return (_currentDivisionObj?['stations'] as List?) ?? [];
  }

  Map<String, dynamic>? get _currentStationObj {
    if (_selectedStationId == null) return null;
    try {
      return _availableStations.firstWhere((s) => s['id'] == _selectedStationId);
    } catch (_) {
      return null;
    }
  }

  List<dynamic> get _availableGates {
    if (_isGateman) {
      return (_currentStationObj?['gates'] as List?) ?? [];
    }
    final List<dynamic> gates = [];
    final activeStationIds = _selectedStationIds.isNotEmpty
        ? _selectedStationIds
        : (_selectedStationId != null ? {_selectedStationId!} : <int>{});

    if (activeStationIds.isNotEmpty) {
      for (final st in _availableStations) {
        if (activeStationIds.contains(st['id'])) {
          final stGates = (st['gates'] as List?) ?? [];
          gates.addAll(stGates);
        }
      }
    } else {
      for (final st in _availableStations) {
        final stGates = (st['gates'] as List?) ?? [];
        gates.addAll(stGates);
      }
    }
    return gates;
  }

  Map<String, dynamic>? get _currentDeptObj {
    try {
      return _departments.firstWhere((d) => d['name'] == _selectedDepartment);
    } catch (_) {
      return null;
    }
  }

  List<dynamic> get _availableDesignations {
    return (_currentDeptObj?['designations'] as List?) ?? [];
  }

  Map<String, dynamic>? get _currentDesigObj {
    try {
      return _availableDesignations.firstWhere((d) => d['name'] == _selectedDesignation);
    } catch (_) {
      return null;
    }
  }

  bool get _isStationLevel {
    final level = _currentDesigObj?['level'];
    return level == 'STATION' || level == 'GATE';
  }

  bool get _isGateman {
    final name = (_currentDesigObj?['name'] ?? _selectedDesignation ?? '').toString().toLowerCase();
    return name.contains('gateman') || name.contains('gatekeeper');
  }

  bool get _isRestkeeper {
    final name = (_currentDesigObj?['name'] ?? _selectedDesignation ?? '').toString().toLowerCase();
    return name.contains('restkeeper') || name.contains('rest keeper');
  }

  bool get _isPwiOrCpwi {
    final name = (_currentDesigObj?['name'] ?? _selectedDesignation ?? '').toString().toLowerCase();
    return name.contains('pwi') || name.contains('cpwi') || name.contains('sse/p.way') || name.contains('je/p.way') || name.contains('engineering supervisor');
  }

  bool get _isDivisionalOfficer {
    final name = (_currentDesigObj?['name'] ?? _selectedDesignation ?? '').toString().toLowerCase();
    return name.contains('den') || name.contains('dom') || name.contains('drm') || name.contains('adrm');
  }

  bool get _needsGateSelection {
    return _isGateman || _isRestkeeper || _isPwiOrCpwi || _isStationLevel;
  }

  bool get _needsRailwayMedicalAndCourse {
    return _isGateman || _isRestkeeper;
  }

  String _formatDate(DateTime d) {
    final y = d.year.toString().padLeft(4, '0');
    final m = d.month.toString().padLeft(2, '0');
    final day = d.day.toString().padLeft(2, '0');
    return '$y-$m-$day';
  }

  Future<void> _pickPmeDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _pmeDate ?? DateTime.now(),
      firstDate: DateTime(2010),
      lastDate: DateTime.now(),
      helpText: 'SELECT PME MEDICAL EXAM DATE',
    );
    if (picked != null && mounted) {
      setState(() {
        _pmeDate = picked;
        // PME mandatory every 4 years
        _pmeExpiryDate = DateTime(picked.year + 4, picked.month, picked.day);
      });
    }
  }

  Future<void> _pickRcDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _rcDate ?? DateTime.now(),
      firstDate: DateTime(2010),
      lastDate: DateTime.now(),
      helpText: 'SELECT REFRESHER COURSE (RC) DATE',
    );
    if (picked != null && mounted) {
      setState(() {
        _rcDate = picked;
        // RC mandatory every 2 years
        _rcExpiryDate = DateTime(picked.year + 2, picked.month, picked.day);
      });
    }
  }

  Widget _buildValidityBadge(DateTime? expiry) {
    if (expiry == null) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: const Color(0xFFF1F5F9),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFFCBD5E1)),
        ),
        child: const Text('NOT SET', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
      );
    }
    final now = DateTime.now();
    final isExpired = expiry.isBefore(now);
    final daysRemaining = expiry.difference(now).inDays;
    final isDueSoon = !isExpired && daysRemaining <= 30;

    final Color badgeColor;
    final String label;
    final IconData icon;

    if (isExpired) {
      badgeColor = const Color(0xFFDC2626);
      label = 'EXPIRED';
      icon = Icons.cancel;
    } else if (isDueSoon) {
      badgeColor = const Color(0xFFD97706);
      label = 'DUE SOON (${daysRemaining}d)';
      icon = Icons.warning_amber_rounded;
    } else {
      badgeColor = const Color(0xFF059669);
      label = 'VALID';
      icon = Icons.check_circle;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: badgeColor.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: badgeColor.withValues(alpha: 0.4)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: badgeColor),
          const SizedBox(width: 3),
          Text(
            label,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.bold,
              color: badgeColor,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _pickIdCard(ImageSource source) async {
    try {
      final img = await _picker.pickImage(source: source, imageQuality: 85);
      if (img != null && mounted) {
        setState(() => _idCardFile = img);
      }
    } catch (e) {
      debugPrint('Error picking ID card: $e');
    }
  }

  Future<void> _pickCertificatePhoto({required bool isPme}) async {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt, color: AppColors.primary),
              title: Text('Take Photo of ' + (isPme ? 'PME' : 'RC') + ' Certificate'),
              onTap: () async {
                Navigator.pop(ctx);
                try {
                  final img = await _picker.pickImage(source: ImageSource.camera, imageQuality: 85);
                  if (img != null && mounted) {
                    setState(() {
                      if (isPme) {
                        _pmeCertificateFile = img;
                      } else {
                        _rcCertificateFile = img;
                      }
                    });
                  }
                } catch (e) {
                  debugPrint('Error picking certificate photo: $e');
                }
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library, color: AppColors.primary),
              title: Text('Choose ' + (isPme ? 'PME' : 'RC') + ' Certificate from Gallery'),
              onTap: () async {
                Navigator.pop(ctx);
                try {
                  final img = await _picker.pickImage(source: ImageSource.gallery, imageQuality: 85);
                  if (img != null && mounted) {
                    setState(() {
                      if (isPme) {
                        _pmeCertificateFile = img;
                      } else {
                        _rcCertificateFile = img;
                      }
                    });
                  }
                } catch (e) {
                  debugPrint('Error picking certificate photo: $e');
                }
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCertificatePhotoPicker({
    required String title,
    required XFile? file,
    required VoidCallback onPick,
    required VoidCallback onClear,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.description_outlined, size: 16, color: Color(0xFF0284C7)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF334155)),
                ),
              ),
              OutlinedButton.icon(
                onPressed: onPick,
                icon: const Icon(Icons.upload_file, size: 14),
                label: Text(file == null ? 'Upload Photo' : 'Change', style: const TextStyle(fontSize: 11)),
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  minimumSize: const Size(0, 30),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ],
          ),
          if (file != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const Icon(Icons.check_circle, size: 14, color: Color(0xFF059669)),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    file.name,
                    style: const TextStyle(fontSize: 11, color: Color(0xFF059669), fontWeight: FontWeight.bold),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 16, color: Colors.red),
                  onPressed: onClear,
                  tooltip: 'Remove',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _sendMobileOtp() async {
    final mobile = _mobileCtrl.text.replaceAll(RegExp(r'\D'), '');
    if (mobile.length != 10 || !RegExp(r'^[6-9]\d{9}$').hasMatch(mobile)) {
      AppFeedback.showWarning(context, 'Please enter a valid 10-digit Indian mobile number (starting with 6-9).');
      return;
    }

    setState(() {
      _isSendingOtp = true;
      _error = '';
    });

    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/register/otp/send'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'mobile': mobile}),
      );

      final data = json.decode(res.body);

      if (res.statusCode == 200 && data['success'] == true) {
        setState(() {
          _otpSent = true;
          _otpResendCountdown = 60;
        });

        _startResendTimer();

        if (mounted) {
          AppFeedback.showSuccess(context, 'OTP dispatched via SMS to +91 $mobile. Please enter the 6-digit code.');
        }
      } else {
        final errMsg = data['error'] ?? 'Failed to send OTP. Please check mobile number.';
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error sending OTP: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isSendingOtp = false);
      }
    }
  }

  void _startResendTimer() {
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_otpResendCountdown > 0) {
        if (mounted) setState(() => _otpResendCountdown--);
      } else {
        timer.cancel();
      }
    });
  }

  Future<void> _verifyMobileOtp() async {
    final mobile = _mobileCtrl.text.replaceAll(RegExp(r'\D'), '');
    final otp = _otpCtrl.text.trim();

    if (otp.length != 6) {
      AppFeedback.showWarning(context, 'Please enter the complete 6-digit OTP code.');
      return;
    }

    setState(() => _isVerifyingOtp = true);

    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/register/otp/verify'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'mobile': mobile, 'otp': otp}),
      );

      final data = json.decode(res.body);

      if (res.statusCode == 200 && data['verified'] == true) {
        setState(() {
          _isMobileVerified = true;
          _verifiedMobile = mobile;
          _otpSent = false;
        });
        _countdownTimer?.cancel();

        if (mounted) {
          AppFeedback.showSuccess(context, 'Mobile number +91 $mobile verified successfully!');
        }
      } else {
        final errMsg = data['error'] ?? 'Invalid or expired OTP. Please check code and try again.';
        if (mounted) {
          AppFeedback.showError(context, errMsg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error verifying OTP: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isVerifyingOtp = false);
      }
    }
  }

  Future<void> _submitRegistration() async {
    if (_isSubmitting) return;

    final name = _fullNameCtrl.text.trim();
    final mobile = _mobileCtrl.text.replaceAll(RegExp(r'\D'), '');
    final email = _emailCtrl.text.trim();
    final empId = _empIdCtrl.text.trim();
    final password = _passwordCtrl.text;
    final confirm = _confirmPasswordCtrl.text;

    if (name.isEmpty) {
      AppFeedback.showWarning(context, 'Full Name is required.');
      return;
    }
    if (mobile.length != 10) {
      AppFeedback.showWarning(context, 'Mobile number must be a 10-digit Indian number.');
      return;
    }
    if (!_isMobileVerified || mobile != _verifiedMobile) {
      AppFeedback.showWarning(context, 'Please verify your mobile number with OTP before submitting registration.');
      return;
    }
    if (email.isEmpty || !email.contains('@')) {
      AppFeedback.showWarning(context, 'Valid official email address is required.');
      return;
    }
    if (empId.isEmpty) {
      AppFeedback.showWarning(context, 'Indian Railways Employee ID is required.');
      return;
    }
    if (password.length < 6) {
      AppFeedback.showWarning(context, 'Password must be at least 6 characters.');
      return;
    }
    if (password != confirm) {
      AppFeedback.showWarning(context, 'Passwords do not match.');
      return;
    }

    if (_selectedZone == null || _selectedDivision == null) {
      AppFeedback.showWarning(context, 'Please select Railway Zone and Division.');
      return;
    }

    if (_selectedDesignation == null) {
      AppFeedback.showWarning(context, 'Please select your official Railway Designation.');
      return;
    }

    if (_isGateman) {
      if (_selectedStationId == null) {
        AppFeedback.showWarning(context, 'Station selection is mandatory for Gateman.');
        return;
      }
      if (_selectedGateIds.length != 1) {
        AppFeedback.showWarning(context, 'A Gateman must select strictly ONE Level Crossing Gate.');
        return;
      }
    } else if (_isRestkeeper || _isPwiOrCpwi) {
      if (_selectedStationIds.isEmpty && _selectedStationId == null) {
        AppFeedback.showWarning(context, 'Please select at least one Railway Station under your section.');
        return;
      }
      if (_selectedGateIds.isEmpty) {
        AppFeedback.showWarning(context, 'Please select the Level Crossing Gate(s) under your supervision.');
        return;
      }
    } else if (_isStationLevel) {
      if (_selectedStationId == null) {
        AppFeedback.showWarning(context, 'Station selection is mandatory for $_selectedDesignation.');
        return;
      }
    }

    // Official Identity Document photo upload is optional

    if (!_declarationConfirmed) {
      AppFeedback.showWarning(context, 'You must accept the official verification declaration before submitting.');
      return;
    }

    setState(() {
      _isSubmitting = true;
      _error = '';
    });

    try {
      final url = Uri.parse('$baseUrl/auth/register');
      final request = http.MultipartRequest('POST', url);

      final effectiveStationIds = _selectedStationIds.isNotEmpty
          ? _selectedStationIds.toList()
          : (_selectedStationId != null ? [_selectedStationId!] : <int>[]);
      final primaryStationId = effectiveStationIds.isNotEmpty ? effectiveStationIds[0] : null;

      final registrationData = <String, dynamic>{
        'fullName': name,
        'mobile': mobile,
        'email': email,
        'employeeId': empId,
        'password': password,
        'department': _selectedDepartment,
        'designation': _selectedDesignation,
        'zone': _selectedZone,
        'division': _selectedDivision,
        'stationId': primaryStationId,
        'stationIds': effectiveStationIds,
        'gateIds': _selectedGateIds.toList(),
        'declarationConfirmed': true,
        if (_pmeDate != null) 'pmeDate': _formatDate(_pmeDate!),
        if (_pmeExpiryDate != null) 'pmeExpiryDate': _formatDate(_pmeExpiryDate!),
        if (_pmeCertCtrl.text.trim().isNotEmpty) 'pmeCertificateNo': _pmeCertCtrl.text.trim(),
        if (_rcDate != null) 'rcDate': _formatDate(_rcDate!),
        if (_rcExpiryDate != null) 'rcExpiryDate': _formatDate(_rcExpiryDate!),
        if (_rcInstituteCtrl.text.trim().isNotEmpty) 'rcInstitute': _rcInstituteCtrl.text.trim(),
      };

      request.fields['data'] = json.encode(registrationData);
      request.fields['department'] = _selectedDepartment;
      if (_selectedDesignation != null) request.fields['designation'] = _selectedDesignation!;
      if (_selectedZone != null) request.fields['zone'] = _selectedZone!;
      if (_selectedDivision != null) request.fields['division'] = _selectedDivision!;
      if (primaryStationId != null) request.fields['stationId'] = primaryStationId.toString();
      request.fields['declarationConfirmed'] = 'true';
      request.fields['formId'] = '1';

      if (_pmeDate != null) {
        request.fields['pmeDate'] = _formatDate(_pmeDate!);
        request.fields['pmeExpiryDate'] = _formatDate(_pmeExpiryDate!);
      }
      if (_pmeCertCtrl.text.trim().isNotEmpty) {
        request.fields['pmeCertificateNo'] = _pmeCertCtrl.text.trim();
      }
      if (_rcDate != null) {
        request.fields['rcDate'] = _formatDate(_rcDate!);
        request.fields['rcExpiryDate'] = _formatDate(_rcExpiryDate!);
      }
      if (_rcInstituteCtrl.text.trim().isNotEmpty) {
        request.fields['rcInstitute'] = _rcInstituteCtrl.text.trim();
      }

      for (final gid in _selectedGateIds) {
        request.fields['gateIds'] = gid.toString();
      }

      if (_idCardFile != null) {
        final bytes = await _idCardFile!.readAsBytes();
        request.files.add(http.MultipartFile.fromBytes(
          'idCard',
          bytes,
          filename: _idCardFile!.name,
        ));
      }

      if (_pmeCertificateFile != null) {
        final bytes = await _pmeCertificateFile!.readAsBytes();
        request.files.add(http.MultipartFile.fromBytes(
          'pmeCertificate',
          bytes,
          filename: _pmeCertificateFile!.name,
        ));
      }

      if (_rcCertificateFile != null) {
        final bytes = await _rcCertificateFile!.readAsBytes();
        request.files.add(http.MultipartFile.fromBytes(
          'rcCertificate',
          bytes,
          filename: _rcCertificateFile!.name,
        ));
      }

      final streamedRes = await request.send();
      final res = await http.Response.fromStream(streamedRes);

      if (res.statusCode == 201) {
        if (mounted) {
          setState(() => _success = true);
          AppFeedback.showSuccess(
            context,
            'Registration submitted! Your request will be reviewed by your immediate superior.',
          );
        }
      } else {
        String err = 'Registration failed. Please review your details.';
        try {
          final b = json.decode(res.body);
          if (b['error'] != null) err = b['error'];
        } catch (_) {}
        if (mounted) {
          setState(() => _error = err);
          AppFeedback.showError(context, err);
        }
      }
    } catch (e) {
      if (mounted) {
        final err = 'Network error: $e';
        setState(() => _error = err);
        AppFeedback.showError(context, err);
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_success) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Card(
                elevation: 3,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 64,
                        height: 64,
                        decoration: const BoxDecoration(
                          color: Color(0xFFECFDF5),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.check_circle_outline, color: Color(0xFF059669), size: 36),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Registration Submitted!',
                        style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        'Your application for "$_selectedDesignation" ($_selectedDepartment Department) in $_selectedDivision Division has been submitted for hierarchical verification.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 13, color: Color(0xFF475569), height: 1.45),
                      ),
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF0F9FF),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFBAE6FD)),
                        ),
                        child: Text(
                          'Next: Review by ${_currentDesigObj?['immediateSuperior'] ?? 'Railway Governance Authority'}. Once verified, your account will be activated.',
                          style: const TextStyle(fontSize: 12, color: Color(0xFF0369A1)),
                          textAlign: TextAlign.center,
                        ),
                      ),
                      const SizedBox(height: 24),
                      ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          minimumSize: const Size(double.infinity, 44),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Return to Login', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
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

    return Scaffold(
      appBar: AppBar(
        title: const Text('Railway Employee Registration', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        elevation: 0,
      ),
      body: _isLoadingHierarchy
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 540),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Header Card
                      Card(
                        elevation: 1,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        child: const Padding(
                          padding: EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Icon(Icons.train, color: AppColors.primary, size: 24),
                                  SizedBox(width: 8),
                                  Text(
                                    'Indian Railways LC Monitoring',
                                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                                  ),
                                ],
                              ),
                              SizedBox(height: 4),
                              Text(
                                'Official employee onboarding portal for level crossing safety monitoring.',
                                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),

                      if (_error.isNotEmpty) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFEF2F2),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: const Color(0xFFFECACA)),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.error_outline, color: Colors.red, size: 20),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(_error, style: const TextStyle(color: Color(0xFF991B1B), fontSize: 12)),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],

                      // 1. Employee Identity Card
                      Card(
                        elevation: 1,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(Icons.badge_outlined, color: AppColors.primary, size: 18),
                                  SizedBox(width: 8),
                                  Text('1. Employee Identification', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                                ],
                              ),
                              const SizedBox(height: 12),
                              TextField(
                                controller: _fullNameCtrl,
                                decoration: const InputDecoration(labelText: 'Full Name *', isDense: true, border: OutlineInputBorder()),
                              ),
                              const SizedBox(height: 10),
                              TextField(
                                controller: _empIdCtrl,
                                decoration: const InputDecoration(labelText: 'Employee ID / PF Number *', isDense: true, border: OutlineInputBorder()),
                              ),
                              const SizedBox(height: 10),
                              // Mobile Number & OTP Verification Section
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          controller: _mobileCtrl,
                                          keyboardType: TextInputType.phone,
                                          maxLength: 10,
                                          enabled: !_isMobileVerified,
                                          decoration: InputDecoration(
                                            labelText: 'Mobile Number (10 Digits) *',
                                            prefixText: '+91 ',
                                            isDense: true,
                                            border: const OutlineInputBorder(),
                                            counterText: '',
                                            suffixIcon: _isMobileVerified
                                                ? const Icon(Icons.check_circle, color: Color(0xFF059669))
                                                : null,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      if (!_isMobileVerified)
                                        SizedBox(
                                          height: 48,
                                          child: ElevatedButton(
                                            onPressed: (_isSendingOtp || _otpResendCountdown > 0) ? null : _sendMobileOtp,
                                            style: ElevatedButton.styleFrom(
                                              backgroundColor: AppColors.primary,
                                              foregroundColor: Colors.white,
                                              padding: const EdgeInsets.symmetric(horizontal: 14),
                                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                                            ),
                                            child: _isSendingOtp
                                                ? const SizedBox(
                                                    width: 16,
                                                    height: 16,
                                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                                  )
                                                : Text(
                                                    _otpResendCountdown > 0
                                                        ? '${_otpResendCountdown}s'
                                                        : (_otpSent ? 'Resend' : 'Verify'),
                                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                                  ),
                                          ),
                                        )
                                      else
                                        SizedBox(
                                          height: 48,
                                          child: TextButton.icon(
                                            onPressed: () {
                                              setState(() {
                                                _isMobileVerified = false;
                                                _verifiedMobile = '';
                                                _otpSent = false;
                                                _otpCtrl.clear();
                                              });
                                            },
                                            icon: const Icon(Icons.edit, size: 14, color: AppColors.primary),
                                            label: const Text('Change', style: TextStyle(fontSize: 12, color: AppColors.primary)),
                                          ),
                                        ),
                                    ],
                                  ),
                                  if (_isMobileVerified)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 4, left: 4),
                                      child: Row(
                                        children: const [
                                          Icon(Icons.verified, size: 14, color: Color(0xFF059669)),
                                          SizedBox(width: 4),
                                          Text('Mobile number verified via SMS OTP', style: TextStyle(fontSize: 11, color: Color(0xFF059669), fontWeight: FontWeight.w600)),
                                        ],
                                      ),
                                    ),
                                  if (!_isMobileVerified && _otpSent) ...[
                                    const SizedBox(height: 10),
                                    Container(
                                      padding: const EdgeInsets.all(12),
                                      decoration: BoxDecoration(
                                        color: const Color(0xFFF0FDF4),
                                        borderRadius: BorderRadius.circular(8),
                                        border: Border.all(color: const Color(0xFF86EFAC)),
                                      ),
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Row(
                                            children: const [
                                              Icon(Icons.sms_outlined, size: 16, color: Color(0xFF15803D)),
                                              SizedBox(width: 6),
                                              Text('Enter 6-Digit SMS OTP', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF15803D))),
                                            ],
                                          ),
                                          const SizedBox(height: 8),
                                          Row(
                                            children: [
                                              Expanded(
                                                child: TextField(
                                                  controller: _otpCtrl,
                                                  keyboardType: TextInputType.number,
                                                  maxLength: 6,
                                                  decoration: const InputDecoration(
                                                    hintText: '6-digit OTP',
                                                    isDense: true,
                                                    border: OutlineInputBorder(),
                                                    fillColor: Colors.white,
                                                    filled: true,
                                                    counterText: '',
                                                  ),
                                                ),
                                              ),
                                              const SizedBox(width: 8),
                                              ElevatedButton(
                                                onPressed: _isVerifyingOtp ? null : _verifyMobileOtp,
                                                style: ElevatedButton.styleFrom(
                                                  backgroundColor: const Color(0xFF15803D),
                                                  foregroundColor: Colors.white,
                                                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                                                ),
                                                child: _isVerifyingOtp
                                                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                                    : const Text('Submit OTP', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                                              ),
                                            ],
                                          ),
                                          if (_otpResendCountdown > 0)
                                            Padding(
                                              padding: const EdgeInsets.only(top: 6),
                                              child: Text(
                                                'Resend code in ${_otpResendCountdown}s',
                                                style: const TextStyle(fontSize: 11, color: Colors.grey),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                              const SizedBox(height: 10),
                              TextField(
                                controller: _emailCtrl,
                                keyboardType: TextInputType.emailAddress,
                                decoration: const InputDecoration(labelText: 'Official Email Address *', isDense: true, border: OutlineInputBorder()),
                              ),
                              const SizedBox(height: 10),
                              TextField(
                                controller: _passwordCtrl,
                                obscureText: true,
                                decoration: const InputDecoration(labelText: 'Password *', isDense: true, border: OutlineInputBorder()),
                              ),
                              const SizedBox(height: 10),
                              TextField(
                                controller: _confirmPasswordCtrl,
                                obscureText: true,
                                decoration: const InputDecoration(labelText: 'Confirm Password *', isDense: true, border: OutlineInputBorder()),
                              ),
                              const SizedBox(height: 14),

                              // ID Card Picker (Optional)
                              const Text('Official Railway Identity Document (Optional)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                              const SizedBox(height: 6),
                              Row(
                                children: [
                                  OutlinedButton.icon(
                                    icon: const Icon(Icons.camera_alt, size: 16),
                                    label: const Text('Camera', style: TextStyle(fontSize: 12)),
                                    onPressed: () => _pickIdCard(ImageSource.camera),
                                  ),
                                  const SizedBox(width: 8),
                                  OutlinedButton.icon(
                                    icon: const Icon(Icons.photo_library, size: 16),
                                    label: const Text('Gallery', style: TextStyle(fontSize: 12)),
                                    onPressed: () => _pickIdCard(ImageSource.gallery),
                                  ),
                                ],
                              ),
                              if (_idCardFile != null) ...[
                                const SizedBox(height: 6),
                                Row(
                                  children: [
                                    const Icon(Icons.check_circle, size: 14, color: Color(0xFF059669)),
                                    const SizedBox(width: 4),
                                    Expanded(
                                      child: Text(
                                        'Selected: ${_idCardFile!.name}',
                                        style: const TextStyle(fontSize: 11, color: Color(0xFF059669), fontWeight: FontWeight.bold),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    IconButton(
                                      icon: const Icon(Icons.close, size: 16, color: Colors.red),
                                      onPressed: () => setState(() => _idCardFile = null),
                                      tooltip: 'Remove',
                                      padding: EdgeInsets.zero,
                                      constraints: const BoxConstraints(),
                                    ),
                                  ],
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),

                      // 2. Railway Geographical Jurisdiction (Active Installations Only)
                      Card(
                        elevation: 1,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(Icons.location_on_outlined, color: AppColors.primary, size: 18),
                                  SizedBox(width: 8),
                                  Text('2. Railway Jurisdiction (Active Installations)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                                ],
                              ),
                              const SizedBox(height: 12),

                              // Zone Dropdown
                              DropdownButtonFormField<String>(
                                value: _selectedZone,
                                isExpanded: true,
                                decoration: const InputDecoration(labelText: 'Railway Zone *', isDense: true, border: OutlineInputBorder()),
                                items: _zones.map((z) => DropdownMenuItem<String>(value: z['name'].toString(), child: Text(z['name'].toString(), style: const TextStyle(fontSize: 12.5)))).toList(),
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() {
                                      _selectedZone = val;
                                      final zObj = _zones.firstWhere((z) => z['name'] == val, orElse: () => null);
                                      final divs = (zObj?['divisions'] as List?) ?? [];
                                      _selectedDivision = divs.isNotEmpty ? divs[0]['name'] : null;
                                      _selectedStationId = null;
                                      _selectedGateIds.clear();
                                    });
                                  }
                                },
                              ),
                              const SizedBox(height: 10),

                              // Division Dropdown
                              DropdownButtonFormField<String>(
                                value: _availableDivisions.any((d) => d['name'] == _selectedDivision) ? _selectedDivision : null,
                                isExpanded: true,
                                decoration: const InputDecoration(labelText: 'Railway Division *', isDense: true, border: OutlineInputBorder()),
                                items: _availableDivisions.map((d) => DropdownMenuItem<String>(value: d['name'].toString(), child: Text(d['name'].toString(), style: const TextStyle(fontSize: 12.5)))).toList(),
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() {
                                      _selectedDivision = val;
                                      _selectedStationId = null;
                                      _selectedGateIds.clear();
                                    });
                                  }
                                },
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),

                      // 3. Department & Official Designation
                      Card(
                        elevation: 1,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(Icons.work_outline, color: AppColors.primary, size: 18),
                                  SizedBox(width: 8),
                                  Text('3. Department & Designation', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                                ],
                              ),
                              const SizedBox(height: 12),

                              // Department Dropdown
                              DropdownButtonFormField<String>(
                                value: _selectedDepartment,
                                isExpanded: true,
                                decoration: const InputDecoration(labelText: 'Department *', isDense: true, border: OutlineInputBorder()),
                                items: const [
                                  DropdownMenuItem(value: 'Operations', child: Text('Operations Department', style: TextStyle(fontSize: 12.5))),
                                  DropdownMenuItem(value: 'Engineering', child: Text('Engineering Department', style: TextStyle(fontSize: 12.5))),
                                ],
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() {
                                      _selectedDepartment = val;
                                      final desigs = _availableDesignations;
                                      _selectedDesignation = desigs.isNotEmpty ? desigs[0]['name'] : null;
                                      _selectedGateIds.clear();
                                    });
                                  }
                                },
                              ),
                              const SizedBox(height: 10),

                              // Designation Dropdown
                              DropdownButtonFormField<String>(
                                value: _availableDesignations.any((d) => d['name'] == _selectedDesignation) ? _selectedDesignation : null,
                                isExpanded: true,
                                decoration: const InputDecoration(labelText: 'Official Designation *', isDense: true, border: OutlineInputBorder()),
                                items: _availableDesignations.map((d) {
                                  final name = d['name'].toString();
                                  final sup = d['immediateSuperior'] != null ? ' (Reports to ${d['immediateSuperior']})' : '';
                                  return DropdownMenuItem<String>(
                                    value: name,
                                    child: Text('$name$sup', style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                                  );
                                }).toList(),
                                onChanged: (val) {
                                  if (val != null) {
                                    setState(() {
                                      _selectedDesignation = val;
                                      _selectedGateIds.clear();
                                    });
                                  }
                                },
                              ),
                              if (_currentDesigObj != null) ...[
                                const SizedBox(height: 8),
                                Container(
                                  padding: const EdgeInsets.all(10),
                                  decoration: BoxDecoration(color: const Color(0xFFF0F9FF), borderRadius: BorderRadius.circular(8)),
                                  child: Text(
                                    '${_currentDesigObj!['description']}',
                                    style: const TextStyle(fontSize: 11.5, color: Color(0xFF0369A1)),
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),

                      // 4. Station & Assigned LC Gate(s)
                      if (_needsGateSelection) ...[
                        Card(
                          elevation: 1,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    const Icon(Icons.fence_outlined, color: AppColors.primary, size: 18),
                                    const SizedBox(width: 8),
                                    Text(
                                      _isGateman
                                          ? '4. Station & Assigned LC Gate'
                                          : (_isRestkeeper
                                              ? '4. Section Stations & Gate Rounds'
                                              : '4. Supervised Section Stations & Gates'),
                                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  _isGateman
                                      ? 'Select your assigned railway station and the single level crossing gate where you perform duty.'
                                      : (_isRestkeeper
                                          ? 'A Restkeeper covers relief rounds across adjacent stations in a section. Select stations and their LC gates below.'
                                          : 'Select the railway stations and LC gates under your section jurisdiction.'),
                                  style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                                ),
                                const SizedBox(height: 12),

                                if (_isGateman) ...[
                                  // Gateman Single Station Dropdown
                                  DropdownButtonFormField<int>(
                                    value: _availableStations.any((s) => s['id'] == _selectedStationId) ? _selectedStationId : null,
                                    isExpanded: true,
                                    decoration: const InputDecoration(labelText: 'Station with LC Gates *', isDense: true, border: OutlineInputBorder()),
                                    items: _availableStations.map((s) {
                                      final stId = s['id'] as int?;
                                      final stName = s['name'].toString();
                                      final gatesCount = ((s['gates'] as List?) ?? []).length;
                                      return DropdownMenuItem<int>(
                                        value: stId,
                                        child: Text('$stName ($gatesCount LC Gates)', style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                                      );
                                    }).toList(),
                                    onChanged: (val) {
                                      setState(() {
                                        _selectedStationId = val;
                                        _selectedStationIds.clear();
                                        if (val != null) _selectedStationIds.add(val);
                                        _selectedGateIds.clear();
                                      });
                                    },
                                  ),
                                ] else ...[
                                  // Restkeeper / PWI / CPWI Multi-Station Selection
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      const Text(
                                        'Select Station(s) in Section *:',
                                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF334155)),
                                      ),
                                      if (_availableStations.isNotEmpty)
                                        TextButton(
                                          style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero),
                                          onPressed: () {
                                            setState(() {
                                              if (_selectedStationIds.length == _availableStations.length) {
                                                _selectedStationIds.clear();
                                                _selectedStationId = null;
                                              } else {
                                                _selectedStationIds.clear();
                                                for (var s in _availableStations) {
                                                  if (s['id'] is int) _selectedStationIds.add(s['id'] as int);
                                                }
                                                if (_selectedStationIds.isNotEmpty) _selectedStationId = _selectedStationIds.first;
                                              }
                                              _selectedGateIds.clear();
                                            });
                                          },
                                          child: Text(
                                            _selectedStationIds.length == _availableStations.length ? 'Deselect All' : 'Select All Stations',
                                            style: const TextStyle(fontSize: 11),
                                          ),
                                        ),
                                    ],
                                  ),
                                  const SizedBox(height: 6),
                                  Wrap(
                                    spacing: 6,
                                    runSpacing: 4,
                                    children: _availableStations.map((s) {
                                      final sId = s['id'] as int;
                                      final sName = s['name'].toString();
                                      final sCode = s['code']?.toString() ?? '';
                                      final isSelected = _selectedStationIds.contains(sId);
                                      return FilterChip(
                                        selected: isSelected,
                                        label: Text('$sName ($sCode)', style: TextStyle(fontSize: 11.5, fontWeight: isSelected ? FontWeight.bold : FontWeight.normal)),
                                        selectedColor: const Color(0xFFDCFCE7),
                                        checkmarkColor: const Color(0xFF15803D),
                                        onSelected: (selected) {
                                          setState(() {
                                            if (selected) {
                                              _selectedStationIds.add(sId);
                                              _selectedStationId = _selectedStationIds.first;
                                            } else {
                                              _selectedStationIds.remove(sId);
                                              _selectedStationId = _selectedStationIds.isNotEmpty ? _selectedStationIds.first : null;
                                            }
                                            final validGates = _availableGates.map((g) => g['id'] as int).toSet();
                                            _selectedGateIds.removeWhere((id) => !validGates.contains(id));
                                          });
                                        },
                                      );
                                    }).toList(),
                                  ),
                                ],
                                const SizedBox(height: 14),

                                // Gates List
                                if (_isGateman ? _selectedStationId != null : (_selectedStationIds.isNotEmpty || _selectedStationId != null)) ...[
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      Text(
                                        _isGateman
                                            ? 'Select Exactly ONE Assigned LC Gate *'
                                            : 'Select Assigned LC Gate(s) (${_selectedGateIds.length} Selected) *',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF334155)),
                                      ),
                                      if (!_isGateman && _availableGates.isNotEmpty)
                                        TextButton.icon(
                                          style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero),
                                          icon: Icon(
                                            _selectedGateIds.length == _availableGates.length ? Icons.deselect : Icons.select_all,
                                            size: 15,
                                          ),
                                          label: Text(
                                            _selectedGateIds.length == _availableGates.length
                                                ? 'Deselect All'
                                                : 'Select All (${_availableGates.length})',
                                            style: const TextStyle(fontSize: 11),
                                          ),
                                          onPressed: () {
                                            setState(() {
                                              if (_selectedGateIds.length == _availableGates.length) {
                                                _selectedGateIds.clear();
                                              } else {
                                                _selectedGateIds.clear();
                                                for (final g in _availableGates) {
                                                  if (g['id'] is int) _selectedGateIds.add(g['id'] as int);
                                                }
                                              }
                                            });
                                          },
                                        ),
                                    ],
                                  ),
                                  const SizedBox(height: 6),
                                  if (_availableGates.isEmpty)
                                    const Text('No configured LC Gates under selected station(s).', style: TextStyle(fontSize: 11.5, color: Colors.grey, fontStyle: FontStyle.italic))
                                  else
                                    ..._availableGates.map((gate) {
                                      final gId = gate['id'] as int;
                                      final lcNum = gate['lcNumber']?.toString() ?? 'Gate';
                                      final loc = gate['locationName']?.toString() ?? '';
                                      final isSelected = _selectedGateIds.contains(gId);

                                      return Container(
                                        margin: const EdgeInsets.only(bottom: 6),
                                        decoration: BoxDecoration(
                                          color: isSelected ? const Color(0xFFEFF6FF) : Colors.white,
                                          borderRadius: BorderRadius.circular(8),
                                          border: Border.all(color: isSelected ? const Color(0xFF3B82F6) : const Color(0xFFCBD5E1)),
                                        ),
                                        child: CheckboxListTile(
                                          dense: true,
                                          value: isSelected,
                                          title: Text('$lcNum • $loc', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold)),
                                          onChanged: (checked) {
                                            setState(() {
                                              if (_isGateman) {
                                                _selectedGateIds.clear();
                                                if (checked == true) _selectedGateIds.add(gId);
                                              } else {
                                                if (checked == true) {
                                                  _selectedGateIds.add(gId);
                                                } else {
                                                  _selectedGateIds.remove(gId);
                                                }
                                              }
                                            });
                                          },
                                        ),
                                      );
                                    }),
                                ],
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ] else if (_isDivisionalOfficer) ...[
                        Card(
                          elevation: 1,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(color: const Color(0xFFEFF6FF), borderRadius: BorderRadius.circular(8)),
                                  child: const Icon(Icons.shield_outlined, color: AppColors.primary, size: 22),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text(
                                        'Divisional Officer Jurisdiction',
                                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5, color: Color(0xFF1E3A8A)),
                                      ),
                                      const SizedBox(height: 3),
                                      Text(
                                        'As an officer of $_selectedDivision Division ($_selectedZone Zone), your jurisdiction automatically covers all stations and level crossings across the division.',
                                        style: TextStyle(fontSize: 11.5, color: Colors.grey.shade700, height: 1.35),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],

                      // 5. Railway Safety & Medical Qualifications (PME & RC)
                      if (_needsRailwayMedicalAndCourse) ...[
                        Card(
                          elevation: 1,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Row(
                                  children: [
                                    Icon(Icons.medical_services_outlined, color: AppColors.primary, size: 18),
                                    SizedBox(width: 8),
                                    Text(
                                      '5. Railway Safety & Medical Records',
                                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                Container(
                                  padding: const EdgeInsets.all(10),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFF8FAFC),
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: const Row(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Icon(Icons.info_outline, size: 15, color: Color(0xFF0284C7)),
                                      SizedBox(width: 6),
                                      Expanded(
                                        child: Text(
                                          'Indian Railways Safety Rule: Periodical Medical Examination (PME) is mandatory every 4 years. Refresher Course (RC) is mandatory every 2 years.',
                                          style: TextStyle(fontSize: 11, color: Color(0xFF334155), height: 1.3),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 14),

                                // PME Section
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: const Color(0xFFCBD5E1)),
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          const Text(
                                            'PME (Periodical Medical Exam)',
                                            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                          ),
                                          _buildValidityBadge(_pmeExpiryDate),
                                        ],
                                      ),
                                      const SizedBox(height: 8),
                                      InkWell(
                                        onTap: _pickPmeDate,
                                        borderRadius: BorderRadius.circular(6),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFF1F5F9),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: const Color(0xFFCBD5E1)),
                                          ),
                                          child: Row(
                                            children: [
                                              const Icon(Icons.calendar_month_outlined, size: 16, color: AppColors.primary),
                                              const SizedBox(width: 8),
                                              Expanded(
                                                child: Text(
                                                  _pmeDate != null
                                                      ? 'Exam Date: ${_formatDate(_pmeDate!)}'
                                                      : 'Tap to select PME Exam Date',
                                                  style: TextStyle(
                                                    fontSize: 12,
                                                    color: _pmeDate != null ? const Color(0xFF0F172A) : const Color(0xFF64748B),
                                                    fontWeight: _pmeDate != null ? FontWeight.w600 : FontWeight.normal,
                                                  ),
                                                ),
                                              ),
                                              if (_pmeExpiryDate != null)
                                                Text(
                                                  'Expires: ${_formatDate(_pmeExpiryDate!)} (+4y)',
                                                  style: const TextStyle(fontSize: 11, color: Color(0xFF0369A1), fontWeight: FontWeight.bold),
                                                ),
                                            ],
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 8),
                                      TextField(
                                        controller: _pmeCertCtrl,
                                        decoration: const InputDecoration(
                                          labelText: 'PME Certificate / Fit Memo No. (Optional)',
                                          hintText: 'e.g. PME/2024/0491',
                                          isDense: true,
                                          border: OutlineInputBorder(),
                                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                        ),
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                      const SizedBox(height: 8),
                                      _buildCertificatePhotoPicker(
                                        title: 'PME Certificate Photo (Optional)',
                                        file: _pmeCertificateFile,
                                        onPick: () => _pickCertificatePhoto(isPme: true),
                                        onClear: () => setState(() => _pmeCertificateFile = null),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 12),

                                // RC Section
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: const Color(0xFFCBD5E1)),
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          const Text(
                                            'RC (Refresher Course)',
                                            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                          ),
                                          _buildValidityBadge(_rcExpiryDate),
                                        ],
                                      ),
                                      const SizedBox(height: 8),
                                      InkWell(
                                        onTap: _pickRcDate,
                                        borderRadius: BorderRadius.circular(6),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFF1F5F9),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: const Color(0xFFCBD5E1)),
                                          ),
                                          child: Row(
                                            children: [
                                              const Icon(Icons.school_outlined, size: 16, color: AppColors.primary),
                                              const SizedBox(width: 8),
                                              Expanded(
                                                child: Text(
                                                  _rcDate != null
                                                      ? 'Course Date: ${_formatDate(_rcDate!)}'
                                                      : 'Tap to select Refresher Course Date',
                                                  style: TextStyle(
                                                    fontSize: 12,
                                                    color: _rcDate != null ? const Color(0xFF0F172A) : const Color(0xFF64748B),
                                                    fontWeight: _rcDate != null ? FontWeight.w600 : FontWeight.normal,
                                                  ),
                                                ),
                                              ),
                                              if (_rcExpiryDate != null)
                                                Text(
                                                  'Expires: ${_formatDate(_rcExpiryDate!)} (+2y)',
                                                  style: const TextStyle(fontSize: 11, color: Color(0xFF0369A1), fontWeight: FontWeight.bold),
                                                ),
                                            ],
                                          ),
                                        ),
                                      ),
                                      const SizedBox(height: 8),
                                      TextField(
                                        controller: _rcInstituteCtrl,
                                        decoration: const InputDecoration(
                                          labelText: 'Training Center / Institute (Optional)',
                                          hintText: 'e.g. ZRTI Bhusawal / STC Kota',
                                          isDense: true,
                                          border: OutlineInputBorder(),
                                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                        ),
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                      const SizedBox(height: 8),
                                      _buildCertificatePhotoPicker(
                                        title: 'RC Certificate Photo (Optional)',
                                        file: _rcCertificateFile,
                                        onPick: () => _pickCertificatePhoto(isPme: false),
                                        onClear: () => setState(() => _rcCertificateFile = null),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],

                      // 6. Verification Notice & Declaration (Section 6)
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFFBEB),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: const Color(0xFFFDE68A)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Row(
                              children: [
                                Icon(Icons.security, size: 18, color: Color(0xFFB45309)),
                                SizedBox(width: 8),
                                Text(
                                  'Security & Verification Notice',
                                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF92400E)),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            const Text(
                              'This application is intended exclusively for authorized Indian Railways personnel. All submitted information and assignments are subject to verification by the designated railway authority.',
                              style: TextStyle(fontSize: 11.5, color: Color(0xFF92400E), height: 1.4),
                            ),
                            const SizedBox(height: 10),
                            CheckboxListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              value: _declarationConfirmed,
                              title: const Text(
                                'I hereby declare that all submitted information, designation, and geographical assignments are accurate and strictly pertain to my official posting in Indian Railways.',
                                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Color(0xFF1E293B)),
                              ),
                              onChanged: (val) => setState(() => _declarationConfirmed = val ?? false),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Submit Button
                      ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppColors.primary,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                        ),
                        onPressed: _isSubmitting ? null : _submitRegistration,
                        child: _isSubmitting
                            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Text('Submit Official Registration Request', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white)),
                      ),
                      const SizedBox(height: 14),

                      TextButton(
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Already have an approved account? Sign In', style: TextStyle(color: AppColors.primary, fontSize: 13, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}
