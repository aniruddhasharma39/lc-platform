import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  final Map<String, dynamic>? initialBranding;
  final Function(Map<String, dynamic> user, String token) onLogin;
  const LoginScreen({super.key, this.initialBranding, required this.onLogin});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  // Mode: 'password' or 'otp'
  String _mode = 'password';

  // Password Login State
  final _identifierCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _obscurePassword = true;

  // OTP Login State
  String _otpType = 'phone'; // 'phone' or 'email'
  final _phoneCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  bool _otpSent = false;
  bool _sendingOtp = false;
  int _countdown = 0;
  Timer? _countdownTimer;

  // Forgot Password / Reset on OTP State
  bool _wantsReset = false;
  final _newPasswordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  bool _obscureNewPassword = true;
  bool _obscureConfirmPassword = true;

  // Suggestion Alert (e.g. registered with phone, tried email)
  Map<String, String>? _suggestion;

  // Status & Branding
  bool _isLoading = false;
  String _error = '';
  String _successMsg = '';
  bool _hasEmailField = true;
  bool _hasPhoneField = true;
  late Map<String, dynamic> _branding;

  @override
  void initState() {
    super.initState();
    _branding = widget.initialBranding ?? {'appName': 'LC Platform', 'wallpaperUrl': null};
    _loadCachedBranding();
    _fetchFormCapabilities();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final logoUrl = _branding['logoUrl'] ?? _branding['wallpaperUrl'];
    if (logoUrl != null && logoUrl.toString().trim().isNotEmpty) {
      precacheImage(NetworkImage(logoUrl.toString()), context).catchError((_) {});
    }
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _identifierCtrl.dispose();
    _passwordCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _otpCtrl.dispose();
    _newPasswordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    super.dispose();
  }

  void _startCountdown() {
    _countdownTimer?.cancel();
    setState(() => _countdown = 60);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_countdown <= 1) {
        timer.cancel();
        setState(() => _countdown = 0);
      } else {
        setState(() => _countdown--);
      }
    });
  }

  Future<void> _loadCachedBranding() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final cached = prefs.getString('cached_branding');
      if (cached != null && cached.isNotEmpty) {
        final data = json.decode(cached);
        if (data is Map<String, dynamic> && mounted) {
          setState(() => _branding = data);
          final logoUrl = _branding['logoUrl'] ?? _branding['wallpaperUrl'];
          if (logoUrl != null && logoUrl.toString().trim().isNotEmpty) {
            precacheImage(NetworkImage(logoUrl.toString()), context).catchError((_) {});
          }
        }
      }
    } catch (_) {}
    _fetchBranding();
  }

  Future<void> _fetchBranding() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/settings/branding')).timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is Map<String, dynamic>) {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setString('cached_branding', json.encode(data));
          if (mounted) {
            setState(() => _branding = data);
            final logoUrl = _branding['logoUrl'] ?? _branding['wallpaperUrl'];
            if (logoUrl != null && logoUrl.toString().trim().isNotEmpty) {
              precacheImage(NetworkImage(logoUrl.toString()), context).catchError((_) {});
            }
          }
        }
      }
    } catch (_) {}
  }

  Future<void> _fetchFormCapabilities() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/auth/registration-form'));
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            if (data['hasEmailField'] != null) _hasEmailField = data['hasEmailField'];
            if (data['hasPhoneField'] != null) _hasPhoneField = data['hasPhoneField'];

            if (_hasPhoneField && !_hasEmailField) {
              _otpType = 'phone';
            } else if (_hasEmailField && !_hasPhoneField) {
              _otpType = 'email';
            }
          });
        }
      }
    } catch (_) {}
  }

  // --- Password Login ---
  Future<void> _loginWithPassword() async {
    final identifier = _identifierCtrl.text.trim();
    final password = _passwordCtrl.text;

    if (identifier.isEmpty || password.isEmpty) {
      const warn = 'Please enter both your identifier and password.';
      setState(() => _error = warn);
      AppFeedback.showWarning(context, warn);
      return;
    }

    setState(() {
      _isLoading = true;
      _error = '';
      _successMsg = '';
    });

    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'identifier': identifier,
          'password': password,
        }),
      );

      final data = json.decode(res.body);
      if (res.statusCode == 200) {
        widget.onLogin(data['user'], data['token']);
      } else {
        final err = data['error'] ?? 'Login failed. Please check credentials.';
        setState(() => _error = err);
        if (mounted) {
          AppFeedback.showError(context, err);
        }
      }
    } catch (_) {
      const netErr = 'Network error. Please ensure backend is running.';
      setState(() => _error = netErr);
      if (mounted) {
        AppFeedback.showError(context, netErr);
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  // --- Send OTP ---
  Future<void> _sendOtp() async {
    setState(() {
      _error = '';
      _successMsg = '';
      _suggestion = null;
    });

    final target = _otpType == 'phone' ? _phoneCtrl.text.trim() : _emailCtrl.text.trim();

    if (_otpType == 'phone') {
      final digits = target.replaceAll(RegExp(r'\D'), '');
      if (!RegExp(r'^[6-9]\d{9}$').hasMatch(digits)) {
        const warn = 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.';
        setState(() => _error = warn);
        AppFeedback.showWarning(context, warn);
        return;
      }
    } else {
      if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(target)) {
        const warn = 'Please enter a valid email address containing @ and domain.';
        setState(() => _error = warn);
        AppFeedback.showWarning(context, warn);
        return;
      }
    }

    setState(() => _sendingOtp = true);

    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/otp/send'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'type': _otpType,
          'identifier': target,
        }),
      );

      final data = json.decode(res.body);

      if (res.statusCode == 200) {
        final successMsg = data['message'] ?? 'OTP sent successfully!';
        setState(() {
          _otpSent = true;
          _successMsg = successMsg;
        });
        _startCountdown();
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            _otpType == 'phone'
                ? 'OTP sent to mobile +91 $target. Valid for 10 minutes.'
                : 'OTP sent to email $target. Valid for 10 minutes.',
          );
        }
      } else {
        if (data['suggestAlternative'] != null && data['suggestionMessage'] != null) {
          setState(() {
            _suggestion = {
              'alternative': data['suggestAlternative'],
              'message': data['suggestionMessage'],
            };
          });
        }
        final err = data['error'] ?? 'Failed to send OTP';
        setState(() => _error = err);
        if (mounted) {
          AppFeedback.showError(context, err);
        }
      }
    } catch (_) {
      const netErr = 'Network error while requesting OTP.';
      setState(() => _error = netErr);
      if (mounted) {
        AppFeedback.showError(context, netErr);
      }
    } finally {
      if (mounted) setState(() => _sendingOtp = false);
    }
  }

  // --- Verify OTP & Login / Reset Password ---
  Future<void> _verifyOtpAndLogin() async {
    setState(() {
      _error = '';
      _successMsg = '';
    });

    final otp = _otpCtrl.text.trim();
    if (otp.length != 6) {
      const warn = 'Please enter the 6-digit OTP code.';
      setState(() => _error = warn);
      AppFeedback.showWarning(context, warn);
      return;
    }

    if (_wantsReset) {
      final newPass = _newPasswordCtrl.text.trim();
      final confirmPass = _confirmPasswordCtrl.text.trim();

      if (newPass.length < 6) {
        const warn = 'New password must be at least 6 characters long.';
        setState(() => _error = warn);
        AppFeedback.showWarning(context, warn);
        return;
      }
      if (newPass != confirmPass) {
        const warn = 'New password and confirm password do not match.';
        setState(() => _error = warn);
        AppFeedback.showWarning(context, warn);
        return;
      }
    }

    setState(() => _isLoading = true);

    try {
      final target = _otpType == 'phone' ? _phoneCtrl.text.trim() : _emailCtrl.text.trim();
      final payload = <String, dynamic>{
        'type': _otpType,
        'identifier': target,
        'otp': otp,
      };

      if (_wantsReset) {
        payload['newPassword'] = _newPasswordCtrl.text.trim();
      }

      final res = await http.post(
        Uri.parse('$baseUrl/auth/otp/verify'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode(payload),
      );

      final data = json.decode(res.body);

      if (res.statusCode == 200) {
        if (mounted) {
          if (_wantsReset) {
            AppFeedback.showSuccess(context, 'Password updated successfully! Welcome back.');
          } else {
            AppFeedback.showSuccess(context, 'Identity verified successfully! Signing in...');
          }
        }
        widget.onLogin(data['user'], data['token']);
      } else {
        final err = data['error'] ?? 'Failed to verify OTP.';
        setState(() => _error = err);
        if (mounted) {
          AppFeedback.showError(context, err);
        }
      }
    } catch (_) {
      const netErr = 'Network error while verifying OTP.';
      setState(() => _error = netErr);
      if (mounted) {
        AppFeedback.showError(context, netErr);
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  LinearGradient _buildBackgroundGradient(String? gradientStr) {
    if (gradientStr == null || gradientStr.isEmpty) {
      return const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF0B3C7A), Color(0xFF0E9AA7)],
      );
    }

    final hexMatches = RegExp(r'#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})').allMatches(gradientStr).toList();
    if (hexMatches.length >= 2) {
      Color parseHex(String hex) {
        String cleanHex = hex.replaceAll('#', '');
        if (cleanHex.length == 3) {
          cleanHex = cleanHex.split('').map((c) => '$c$c').join();
        }
        return Color(int.parse('FF$cleanHex', radix: 16));
      }

      try {
        final c1 = parseHex(hexMatches[0].group(0)!);
        final c2 = parseHex(hexMatches[1].group(0)!);

        Alignment begin = Alignment.topLeft;
        Alignment end = Alignment.bottomRight;
        if (gradientStr.contains('180deg') || gradientStr.contains('to bottom')) {
          begin = Alignment.topCenter;
          end = Alignment.bottomCenter;
        } else if (gradientStr.contains('90deg') || gradientStr.contains('to right')) {
          begin = Alignment.centerLeft;
          end = Alignment.centerRight;
        } else if (gradientStr.contains('45deg')) {
          begin = Alignment.bottomLeft;
          end = Alignment.topRight;
        }

        return LinearGradient(
          begin: begin,
          end: end,
          colors: [c1, c2],
        );
      } catch (_) {}
    }

    return const LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [Color(0xFF0B3C7A), Color(0xFF0E9AA7)],
    );
  }

  @override
  Widget build(BuildContext context) {
    final logoUrl = _branding['logoUrl'] ?? _branding['wallpaperUrl'];
    final gradientStr = _branding['loginGradient']?.toString();

    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: _buildBackgroundGradient(gradientStr),
        ),
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Card(
                color: Colors.white.withValues(alpha: 0.98),
                elevation: 12,
                shadowColor: Colors.black26,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Logo / Emblem inside Login Box
                      Center(
                        child: Container(
                          constraints: const BoxConstraints(maxHeight: 75, maxWidth: 140),
                          margin: const EdgeInsets.only(bottom: 16),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(12),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: (logoUrl != null && logoUrl.toString().trim().isNotEmpty)
                              ? Image.network(
                                  logoUrl.toString(),
                                  fit: BoxFit.contain,
                                  errorBuilder: (context, error, stackTrace) => Image.asset(
                                    'assets/app_icon.png',
                                    fit: BoxFit.contain,
                                  ),
                                )
                              : Image.asset(
                                  'assets/app_icon.png',
                                  fit: BoxFit.contain,
                                ),
                        ),
                      ),

                      // Header
                      Text(
                        _branding['appName'] ?? 'LC Platform',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w800,
                            ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _mode == 'password'
                            ? 'Sign in to access your dashboard'
                            : 'Password Recovery & OTP Authentication',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                      ),
                      const SizedBox(height: 20),

                      // Error Banner
                      if (_error.isNotEmpty) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppColors.danger.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: AppColors.danger.withValues(alpha: 0.4)),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.warning_amber_rounded, color: AppColors.danger, size: 20),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(_error, style: const TextStyle(color: AppColors.danger, fontSize: 12.5, fontWeight: FontWeight.w500)),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                      ],

                      // Success Banner
                      if (_successMsg.isNotEmpty) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppColors.success.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: AppColors.success.withValues(alpha: 0.4)),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.check_circle_outline, color: AppColors.success, size: 20),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(_successMsg, style: const TextStyle(color: AppColors.success, fontSize: 12.5, fontWeight: FontWeight.w600)),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                      ],

                      // Alternative Suggestion Card
                      if (_suggestion != null) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.amber.shade50,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.amber.shade400),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Text('💡', style: TextStyle(fontSize: 16)),
                                  const SizedBox(width: 6),
                                  Text('Account Notice', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.amber.shade900, fontSize: 13)),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(_suggestion!['message']!, style: TextStyle(color: Colors.brown.shade800, fontSize: 12.5)),
                              const SizedBox(height: 10),
                              SizedBox(
                                width: double.infinity,
                                child: ElevatedButton(
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: AppColors.primary,
                                    padding: const EdgeInsets.symmetric(vertical: 8),
                                  ),
                                  onPressed: () {
                                    final alt = _suggestion!['alternative']!;
                                    setState(() {
                                      _otpType = alt;
                                      _suggestion = null;
                                      _error = '';
                                      _otpSent = false;
                                    });
                                    AppFeedback.showInfo(
                                      context,
                                      alt == 'phone' ? 'Switched to 📱 Mobile OTP' : 'Switched to 📧 Email OTP',
                                    );
                                  },
                                  child: Text(
                                    _suggestion!['alternative'] == 'phone' ? 'Switch to 📱 Mobile OTP' : 'Switch to 📧 Email OTP',
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                ),
                              )
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                      ],

                      // Body based on mode
                      if (_mode == 'password') _buildPasswordLoginForm() else _buildOtpLoginForm(),

                      const SizedBox(height: 20),

                      // Register link
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text('New user? ', style: TextStyle(color: Colors.grey.shade700, fontSize: 13)),
                          TextButton(
                            style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(50, 30), tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                            child: const Text('Register Here', style: TextStyle(fontWeight: FontWeight.bold)),
                          )
                        ],
                      )
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

  // --- Password Form View ---
  Widget _buildPasswordLoginForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _identifierCtrl,
          decoration: const InputDecoration(
            labelText: 'Mobile Number, Email, or Employee ID',
            hintText: 'e.g. 9876543210 or user@example.com',
            prefixIcon: Icon(Icons.person_outline),
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _passwordCtrl,
          obscureText: _obscurePassword,
          decoration: InputDecoration(
            labelText: 'Password',
            prefixIcon: const Icon(Icons.lock_outline),
            suffixIcon: IconButton(
              icon: Icon(_obscurePassword ? Icons.visibility_outlined : Icons.visibility_off_outlined),
              onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            style: TextButton.styleFrom(padding: EdgeInsets.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
            onPressed: () {
              setState(() {
                _mode = 'otp';
                _error = '';
                _successMsg = '';
                _suggestion = null;
              });
              AppFeedback.showInfo(context, 'Switched to OTP Authentication & Password Recovery');
            },
            child: const Text(
              'Forgot Password / Login with OTP →',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12.5),
            ),
          ),
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          onPressed: _isLoading ? null : _loginWithPassword,
          child: _isLoading
              ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
              : const Text('Sign In', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
        ),
      ],
    );
  }

  // --- OTP & Forgot Password View ---
  Widget _buildOtpLoginForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Tabs: Mobile OTP vs Email OTP
        Container(
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: Colors.grey.shade100,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              if (_hasPhoneField)
                Expanded(
                  child: InkWell(
                    onTap: () {
                      setState(() {
                        _otpType = 'phone';
                        _error = '';
                        _suggestion = null;
                        _otpSent = false;
                      });
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      decoration: BoxDecoration(
                        color: _otpType == 'phone' ? Colors.white : Colors.transparent,
                        borderRadius: BorderRadius.circular(8),
                        boxShadow: _otpType == 'phone' ? [const BoxShadow(color: Colors.black12, blurRadius: 4)] : null,
                      ),
                      child: Text(
                        '📱 Mobile OTP',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: _otpType == 'phone' ? FontWeight.bold : FontWeight.w500,
                          color: _otpType == 'phone' ? AppColors.primary : Colors.grey.shade700,
                        ),
                      ),
                    ),
                  ),
                ),
              if (_hasEmailField)
                Expanded(
                  child: InkWell(
                    onTap: () {
                      setState(() {
                        _otpType = 'email';
                        _error = '';
                        _suggestion = null;
                        _otpSent = false;
                      });
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      decoration: BoxDecoration(
                        color: _otpType == 'email' ? Colors.white : Colors.transparent,
                        borderRadius: BorderRadius.circular(8),
                        boxShadow: _otpType == 'email' ? [const BoxShadow(color: Colors.black12, blurRadius: 4)] : null,
                      ),
                      child: Text(
                        '📧 Email OTP',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: _otpType == 'email' ? FontWeight.bold : FontWeight.w500,
                          color: _otpType == 'email' ? AppColors.primary : Colors.grey.shade700,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Target Input
        if (_otpType == 'phone')
          TextField(
            controller: _phoneCtrl,
            enabled: !_otpSent,
            keyboardType: TextInputType.phone,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
            decoration: const InputDecoration(
              labelText: 'Registered Mobile Number *',
              hintText: '9876543210 (10 digits)',
              prefixText: '+91  ',
              prefixStyle: TextStyle(fontWeight: FontWeight.bold, color: Colors.black87),
              prefixIcon: Icon(Icons.phone_outlined),
            ),
          )
        else
          TextField(
            controller: _emailCtrl,
            enabled: !_otpSent,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(
              labelText: 'Registered Email Address *',
              hintText: 'name@example.com',
              prefixIcon: Icon(Icons.email_outlined),
            ),
          ),
        const SizedBox(height: 8),

        // Send OTP / Change Button
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              _otpType == 'phone' ? '10 digits starting with 6-9' : 'Account registered email',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
            if (!_otpSent)
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                ),
                onPressed: _sendingOtp ? null : _sendOtp,
                child: _sendingOtp
                    ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Text('Send OTP', style: TextStyle(fontSize: 12.5)),
              )
            else
              TextButton.icon(
                icon: const Icon(Icons.edit, size: 14),
                label: const Text('Change', style: TextStyle(fontSize: 12.5)),
                onPressed: () {
                  setState(() {
                    _otpSent = false;
                    _otpCtrl.clear();
                  });
                },
              ),
          ],
        ),

        // Once OTP is Sent
        if (_otpSent) ...[
          const Divider(height: 28),


          // OTP Input
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Enter 6-Digit OTP *', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold)),
              if (_countdown > 0)
                Text('Resend in ${_countdown}s', style: TextStyle(color: Colors.grey.shade600, fontSize: 11.5))
              else
                TextButton(
                  style: TextButton.styleFrom(padding: EdgeInsets.zero, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                  onPressed: _sendingOtp ? null : _sendOtp,
                  child: const Text('Resend OTP', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold)),
                ),
            ],
          ),
          const SizedBox(height: 6),
          TextField(
            controller: _otpCtrl,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: 8),
            decoration: const InputDecoration(
              hintText: '••••••',
              contentPadding: EdgeInsets.symmetric(vertical: 12),
            ),
          ),
          const SizedBox(height: 14),

          // Forgot Password / Reset Password Toggle
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.grey.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.grey.shade300),
            ),
            child: Column(
              children: [
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: const Text('Set a new password after login', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.primary)),
                  value: _wantsReset,
                  onChanged: (val) => setState(() => _wantsReset = val ?? false),
                ),
                if (_wantsReset) ...[
                  const Divider(height: 8),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _newPasswordCtrl,
                    obscureText: _obscureNewPassword,
                    decoration: InputDecoration(
                      labelText: 'New Password (min 6 chars)',
                      prefixIcon: const Icon(Icons.lock_reset),
                      suffixIcon: IconButton(
                        icon: Icon(_obscureNewPassword ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                        onPressed: () => setState(() => _obscureNewPassword = !_obscureNewPassword),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _confirmPasswordCtrl,
                    obscureText: _obscureConfirmPassword,
                    decoration: InputDecoration(
                      labelText: 'Confirm New Password',
                      prefixIcon: const Icon(Icons.check_circle_outline),
                      suffixIcon: IconButton(
                        icon: Icon(_obscureConfirmPassword ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                        onPressed: () => setState(() => _obscureConfirmPassword = !_obscureConfirmPassword),
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                ]
              ],
            ),
          ),
          const SizedBox(height: 18),

          ElevatedButton(
            onPressed: _isLoading ? null : _verifyOtpAndLogin,
            child: _isLoading
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                : Text(_wantsReset ? 'Reset Password & Sign In' : 'Verify OTP & Sign In', style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
          ),
        ],

        const SizedBox(height: 14),
        Center(
          child: TextButton(
            onPressed: () {
              setState(() {
                _mode = 'password';
                _error = '';
                _successMsg = '';
                _suggestion = null;
              });
              AppFeedback.showInfo(context, 'Switched to Password Login');
            },
            child: const Text('← Back to Password Login', style: TextStyle(fontSize: 13)),
          ),
        ),
      ],
    );
  }
}
