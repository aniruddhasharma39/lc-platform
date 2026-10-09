import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _nameCtrl = TextEditingController();
  final _mobileCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _empIdCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  
  String _department = 'IT';
  int? _requestedRoleId;
  List<dynamic> _roles = [];
  
  bool _isLoading = false;
  String _error = '';
  bool _success = false;

  @override
  void initState() {
    super.initState();
    _fetchRoles();
  }

  Future<void> _fetchRoles() async {
    try {
      final res = await http.get(Uri.parse('http://10.0.2.2:5001/api/v1/users/roles')).catchError((_) => http.get(Uri.parse('http://localhost:5001/api/v1/users/roles')));
      final data = json.decode(res.body);
      setState(() {
        _roles = data.where((r) => r['name'] != 'Developer').toList();
        if (_roles.isNotEmpty) _requestedRoleId = _roles[0]['id'];
      });
    } catch (e) {
      print(e);
    }
  }

  Future<void> _register() async {
    if (_passwordCtrl.text != _confirmPasswordCtrl.text) {
      setState(() => _error = 'Passwords do not match');
      return;
    }
    
    setState(() {
      _isLoading = true;
      _error = '';
    });
    
    try {
      final body = json.encode({
        'fullName': _nameCtrl.text,
        'mobile': _mobileCtrl.text,
        'email': _emailCtrl.text,
        'employeeId': _empIdCtrl.text,
        'department': _department,
        'requestedRoleId': _requestedRoleId,
        'password': _passwordCtrl.text
      });
      
      final res = await http.post(
        Uri.parse('http://10.0.2.2:5001/api/v1/auth/register'),
        headers: {'Content-Type': 'application/json'},
        body: body
      ).catchError((_) => http.post(
        Uri.parse('http://localhost:5001/api/v1/auth/register'),
        headers: {'Content-Type': 'application/json'},
        body: body
      ));
      
      if (res.statusCode == 201) {
        setState(() => _success = true);
      } else {
        final data = json.decode(res.body);
        setState(() => _error = data['error'] ?? 'Registration failed');
      }
    } catch (e) {
      setState(() => _error = 'Network error');
    } finally {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_success) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.check_circle, color: Colors.green, size: 64),
                const SizedBox(height: 16),
                Text('Registration Successful', style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 16),
                const Text('Your request has been sent to the admin for approval.'),
                const SizedBox(height: 24),
                ElevatedButton(onPressed: () => Navigator.pop(context), child: const Text('Go to Login'))
              ],
            ),
          )
        )
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Register')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
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
                    if (_error.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.all(12),
                        margin: const EdgeInsets.only(bottom: 16),
                        color: Colors.red.withOpacity(0.1),
                        child: Text(_error, style: const TextStyle(color: Colors.red)),
                      ),
                    TextField(controller: _nameCtrl, decoration: const InputDecoration(labelText: 'Full Name')),
                    const SizedBox(height: 16),
                    TextField(controller: _mobileCtrl, decoration: const InputDecoration(labelText: 'Mobile Number')),
                    const SizedBox(height: 16),
                    TextField(controller: _emailCtrl, decoration: const InputDecoration(labelText: 'Email')),
                    const SizedBox(height: 16),
                    TextField(controller: _empIdCtrl, decoration: const InputDecoration(labelText: 'Employee ID')),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: _department,
                      decoration: const InputDecoration(labelText: 'Department'),
                      items: ['IT', 'Operations', 'Maintenance'].map((e) => DropdownMenuItem(value: e, child: Text(e))).toList(),
                      onChanged: (v) => setState(() => _department = v!),
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<int>(
                      value: _requestedRoleId,
                      decoration: const InputDecoration(labelText: 'Role Requested'),
                      items: _roles.map((e) => DropdownMenuItem<int>(value: e['id'], child: Text(e['name']))).toList(),
                      onChanged: (v) => setState(() => _requestedRoleId = v),
                    ),
                    const SizedBox(height: 16),
                    TextField(controller: _passwordCtrl, obscureText: true, decoration: const InputDecoration(labelText: 'Password')),
                    const SizedBox(height: 16),
                    TextField(controller: _confirmPasswordCtrl, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm Password')),
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _isLoading ? null : _register,
                        child: _isLoading ? const CircularProgressIndicator(color: Colors.white) : const Text('Register'),
                      ),
                    ),
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
