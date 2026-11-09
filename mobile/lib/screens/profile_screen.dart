import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class ProfileScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const ProfileScreen({super.key, required this.user});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late Map<String, dynamic> _profile;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _profile = Map<String, dynamic>.from(widget.user);
    _fetchFreshProfile();
  }

  Future<void> _fetchFreshProfile({bool isManual = false}) async {
    setState(() => _isLoading = true);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('token') ?? '';
      final res = await http.get(
        Uri.parse('$baseUrl/auth/me'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _profile = data;
          });
          if (isManual) {
            AppFeedback.showSuccess(context, 'Profile details refreshed successfully.');
          }
        }
      } else {
        if (mounted && isManual) {
          AppFeedback.showError(context, 'Failed to refresh profile (${res.statusCode}).');
        }
      }
    } catch (_) {
      if (mounted && isManual) {
        AppFeedback.showError(context, 'Unable to refresh profile. Check network connection.');
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  bool _isImageUrl(dynamic val) {
    if (val == null) return false;
    final str = val.toString().trim();
    if (str.startsWith('http://') || str.startsWith('https://')) {
      final lower = str.toLowerCase();
      if (lower.contains('/image/upload/') ||
          lower.endsWith('.png') ||
          lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.webp') ||
          lower.endsWith('.gif')) {
        return true;
      }
    }
    return false;
  }

  String _humanizeKey(String key) {
    final cleanKey = key.trim();
    final normalized = cleanKey.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
    if (normalized == 'fullname' || normalized == 'name' || normalized == 'applicantname') return 'Full Name';
    if (normalized == 'mobile' || normalized == 'phone' || normalized == 'mobilenumber' || normalized == 'phonenumber') return 'Mobile Number';
    if (normalized == 'email' || normalized == 'emailaddress') return 'Email Address';
    if (normalized == 'employeeid' || normalized == 'empid') return 'Employee ID';
    if (normalized == 'department' || normalized == 'dept') return 'Department';
    if (normalized == 'gender') return 'Gender';
    if (normalized == 'roleid') return 'Role ID';
    if (cleanKey.startsWith('field_')) {
      final sub = cleanKey.substring(6);
      return sub.length > 6 ? 'Custom Field (${sub.substring(sub.length - 4)})' : 'Custom Field ($sub)';
    }
    final spaced = cleanKey
        .replaceAllMapped(RegExp(r'([A-Z])'), (m) => ' ${m[0]}')
        .replaceAll('_', ' ')
        .trim();
    if (spaced.isEmpty) return key;
    return spaced[0].toUpperCase() + spaced.substring(1);
  }

  void _showImageDialog(String url, String label) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(16),
        child: Stack(
          alignment: Alignment.topRight,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.network(
                      url,
                      fit: BoxFit.contain,
                      loadingBuilder: (c, child, p) => p == null
                          ? child
                          : const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
                      errorBuilder: (c, e, s) =>
                          const Padding(padding: EdgeInsets.all(24), child: Text('Failed to load image')),
                    ),
                  ),
                ],
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: IconButton(
                icon: const CircleAvatar(
                    backgroundColor: Colors.black54,
                    radius: 14,
                    child: Icon(Icons.close, color: Colors.white, size: 16)),
                onPressed: () => Navigator.pop(ctx),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final fullName = _profile['fullName'] ?? 'User';
    final roleName = _profile['role'] ?? 'Member';
    final email = _profile['email'] ?? 'N/A';
    final mobile = _profile['mobile'] ?? 'N/A';
    final empId = _profile['employeeId'] ?? 'N/A';
    final department = _profile['department'] ?? 'N/A';
    final status = _profile['status'] ?? 'APPROVED';
    final initials = fullName.length >= 2 ? fullName.substring(0, 2).toUpperCase() : 'U';

    Map<String, dynamic> metadata = {};
    try {
      if (_profile['metadata'] != null) {
        if (_profile['metadata'] is Map) {
          metadata = Map<String, dynamic>.from(_profile['metadata']);
        } else if (_profile['metadata'] is String) {
          metadata = json.decode(_profile['metadata']);
        }
      }
    } catch (_) {}

    final coreExclude = {
      'fullname', 'name', 'applicantname',
      'mobile', 'mobilenumber', 'phone', 'phonenumber',
      'email', 'emailaddress',
      'employeeid', 'empid',
      'department', 'dept',
      'role', 'roleid', 'password', 'status', 'id',
      // Internal system fields & confirmations
      'stationid', 'station', 'gateids', 'gateid',
      'declarationconfirmed', 'declaration', 'confirm', 'agreed', 'terms',
      'idcard', 'form'
    };
    final customEntries = metadata.entries.where((e) {
      final normK = e.key.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
      if (normK.contains('password') || coreExclude.contains(normK)) return false;
      final valStr = e.value?.toString().trim() ?? '';
      if (valStr.isEmpty || valStr == 'null' || valStr == '[]') return false;
      if (e.value is List && (e.value as List).isEmpty) return false;
      return true;
    }).toList();

    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      appBar: AppBar(
        title: const Text('Profile Settings', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        actions: [
          if (_isLoading)
            const Padding(
              padding: EdgeInsets.all(16),
              child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh Profile',
              onPressed: () => _fetchFreshProfile(isManual: true),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _fetchFreshProfile(isManual: true),
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
          child: Column(
            children: [
              // Top Hero Card
              Card(
                elevation: 0,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                  side: BorderSide(color: Colors.grey.shade300),
                ),
                color: Colors.white,
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      CircleAvatar(
                        radius: 36,
                        backgroundColor: AppColors.primary,
                        child: Text(
                          initials,
                          style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold, color: Colors.white),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        fullName,
                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.black87),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: AppColors.secondary.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Text(
                              roleName,
                              style: const TextStyle(
                                color: AppColors.secondary,
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          if (roleName.toLowerCase() != 'developer' && roleName.toLowerCase() != 'system admin') ...[
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                              decoration: BoxDecoration(
                                color: AppColors.success.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Text(
                                status,
                                style: const TextStyle(
                                  color: AppColors.success,
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Account Information Section
              Card(
                elevation: 0,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                  side: BorderSide(color: Colors.grey.shade300),
                ),
                color: Colors.white,
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.badge_outlined, color: AppColors.primary, size: 20),
                          const SizedBox(width: 8),
                          const Text(
                            'Account Details',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.primary),
                          ),

                        ],
                      ),
                      const Divider(height: 24),
                      _buildInfoTile('Full Name', fullName, Icons.person),
                      _buildInfoTile('Employee ID', empId, Icons.badge),
                      _buildInfoTile('Department', department, Icons.business),
                      _buildInfoTile('Mobile Number', mobile, Icons.phone),
                      _buildInfoTile('Email Address', email, Icons.email),
                      _buildInfoTile('Assigned Role', roleName, Icons.security),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),

              if (customEntries.isNotEmpty && roleName.toLowerCase() != 'developer' && roleName.toLowerCase() != 'system admin') ...[
                // Registration Metadata Section
              Card(
                elevation: 0,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                  side: BorderSide(color: Colors.grey.shade300),
                ),
                color: Colors.white,
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.assignment_outlined, color: AppColors.secondary, size: 20),
                          const SizedBox(width: 8),
                          const Text(
                            'Registration Form Submissions',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.secondary),
                          ),
                        ],
                      ),
                      const Divider(height: 24),
                      if (customEntries.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 8),
                          child: Text(
                            'No additional custom registration fields submitted.',
                            style: TextStyle(color: Colors.grey, fontSize: 13, fontStyle: FontStyle.italic),
                          ),
                        )
                      else
                        ...customEntries.map((entry) {
                          final label = _humanizeKey(entry.key);
                          final isImg = _isImageUrl(entry.value);

                          return Padding(
                            padding: const EdgeInsets.only(bottom: 14),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  flex: 2,
                                  child: Text(
                                    label,
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: Colors.grey.shade700,
                                    ),
                                  ),
                                ),
                                Expanded(
                                  flex: 3,
                                  child: isImg
                                      ? Align(
                                          alignment: Alignment.centerLeft,
                                          child: InkWell(
                                            onTap: () => _showImageDialog(entry.value.toString(), label),
                                            child: Container(
                                              height: 60,
                                              width: 90,
                                              decoration: BoxDecoration(
                                                borderRadius: BorderRadius.circular(8),
                                                border: Border.all(color: Colors.grey.shade300),
                                              ),
                                              clipBehavior: Clip.antiAlias,
                                              child: Stack(
                                                alignment: Alignment.center,
                                                children: [
                                                  Image.network(
                                                    entry.value.toString(),
                                                    fit: BoxFit.cover,
                                                    width: double.infinity,
                                                    height: double.infinity,
                                                    errorBuilder: (_, _, _) => const Center(
                                                        child: Icon(Icons.broken_image, size: 20, color: Colors.grey)),
                                                  ),
                                                  Positioned(
                                                    bottom: 2,
                                                    right: 2,
                                                    child: Container(
                                                      padding: const EdgeInsets.all(2),
                                                      decoration: BoxDecoration(
                                                          color: Colors.black54, borderRadius: BorderRadius.circular(4)),
                                                      child: const Icon(Icons.zoom_in, color: Colors.white, size: 12),
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ),
                                        )
                                      : Text(
                                          entry.value.toString(),
                                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
                                        ),
                                ),
                              ],
                            ),
                          );
                        }),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 20),


                            ],const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildInfoTile(String title, String value, IconData icon) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: Colors.grey.shade500),
          const SizedBox(width: 10),
          Expanded(
            flex: 2,
            child: Text(
              title,
              style: TextStyle(fontSize: 13, color: Colors.grey.shade600, fontWeight: FontWeight.w500),
            ),
          ),
          Expanded(
            flex: 3,
            child: Text(
              value,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.black87),
            ),
          ),
        ],
      ),
    );
  }
}
