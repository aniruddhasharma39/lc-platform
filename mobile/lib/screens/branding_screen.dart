import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class BrandingScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const BrandingScreen({super.key, required this.user});

  @override
  State<BrandingScreen> createState() => _BrandingScreenState();
}

class _BrandingScreenState extends State<BrandingScreen> {
  bool _isLoading = true;
  bool _isSaving = false;

  final TextEditingController _appNameCtrl = TextEditingController();
  String _selectedGradient = 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)';

  final List<Map<String, String>> _gradientPresets = [
    {
      'name': 'Railway Blue (Default)',
      'value': 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)',
      'c1': '#0b3c7a',
      'c2': '#0e9aa7',
    },
    {
      'name': 'Midnight Navy',
      'value': 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)',
      'c1': '#0f172a',
      'c2': '#1e3a8a',
    },
    {
      'name': 'Emerald Transit',
      'value': 'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
      'c1': '#064e3b',
      'c2': '#059669',
    },
    {
      'name': 'Amber Signal',
      'value': 'linear-gradient(135deg, #78350f 0%, #d97706 100%)',
      'c1': '#78350f',
      'c2': '#d97706',
    },
  ];

  @override
  void initState() {
    super.initState();
    _fetchBranding();
  }

  @override
  void dispose() {
    _appNameCtrl.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchBranding() async {
    setState(() => _isLoading = true);
    try {
      final res = await http.get(Uri.parse('$baseUrl/settings/branding'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _appNameCtrl.text = data['appName'] ?? 'LC Platform';
            _selectedGradient = data['loginGradient'] ?? _gradientPresets[0]['value']!;
          });
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Failed to load branding: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _saveBranding() async {
    if (_appNameCtrl.text.trim().isEmpty) {
      AppFeedback.showError(context, 'Application name cannot be empty.');
      return;
    }

    setState(() => _isSaving = true);
    try {
      final token = await _getToken();
      final req = http.MultipartRequest('PUT', Uri.parse('$baseUrl/settings/branding'));
      req.headers['Authorization'] = 'Bearer $token';
      req.fields['appName'] = _appNameCtrl.text.trim();
      req.fields['loginGradient'] = _selectedGradient;

      final streamedRes = await req.send();
      final res = await http.Response.fromStream(streamedRes);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        final data = json.decode(res.body);
        final prefs = await SharedPreferences.getInstance();
        prefs.setString('cached_branding', json.encode(data));

        if (mounted) {
          AppFeedback.showSuccess(context, 'Branding updated successfully!');
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) {
          AppFeedback.showError(context, err['error'] ?? 'Failed to update branding.');
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error saving branding: $e');
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  Color _parseHex(String hex) {
    try {
      return Color(int.parse(hex.replaceAll('#', '0xFF')));
    } catch (_) {
      return AppColors.primary;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: SingleChildScrollView(
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
                  child: const Icon(Icons.brush, color: AppColors.primary, size: 24),
                ),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Platform Branding',
                        style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                      ),
                      Text(
                        'Customize global application name, gradients & identity',
                        style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),

            // Live Mobile Preview Card
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: const BorderSide(color: Color(0xFFE2E8F0)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'BRANDING LIVE PREVIEW',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B)),
                    ),
                    const SizedBox(height: 10),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [
                            _parseHex(_gradientPresets.firstWhere((p) => p['value'] == _selectedGradient, orElse: () => _gradientPresets[0])['c1']!),
                            _parseHex(_gradientPresets.firstWhere((p) => p['value'] == _selectedGradient, orElse: () => _gradientPresets[0])['c2']!),
                          ],
                        ),
                        borderRadius: BorderRadius.circular(10),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.12),
                            blurRadius: 10,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      child: Column(
                        children: [
                          const Icon(Icons.train, color: Colors.white, size: 36),
                          const SizedBox(height: 8),
                          Text(
                            _appNameCtrl.text.isNotEmpty ? _appNameCtrl.text : 'LC Platform',
                            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 4),
                          const Text(
                            'Level Crossing Automation System',
                            style: TextStyle(fontSize: 11, color: Colors.white70),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // App Name Field Card
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: const BorderSide(color: Color(0xFFE2E8F0)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('APPLICATION TITLE', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _appNameCtrl,
                      decoration: InputDecoration(
                        hintText: 'e.g. Indian Railways - Boom Barrier Platform',
                        filled: true,
                        fillColor: const Color(0xFFF8FAFC),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
                        ),
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Gradient Theme Selection Card
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: const BorderSide(color: Color(0xFFE2E8F0)),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('LOGIN & HEADER GRADIENT PRESET', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    const SizedBox(height: 10),
                    ..._gradientPresets.map((preset) {
                      final isSelected = _selectedGradient == preset['value'];
                      return InkWell(
                        onTap: () => setState(() => _selectedGradient = preset['value']!),
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                          decoration: BoxDecoration(
                            color: isSelected ? const Color(0xFFF1F5F9) : Colors.white,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: isSelected ? AppColors.primary : const Color(0xFFE2E8F0),
                              width: isSelected ? 1.5 : 1,
                            ),
                          ),
                          child: Row(
                            children: [
                              Container(
                                width: 24,
                                height: 24,
                                decoration: BoxDecoration(
                                  gradient: LinearGradient(
                                    colors: [_parseHex(preset['c1']!), _parseHex(preset['c2']!)],
                                  ),
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  preset['name']!,
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                                    color: isSelected ? AppColors.primary : const Color(0xFF1E293B),
                                  ),
                                ),
                              ),
                              if (isSelected) const Icon(Icons.check_circle, color: AppColors.primary, size: 18),
                            ],
                          ),
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Save Changes Button
            ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                minimumSize: const Size.fromHeight(48),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              onPressed: _isSaving ? null : _saveBranding,
              icon: _isSaving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                  : const Icon(Icons.save, color: Colors.white),
              label: Text(
                _isSaving ? 'Saving Changes...' : 'Save Branding Configuration',
                style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
