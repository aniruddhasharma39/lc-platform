import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
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

  // Selected Railway Jurisdiction & Designation
  String? _selectedZone;
  String? _selectedDivision;
  String _selectedDepartment = 'Operations';
  String? _selectedDesignation;
  int? _selectedStationId;
  final Set<int> _selectedGateIds = {};

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
    _fetchHierarchy();
  }

  @override
  void dispose() {
    _fullNameCtrl.dispose();
    _mobileCtrl.dispose();
    _emailCtrl.dispose();
    _empIdCtrl.dispose();
    _passwordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
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
    return (_currentStationObj?['gates'] as List?) ?? [];
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
    return _currentDesigObj?['name'] == 'Gateman';
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

    if (_isStationLevel) {
      if (_selectedStationId == null) {
        AppFeedback.showWarning(context, 'Station selection is mandatory for $_selectedDesignation.');
        return;
      }
      if (_isGateman) {
        if (_selectedGateIds.length != 1) {
          AppFeedback.showWarning(context, 'A Gateman must select exactly ONE Level Crossing Gate.');
          return;
        }
      } else {
        if (_selectedGateIds.isEmpty) {
          AppFeedback.showWarning(context, 'Please select at least one Level Crossing Gate under this station.');
          return;
        }
      }
    }

    if (_idCardFile == null) {
      AppFeedback.showWarning(context, 'Official Railway Identity Document photo upload is mandatory.');
      return;
    }

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
        'stationId': _selectedStationId,
        'gateIds': _selectedGateIds.toList(),
        'declarationConfirmed': true,
      };

      request.fields['data'] = json.encode(registrationData);
      request.fields['department'] = _selectedDepartment;
      if (_selectedDesignation != null) request.fields['designation'] = _selectedDesignation!;
      if (_selectedZone != null) request.fields['zone'] = _selectedZone!;
      if (_selectedDivision != null) request.fields['division'] = _selectedDivision!;
      if (_selectedStationId != null) request.fields['stationId'] = _selectedStationId.toString();
      request.fields['declarationConfirmed'] = 'true';
      request.fields['formId'] = '1';

      for (final gid in _selectedGateIds) {
        request.fields['gateIds'] = gid.toString();
      }

      final bytes = await _idCardFile!.readAsBytes();
      request.files.add(http.MultipartFile.fromBytes(
        'idCard',
        bytes,
        filename: _idCardFile!.name,
      ));

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
                              TextField(
                                controller: _mobileCtrl,
                                keyboardType: TextInputType.phone,
                                maxLength: 10,
                                decoration: const InputDecoration(labelText: 'Mobile Number (10 Digits) *', isDense: true, border: OutlineInputBorder(), counterText: ''),
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

                              // ID Card Picker
                              const Text('Official Railway Identity Document *', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
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
                                Text(
                                  'Selected: ${_idCardFile!.name}',
                                  style: const TextStyle(fontSize: 11, color: Color(0xFF059669), fontWeight: FontWeight.bold),
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

                      // 4. Conditional Station & LC Gate Selection (Station/Gate Level)
                      if (_isStationLevel) ...[
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
                                    Icon(Icons.fence_outlined, color: AppColors.primary, size: 18),
                                    SizedBox(width: 8),
                                    Text('4. Station & Assigned LC Gate(s)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                                  ],
                                ),
                                const SizedBox(height: 12),

                                // Station Dropdown
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
                                      _selectedGateIds.clear();
                                    });
                                  },
                                ),
                                const SizedBox(height: 12),

                                // Gates List
                                if (_selectedStationId != null) ...[
                                  Text(
                                    _isGateman
                                        ? 'Select Exactly ONE Assigned LC Gate *'
                                        : 'Select Assigned LC Gate(s) *',
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF334155)),
                                  ),
                                  const SizedBox(height: 6),
                                  if (_availableGates.isEmpty)
                                    const Text('No configured LC Gates under this station.', style: TextStyle(fontSize: 11.5, color: Colors.grey, fontStyle: FontStyle.italic))
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
                      ],

                      // 5. Verification Notice & Declaration (Section 6)
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
