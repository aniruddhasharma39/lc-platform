import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import '../config.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  final Function(Map<String, dynamic> user, String token) onLogin;
  const LoginScreen({super.key, required this.onLogin});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _identifierCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _isLoading = false;
  bool _obscurePassword = true;
  String _error = '';
  
  Map<String, dynamic> _branding = {'appName': 'LC Platform', 'wallpaperUrl': null};

  @override
  void initState() {
    super.initState();
    _fetchBranding();
  }

  Future<void> _fetchBranding() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/settings/branding'));
      setState(() {
        _branding = json.decode(res.body);
      });
    } catch (e) {
      print(e);
    }
  }

  Future<void> _login() async {
    setState(() {
      _isLoading = true;
      _error = '';
    });
    
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'identifier': _identifierCtrl.text,
          'password': _passwordCtrl.text
        })
      );
      
      final data = json.decode(res.body);
      
      if (res.statusCode == 200) {
        widget.onLogin(data['user'], data['token']);
      } else {
        setState(() => _error = data['error'] ?? 'Login failed');
      }
    } catch (e) {
      setState(() => _error = 'Network error');
    } finally {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: _branding['wallpaperUrl'] != null ? BoxDecoration(
          image: DecorationImage(
            image: NetworkImage(_branding['wallpaperUrl']),
            fit: BoxFit.cover,
            colorFilter: ColorFilter.mode(Colors.black.withOpacity(0.5), BlendMode.darken),
          ),
        ) : const BoxDecoration(color: Color(0xFFF8F9FA)), // AppColors.background
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Card(
                color: Colors.white.withOpacity(0.95),
                elevation: 4,
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Login to ${_branding['appName']}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 24),
                    if (_error.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.all(12),
                        margin: const EdgeInsets.only(bottom: 16),
                        color: Colors.red.withOpacity(0.1),
                        child: Text(_error, style: const TextStyle(color: Colors.red)),
                      ),
                    TextField(
                      controller: _identifierCtrl,
                      decoration: const InputDecoration(labelText: 'Mobile, Email or Employee ID'),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _passwordCtrl,
                      obscureText: _obscurePassword,
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          icon: Icon(_obscurePassword ? Icons.visibility : Icons.visibility_off),
                          onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                        )
                      ),
                    ),
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _isLoading ? null : _login,
                        child: _isLoading ? const CircularProgressIndicator(color: Colors.white) : const Text('Login'),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Text('New user? '),
                        TextButton(
                          onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RegisterScreen())),
                          child: const Text('Register'),
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
}
