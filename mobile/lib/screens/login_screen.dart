import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
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

  Future<void> _login() async {
    setState(() {
      _isLoading = true;
      _error = '';
    });
    
    try {
      final res = await http.post(
        Uri.parse('http://10.0.2.2:5001/api/v1/auth/login'),
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
      // Fallback to localhost if not on emulator
      try {
        final res = await http.post(
          Uri.parse('http://localhost:5001/api/v1/auth/login'),
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
      } catch (e2) {
        setState(() => _error = 'Network error');
      }
    } finally {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Card(
              color: Colors.white,
              elevation: 4,
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Login to LC Platform', style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.bold)),
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
      )
    );
  }
}
