import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class GradientPreset {
  final String id;
  final String name;
  final String color1;
  final String color2;
  final String angle;
  final String css;

  const GradientPreset({
    required this.id,
    required this.name,
    required this.color1,
    required this.color2,
    required this.angle,
    required this.css,
  });
}

const List<GradientPreset> _gradientPresets = [
  GradientPreset(
    id: 'railway-blue',
    name: 'Railway Blue',
    color1: '#0b3c7a',
    color2: '#0e9aa7',
    angle: '135deg',
    css: 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)',
  ),
  GradientPreset(
    id: 'midnight-navy',
    name: 'Midnight Navy',
    color1: '#0f172a',
    color2: '#1e3a8a',
    angle: '135deg',
    css: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)',
  ),
  GradientPreset(
    id: 'royal-indigo',
    name: 'Royal Indigo',
    color1: '#1e1b4b',
    color2: '#4338ca',
    angle: '135deg',
    css: 'linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)',
  ),
  GradientPreset(
    id: 'steel-slate',
    name: 'Steel Slate',
    color1: '#1e293b',
    color2: '#475569',
    angle: '135deg',
    css: 'linear-gradient(135deg, #1e293b 0%, #475569 100%)',
  ),
  GradientPreset(
    id: 'ocean-teal',
    name: 'Ocean Teal',
    color1: '#042f2e',
    color2: '#0d9488',
    angle: '135deg',
    css: 'linear-gradient(135deg, #042f2e 0%, #0d9488 100%)',
  ),
  GradientPreset(
    id: 'crimson-express',
    name: 'Crimson Express',
    color1: '#450a0a',
    color2: '#991b1b',
    angle: '135deg',
    css: 'linear-gradient(135deg, #450a0a 0%, #991b1b 100%)',
  ),
  GradientPreset(
    id: 'forest-emerald',
    name: 'Forest Emerald',
    color1: '#064e3b',
    color2: '#059669',
    angle: '135deg',
    css: 'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
  ),
  GradientPreset(
    id: 'obsidian-noir',
    name: 'Obsidian Noir',
    color1: '#09090b',
    color2: '#27272a',
    angle: '135deg',
    css: 'linear-gradient(135deg, #09090b 0%, #27272a 100%)',
  ),
];

const List<Map<String, String>> _angleOptions = [
  {'label': '↘ 135°', 'value': '135deg'},
  {'label': '↓ 180°', 'value': '180deg'},
  {'label': '→ 90°', 'value': '90deg'},
  {'label': '↗ 45°', 'value': '45deg'},
];

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
  final TextEditingController _color1Ctrl = TextEditingController();
  final TextEditingController _color2Ctrl = TextEditingController();

  String _initialAppName = 'LC Platform';
  String _initialGradient = 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)';
  String? _serverWallpaperUrl;

  String _color1 = '#0b3c7a';
  String _color2 = '#0e9aa7';
  String _angle = '135deg';
  String _loginGradient = 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)';

  XFile? _draftFile;
  final ImagePicker _picker = ImagePicker();

  @override
  void initState() {
    super.initState();
    _fetchBranding();
  }

  @override
  void dispose() {
    _appNameCtrl.dispose();
    _color1Ctrl.dispose();
    _color2Ctrl.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  void _parseGradientString(String grad) {
    _loginGradient = grad;
    final exp = RegExp(
      r'linear-gradient\(\s*([\w\d]+)\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))\s*(?:\d+%)?\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))',
      caseSensitive: false,
    );
    final match = exp.firstMatch(grad);
    if (match != null) {
      _angle = match.group(1) ?? '135deg';
      final c1 = match.group(2) ?? '#0b3c7a';
      final c2 = match.group(3) ?? '#0e9aa7';
      _color1 = c1.startsWith('#') ? c1 : '#0b3c7a';
      _color2 = c2.startsWith('#') ? c2 : '#0e9aa7';
    } else {
      _angle = '135deg';
      _color1 = '#0b3c7a';
      _color2 = '#0e9aa7';
    }
    _color1Ctrl.text = _color1;
    _color2Ctrl.text = _color2;
  }

  Future<void> _fetchBranding() async {
    setState(() => _isLoading = true);
    try {
      final res = await http.get(Uri.parse('$baseUrl/settings/branding'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _initialAppName = data['appName'] ?? 'LC Platform';
            _appNameCtrl.text = _initialAppName;

            _serverWallpaperUrl = data['wallpaperUrl'] ?? data['logoUrl'];
            _initialGradient = data['loginGradient'] ?? _gradientPresets[0].css;
            _parseGradientString(_initialGradient);
          });
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Failed to load branding: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _applyPreset(GradientPreset preset) {
    setState(() {
      _color1 = preset.color1;
      _color2 = preset.color2;
      _angle = preset.angle;
      _loginGradient = preset.css;
      _color1Ctrl.text = _color1;
      _color2Ctrl.text = _color2;
    });
    AppFeedback.showInfo(context, 'Applied "${preset.name}" preset');
  }

  void _updateCustomGradient() {
    setState(() {
      _loginGradient = 'linear-gradient($_angle, $_color1 0%, $_color2 100%)';
    });
  }

  Future<void> _pickLogo() async {
    try {
      final photo = await _picker.pickImage(source: ImageSource.gallery, imageQuality: 85);
      if (photo != null) {
        setState(() {
          _draftFile = photo;
        });
        if (mounted) {
          AppFeedback.showSuccess(context, 'Selected logo: ${photo.name}');
        }
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error selecting image: $e');
    }
  }

  void _removeDraftLogo() {
    setState(() {
      _draftFile = null;
    });
    AppFeedback.showInfo(context, 'Drafted logo removed. Server logo preserved.');
  }

  void _resetToCurrent() {
    setState(() {
      _appNameCtrl.text = _initialAppName;
      _draftFile = null;
      _parseGradientString(_initialGradient);
    });
    AppFeedback.showInfo(context, 'Restored branding to current saved settings.');
  }

  Future<void> _saveBranding() async {
    final appName = _appNameCtrl.text.trim();
    if (appName.isEmpty) {
      AppFeedback.showError(context, 'Application name cannot be empty.');
      return;
    }

    setState(() => _isSaving = true);
    try {
      final token = await _getToken();
      final req = http.MultipartRequest('PUT', Uri.parse('$baseUrl/settings/branding'));
      req.headers['Authorization'] = 'Bearer $token';
      req.fields['appName'] = appName;
      req.fields['loginGradient'] = _loginGradient;

      if (_draftFile != null) {
        final bytes = await _draftFile!.readAsBytes();
        req.files.add(http.MultipartFile.fromBytes(
          'wallpaper',
          bytes,
          filename: _draftFile!.name,
        ));
      }

      final streamedRes = await req.send();
      final res = await http.Response.fromStream(streamedRes);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        final data = json.decode(res.body);
        final prefs = await SharedPreferences.getInstance();
        prefs.setString('cached_branding', json.encode(data));

        if (mounted) {
          setState(() {
            _initialAppName = data['appName'] ?? appName;
            _initialGradient = data['loginGradient'] ?? _loginGradient;
            if (data['wallpaperUrl'] != null) {
              _serverWallpaperUrl = data['wallpaperUrl'];
            }
            _draftFile = null;
          });
          AppFeedback.showSuccess(context, 'Platform branding and emblem saved successfully!');
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to save branding.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error updating branding: $e');
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  bool get _isDirty {
    return _appNameCtrl.text.trim() != _initialAppName ||
        _loginGradient != _initialGradient ||
        _draftFile != null;
  }

  Color _parseHex(String hex, {Color fallback = const Color(0xFF0B3C7A)}) {
    try {
      final clean = hex.replaceAll('#', '').trim();
      if (clean.length == 6) {
        return Color(int.parse('FF$clean', radix: 16));
      } else if (clean.length == 8) {
        return Color(int.parse(clean, radix: 16));
      }
      return fallback;
    } catch (_) {
      return fallback;
    }
  }

  Alignment _getGradientBegin(String angle) {
    switch (angle) {
      case '180deg': return Alignment.topCenter;
      case '90deg': return Alignment.centerLeft;
      case '45deg': return Alignment.bottomLeft;
      case '135deg':
      default: return Alignment.topLeft;
    }
  }

  Alignment _getGradientEnd(String angle) {
    switch (angle) {
      case '180deg': return Alignment.bottomCenter;
      case '90deg': return Alignment.centerRight;
      case '45deg': return Alignment.topRight;
      case '135deg':
      default: return Alignment.bottomRight;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        backgroundColor: Color(0xFFF8FAFC),
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final hasActiveLogo = _draftFile != null || (_serverWallpaperUrl != null && _serverWallpaperUrl!.isNotEmpty);

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ── Top Header Banner ──────────────────────────────────────────
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
                          'Branding & Visual Identity',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                        ),
                        Text(
                          'Configure platform naming, emblem insignia & background theme',
                          style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // ── Dirty State Warning Bar ────────────────────────────────────
              if (_isDirty) ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFFBEB),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFFDE68A)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.warning_amber_rounded, size: 18, color: Color(0xFFD97706)),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text(
                          'Unsaved branding changes detected.',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFFB45309)),
                        ),
                      ),
                      TextButton(
                        onPressed: _resetToCurrent,
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: const Text('Revert', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFFB45309))),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
              ],

              // ── Panel 1: Application Identity ──────────────────────────────
              _buildPanelCard(
                title: 'Application Identity',
                subtitle: 'Displayed across header navigation, login page, and titles.',
                icon: Icons.label_outline,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('Application Name', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                        Text('${_appNameCtrl.text.length} / 50', style: const TextStyle(fontSize: 11, color: Color(0xFF94A3B8))),
                      ],
                    ),
                    const SizedBox(height: 6),
                    TextField(
                      controller: _appNameCtrl,
                      maxLength: 50,
                      decoration: InputDecoration(
                        counterText: '',
                        prefixIcon: const Icon(Icons.auto_awesome, size: 18, color: AppColors.primary),
                        hintText: 'e.g. Indian Railways - LC Barrier Portal',
                        filled: true,
                        fillColor: const Color(0xFFF8FAFC),
                        isDense: true,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFFCBD5E1))),
                        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: Color(0xFFE2E8F0))),
                        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: const BorderSide(color: AppColors.primary, width: 1.5)),
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              // ── Panel 2: Login Card Emblem & Insignia ──────────────────────
              _buildPanelCard(
                title: 'Login Card Emblem & Logo',
                subtitle: 'Uploaded insignia appears centered inside the login box above the platform title.',
                icon: Icons.image_outlined,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (hasActiveLogo) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF8FAFC),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: Row(
                          children: [
                            // Thumbnail
                            Container(
                              width: 50,
                              height: 50,
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: const Color(0xFFCBD5E1)),
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(6),
                                child: _draftFile != null
                                    ? (kIsWeb
                                        ? Image.network(_draftFile!.path, fit: BoxFit.contain)
                                        : Image.file(File(_draftFile!.path), fit: BoxFit.contain))
                                    : Image.network(
                                        _serverWallpaperUrl!,
                                        fit: BoxFit.contain,
                                        errorBuilder: (_, _, _) => const Icon(Icons.broken_image, color: Colors.grey),
                                      ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _draftFile != null ? _draftFile!.name : 'Current Active Logo',
                                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 4),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: _draftFile != null ? const Color(0xFFFEF3C7) : const Color(0xFFDCFCE7),
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      _draftFile != null ? 'Draft (Unsaved)' : 'Live on Cloudinary',
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                        color: _draftFile != null ? const Color(0xFFB45309) : const Color(0xFF15803D),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            OutlinedButton.icon(
                              onPressed: _pickLogo,
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                              ),
                              icon: const Icon(Icons.photo_library, size: 14),
                              label: const Text('Replace', style: TextStyle(fontSize: 11)),
                            ),
                            if (_draftFile != null) ...[
                              const SizedBox(width: 4),
                              IconButton(
                                icon: const Icon(Icons.delete_outline, size: 18, color: Colors.red),
                                tooltip: 'Revert draft logo',
                                onPressed: _removeDraftLogo,
                              ),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                    ] else ...[
                      // Dropzone Placeholder
                      InkWell(
                        onTap: _pickLogo,
                        borderRadius: BorderRadius.circular(8),
                        child: Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
                          decoration: BoxDecoration(
                            color: const Color(0xFFF8FAFC),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: const Color(0xFFCBD5E1), style: BorderStyle.solid),
                          ),
                          child: Column(
                            children: [
                              Container(
                                padding: const EdgeInsets.all(10),
                                decoration: BoxDecoration(color: AppColors.primary.withOpacity(0.1), shape: BoxShape.circle),
                                child: const Icon(Icons.cloud_upload_outlined, color: AppColors.primary, size: 28),
                              ),
                              const SizedBox(height: 8),
                              const Text('Choose emblem or logo', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.primary)),
                              const SizedBox(height: 2),
                              const Text('PNG, JPG, or SVG with transparent background', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 14),

              // ── Panel 3: Login Background Gradient Studio ──────────────────
              _buildPanelCard(
                title: 'Login Background Gradient Studio',
                subtitle: 'Select a curated preset or blend custom colors to create your full-bleed login background.',
                icon: Icons.palette_outlined,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('CURATED GRADIENT PRESETS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    const SizedBox(height: 8),

                    // Grid of 8 Presets (Matching Web)
                    GridView.builder(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 2,
                        childAspectRatio: 2.5,
                        crossAxisSpacing: 8,
                        mainAxisSpacing: 8,
                      ),
                      itemCount: _gradientPresets.length,
                      itemBuilder: (ctx, idx) {
                        final preset = _gradientPresets[idx];
                        final isSelected = _loginGradient == preset.css;
                        return InkWell(
                          onTap: () => _applyPreset(preset),
                          borderRadius: BorderRadius.circular(8),
                          child: Container(
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: isSelected ? const Color(0xFFEFF6FF) : Colors.white,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: isSelected ? AppColors.primary : const Color(0xFFE2E8F0),
                                width: isSelected ? 1.5 : 1,
                              ),
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 28,
                                  height: 28,
                                  decoration: BoxDecoration(
                                    gradient: LinearGradient(
                                      begin: Alignment.topLeft,
                                      end: Alignment.bottomRight,
                                      colors: [_parseHex(preset.color1), _parseHex(preset.color2)],
                                    ),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: isSelected ? const Icon(Icons.check, size: 16, color: Colors.white) : null,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    preset.name,
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                                      color: isSelected ? AppColors.primary : const Color(0xFF1E293B),
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                    const SizedBox(height: 14),

                    // Custom Gradient Controls
                    const Text('CUSTOM GRADIENT CONTROLS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    const SizedBox(height: 8),

                    Row(
                      children: [
                        // Start Color
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('Start Color', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  Container(
                                    width: 24,
                                    height: 24,
                                    decoration: BoxDecoration(
                                      color: _parseHex(_color1),
                                      shape: BoxShape.circle,
                                      border: Border.all(color: const Color(0xFFCBD5E1)),
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: TextField(
                                      controller: _color1Ctrl,
                                      decoration: InputDecoration(
                                        hintText: '#0b3c7a',
                                        isDense: true,
                                        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
                                      ),
                                      onChanged: (val) {
                                        _color1 = val;
                                        _updateCustomGradient();
                                      },
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        // End Color
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('End Color', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  Container(
                                    width: 24,
                                    height: 24,
                                    decoration: BoxDecoration(
                                      color: _parseHex(_color2),
                                      shape: BoxShape.circle,
                                      border: Border.all(color: const Color(0xFFCBD5E1)),
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: TextField(
                                      controller: _color2Ctrl,
                                      decoration: InputDecoration(
                                        hintText: '#0e9aa7',
                                        isDense: true,
                                        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
                                      ),
                                      onChanged: (val) {
                                        _color2 = val;
                                        _updateCustomGradient();
                                      },
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),

                    // Angle Options
                    const Text('Angle / Flow', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                    const SizedBox(height: 6),
                    Row(
                      children: _angleOptions.map((opt) {
                        final isSel = _angle == opt['value'];
                        return Expanded(
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 2),
                            child: OutlinedButton(
                              style: OutlinedButton.styleFrom(
                                padding: const EdgeInsets.symmetric(vertical: 6),
                                backgroundColor: isSel ? AppColors.primary : Colors.white,
                                side: BorderSide(color: isSel ? AppColors.primary : const Color(0xFFCBD5E1)),
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                              ),
                              onPressed: () {
                                setState(() => _angle = opt['value']!);
                                _updateCustomGradient();
                              },
                              child: Text(
                                opt['label']!,
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: isSel ? Colors.white : const Color(0xFF475569),
                                ),
                              ),
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              // ── Panel 4: Live Interactive Authentication Screen Preview ────
              _buildPanelCard(
                title: 'Live Screen Preview',
                subtitle: 'Real-time preview of the authentication screen with custom background and emblem.',
                icon: Icons.remove_red_eye_outlined,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: _getGradientBegin(_angle),
                      end: _getGradientEnd(_angle),
                      colors: [_parseHex(_color1), _parseHex(_color2)],
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
                  child: Center(
                    child: Container(
                      width: double.infinity,
                      constraints: const BoxConstraints(maxWidth: 300),
                      padding: const EdgeInsets.all(18),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.15),
                            blurRadius: 15,
                            offset: const Offset(0, 8),
                          ),
                        ],
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // Insignia
                          if (hasActiveLogo) ...[
                            Container(
                              width: 48,
                              height: 48,
                              margin: const EdgeInsets.only(bottom: 8),
                              child: _draftFile != null
                                  ? (kIsWeb
                                      ? Image.network(_draftFile!.path, fit: BoxFit.contain)
                                      : Image.file(File(_draftFile!.path), fit: BoxFit.contain))
                                  : Image.network(
                                      _serverWallpaperUrl!,
                                      fit: BoxFit.contain,
                                      errorBuilder: (_, _, _) => const Icon(Icons.broken_image, color: Colors.grey),
                                    ),
                            ),
                          ] else ...[
                            Container(
                              width: 44,
                              height: 44,
                              margin: const EdgeInsets.only(bottom: 8),
                              decoration: BoxDecoration(color: const Color(0xFFF1F5F9), shape: BoxShape.circle),
                              child: const Icon(Icons.image, color: Colors.grey, size: 24),
                            ),
                          ],

                          // Title
                          Text(
                            _appNameCtrl.text.trim().isNotEmpty ? _appNameCtrl.text.trim() : 'LC Platform',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 3),
                          const Text('Sign in to access your dashboard', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                          const SizedBox(height: 12),

                          // Mock inputs
                          Container(
                            height: 32,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: const Color(0xFFE2E8F0)),
                            ),
                            alignment: Alignment.centerLeft,
                            child: const Text('user@example.com', style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8))),
                          ),
                          const SizedBox(height: 6),
                          Container(
                            height: 32,
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: const Color(0xFFE2E8F0)),
                            ),
                            alignment: Alignment.centerLeft,
                            child: const Text('••••••••••••', style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8))),
                          ),
                          const SizedBox(height: 10),

                          // Mock sign in button
                          Container(
                            height: 34,
                            decoration: BoxDecoration(
                              color: _parseHex(_color1),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            alignment: Alignment.center,
                            child: const Text('Sign In', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.white)),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 20),

              // ── Action Buttons Footer ──────────────────────────────────────
              Row(
                children: [
                  if (_isDirty) ...[
                    OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: _resetToCurrent,
                      child: const Text('Reset', style: TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF64748B))),
                    ),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: _isSaving ? null : _saveBranding,
                      icon: _isSaving
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                          : const Icon(Icons.check, color: Colors.white),
                      label: Text(
                        _isSaving ? 'Saving Changes...' : 'Save Branding Settings',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPanelCard({
    required String title,
    required String subtitle,
    required IconData icon,
    required Widget child,
  }) {
    return Card(
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
            Row(
              children: [
                Icon(icon, size: 18, color: AppColors.primary),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Text(subtitle, style: const TextStyle(fontSize: 11.5, color: Color(0xFF64748B))),
            const Divider(height: 20, color: Color(0xFFF1F5F9)),
            child,
          ],
        ),
      ),
    );
  }
}
