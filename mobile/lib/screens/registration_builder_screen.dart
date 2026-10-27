import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class RegistrationBuilderScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const RegistrationBuilderScreen({super.key, required this.user});

  @override
  State<RegistrationBuilderScreen> createState() => _RegistrationBuilderScreenState();
}

class _RegistrationBuilderScreenState extends State<RegistrationBuilderScreen> {
  bool _isLoading = true;
  List<dynamic> _forms = [];

  @override
  void initState() {
    super.initState();
    _fetchForms();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchForms() async {
    setState(() => _isLoading = true);
    try {
      final token = await _getToken();
      final res = await http.get(
        Uri.parse('$baseUrl/registration-forms'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _forms = (data is List) ? data : [];
          });
        }
      } else if (mounted) {
        AppFeedback.showError(context, 'Failed to load registration forms (HTTP ${res.statusCode})');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _publishForm(int formId, String formName) async {
    try {
      final token = await _getToken();
      final res = await http.put(
        Uri.parse('$baseUrl/registration-forms/$formId/publish'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'Form "$formName" is now LIVE for applicant registrations!');
          _fetchForms();
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to publish form.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error: $e');
    }
  }

  List<dynamic> _extractFields(String? schemaStr) {
    if (schemaStr == null || schemaStr.isEmpty) return [];
    try {
      final schema = json.decode(schemaStr);
      final fields = <dynamic>[];
      void walk(dynamic item) {
        if (item is List) {
          for (final f in item) {
            walk(f);
          }
        } else if (item is Map) {
          if (item['type'] == 'section' && item['children'] != null) {
            walk(item['children']);
          } else if (item['name'] != null || item['label'] != null) {
            fields.add(item);
          }
        }
      }

      if (schema is Map && schema['fields'] != null) {
        walk(schema['fields']);
      } else {
        walk(schema);
      }
      return fields;
    } catch (_) {
      return [];
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: RefreshIndicator(
        onRefresh: _fetchForms,
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.build, color: AppColors.primary, size: 24),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Registration Form Schemas',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'View dynamic field definitions & manage live application forms',
                          style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.refresh, color: AppColors.primary),
                    onPressed: _fetchForms,
                  ),
                ],
              ),
              const SizedBox(height: 14),

              // Desktop Notice Card
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFFEFF6FF),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFFBFDBFE)),
                ),
                child: const Row(
                  children: [
                    Icon(Icons.info_outline, color: Color(0xFF2563EB), size: 20),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Drag-and-drop schema designing is hosted on the Web Developer Console. You can inspect field structures and activate form versions below.',
                        style: TextStyle(fontSize: 12, color: Color(0xFF1E40AF)),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              if (_isLoading)
                const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
              else if (_forms.isEmpty)
                Container(
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: const Center(
                    child: Text('No registration forms registered in database.'),
                  ),
                )
              else
                ..._forms.map((form) {
                  final formId = form['id'] as int;
                  final name = (form['name'] ?? 'Form #$formId').toString();
                  final status = (form['status'] ?? 'DRAFT').toString().toUpperCase();
                  final version = form['version'] ?? 1;
                  final isLive = status == 'LIVE';
                  final fields = _extractFields(form['schema']?.toString());

                  Color statusColor = isLive ? const Color(0xFF16A34A) : Colors.grey;

                  return Card(
                    margin: const EdgeInsets.only(bottom: 12),
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(color: isLive ? AppColors.primary.withOpacity(0.4) : const Color(0xFFE2E8F0)),
                    ),
                    child: ExpansionTile(
                      tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                      title: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A))),
                                Text('Version $version • ${fields.length} Custom Fields', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
                              ],
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: statusColor.withOpacity(0.12),
                              borderRadius: BorderRadius.circular(20),
                              border: Border.all(color: statusColor.withOpacity(0.3)),
                            ),
                            child: Text(
                              status,
                              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: statusColor),
                            ),
                          ),
                        ],
                      ),
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Divider(height: 1, color: Color(0xFFF1F5F9)),
                              const SizedBox(height: 10),
                              const Text('DEFINED SCHEMA FIELDS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                              const SizedBox(height: 8),
                              ...fields.map((f) {
                                final label = f['label'] ?? f['name'] ?? 'Field';
                                final type = f['type'] ?? 'text';
                                final isReq = f['required'] == true;

                                return Container(
                                  margin: const EdgeInsets.only(bottom: 6),
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFFF8FAFC),
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(color: const Color(0xFFE2E8F0)),
                                  ),
                                  child: Row(
                                    children: [
                                      Text(
                                        label,
                                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF1E293B)),
                                      ),
                                      const Spacer(),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(4),
                                          border: Border.all(color: const Color(0xFFCBD5E1)),
                                        ),
                                        child: Text(
                                          type.toString().toUpperCase(),
                                          style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                                        ),
                                      ),
                                      if (isReq) ...[
                                        const SizedBox(width: 4),
                                        const Text('*', style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold)),
                                      ],
                                    ],
                                  ),
                                );
                              }),
                              const SizedBox(height: 10),
                              if (!isLive)
                                ElevatedButton.icon(
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: const Color(0xFF16A34A),
                                    minimumSize: const Size.fromHeight(38),
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                  ),
                                  onPressed: () => _publishForm(formId, name),
                                  icon: const Icon(Icons.check_circle_outline, size: 16, color: Colors.white),
                                  label: const Text('Make Live for Applicant Registrations', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.white)),
                                ),
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
      ),
    );
  }
}
