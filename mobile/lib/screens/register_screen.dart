import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../main.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  Map<String, dynamic>? _form;
  List<dynamic> _fields = [];
  bool _allowRoles = false;
  List<dynamic> _roles = [];
  
  final Map<String, dynamic> _formData = {};
  final Map<String, String> _errors = {};
  
  int? _requestedRoleId;
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  
  bool _isLoading = false;
  String _error = '';
  bool _success = false;

  final ImagePicker _picker = ImagePicker();

  @override
  void initState() {
    super.initState();
    _fetchForm();
  }

  Future<void> _fetchForm() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/auth/registration-form'));
      final data = json.decode(res.body);
      
      setState(() {
        if (data['form'] != null) {
          _form = data['form'];
          try {
            final parsed = json.decode(_form!['schema']);
            if (parsed is List) {
              _fields = parsed;
              _allowRoles = true;
            } else {
              _fields = parsed['fields'] ?? [];
              _allowRoles = parsed['allowRoles'] ?? true;
            }
          } catch (_) {}
        }
        if (data['roles'] != null) {
          _roles = data['roles'];
        }
      });
    } catch (e) {
      print(e);
    }
  }

  String? _validateField(Map<String, dynamic> field, dynamic val) {
    if (field['required'] == true && (val == null || val.toString().isEmpty || (val is List && val.isEmpty))) {
      return 'This field is required';
    }
    if (val == null || val.toString().isEmpty) return null;
    
    if (field['validation'] != null) {
      final v = field['validation'];
      final strVal = val.toString();
      if (v['minLength'] != null && strVal.length < v['minLength']) return v['customError'] ?? 'Minimum length is ${v['minLength']}';
      if (v['maxLength'] != null && strVal.length > v['maxLength']) return v['customError'] ?? 'Maximum length is ${v['maxLength']}';
      if (v['pattern'] != null && v['pattern'].toString().isNotEmpty) {
        if (!RegExp(v['pattern']).hasMatch(strVal)) return v['customError'] ?? 'Invalid format';
      }
    } else {
      if (field['type'] == 'email' && !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(val.toString())) return 'Invalid email format';
      if (field['type'] == 'phone' && !RegExp(r'^\d{10}$').hasMatch(val.toString())) return 'Phone number must be 10 digits';
    }
    return null;
  }

  bool _validateAllFields(List<dynamic> fieldsList) {
    bool hasErrors = false;
    for (var f in fieldsList) {
      if (f['type'] == 'section') {
        if (f['children'] != null) {
          if (!_validateAllFields(f['children'])) hasErrors = true;
        }
        continue;
      }
      final err = _validateField(f, _formData[f['name']]);
      if (err != null) {
        _errors[f['name']] = err;
        hasErrors = true;
      } else {
        _errors.remove(f['name']);
      }
    }
    return !hasErrors;
  }

  Future<void> _register() async {
    if (_passwordCtrl.text != _confirmPasswordCtrl.text) {
      setState(() => _error = 'Passwords do not match');
      return;
    }
    
    if (_form == null) {
      setState(() => _error = 'No active registration form.');
      return;
    }

    setState(() => _error = '');
    
    bool isValid = _validateAllFields(_fields);
    if (_allowRoles && _requestedRoleId == null) {
      isValid = false;
      setState(() => _error = 'Please select a requested role.');
    }
    
    if (!isValid) {
      setState(() {}); // Trigger rebuild to show errors
      return;
    }
    
    setState(() => _isLoading = true);
    
    try {
      bool hasFiles = _formData.values.any((v) => v is XFile);
      
      final dataToStore = Map<String, dynamic>.from(_formData);
      dataToStore.removeWhere((key, value) => value is XFile); // Handled separately
      
      dataToStore['password'] = _passwordCtrl.text;

      final url = Uri.parse('$baseUrl/auth/register');
      
      http.Response res;
      
      if (hasFiles) {
        var request = http.MultipartRequest('POST', url);
        request.fields['data'] = json.encode(dataToStore);
        if (_requestedRoleId != null) request.fields['roleId'] = _requestedRoleId.toString();
        request.fields['formId'] = _form!['id'].toString();
        
        for (var entry in _formData.entries) {
          if (entry.value is XFile) {
            final file = entry.value as XFile;
            final bytes = await file.readAsBytes();
            request.files.add(http.MultipartFile.fromBytes(
              entry.key, 
              bytes,
              filename: file.name
            ));
          }
        }
        
        var streamedRes = await request.send();
        res = await http.Response.fromStream(streamedRes);
      } else {
        final body = json.encode({
          'data': dataToStore,
          'roleId': _requestedRoleId,
          'formId': _form!['id']
        });
        
        res = await http.post(
          url,
          headers: {'Content-Type': 'application/json'},
          body: body
        );
      }
      
      final data = json.decode(res.body);
      if (res.statusCode == 201) {
        setState(() => _success = true);
      } else {
        setState(() => _error = data['error'] ?? 'Registration failed');
      }
    } catch (e) {
      setState(() => _error = 'Network error: $e');
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Widget _renderField(Map<String, dynamic> f) {
    if (f['type'] == 'section') {
      return Container(
        margin: const EdgeInsets.only(bottom: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(f['label'] ?? '', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.primary)),
            if (f['helperText'] != null && f['helperText'].toString().isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 4, bottom: 8), child: Text(f['helperText'], style: const TextStyle(color: Colors.grey, fontSize: 12))),
            const Divider(),
            const SizedBox(height: 12),
            if (f['children'] != null)
              ...((f['children'] as List).map((child) => _renderField(child as Map<String, dynamic>)))
          ],
        )
      );
    }

    final err = _errors[f['name']];
    final labelText = '${f['label']} ${f['required'] == true ? '*' : ''}';

    Widget fieldWidget = const SizedBox();

    if (f['type'] == 'dropdown') {
      final options = (f['options'] as List?)?.map((o) => o as Map<String, dynamic>).toList() ?? [];
      fieldWidget = DropdownButtonFormField<String>(
        decoration: InputDecoration(
          labelText: labelText,
          errorText: err,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        ),
        value: _formData[f['name']],
        items: options.map((o) => DropdownMenuItem(value: o['value'].toString(), child: Text(o['label'].toString()))).toList(),
        onChanged: (val) {
          if (val != null) setState(() { _formData[f['name']] = val; _errors.remove(f['name']); });
        },
      );
    } 
    else if (f['type'] == 'radio') {
      final options = (f['options'] as List?)?.map((o) => o as Map<String, dynamic>).toList() ?? [];
      fieldWidget = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(labelText, style: const TextStyle(fontWeight: FontWeight.bold)),
          if (err != null) Text(err, style: const TextStyle(color: Colors.red, fontSize: 12)),
          Wrap(
            children: options.map((o) => Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Radio<String>(
                  value: o['value'].toString(),
                  groupValue: _formData[f['name']],
                  onChanged: (val) {
                    setState(() { _formData[f['name']] = val; _errors.remove(f['name']); });
                  }
                ),
                Text(o['label'].toString())
              ],
            )).toList(),
          )
        ],
      );
    }
    else if (f['type'] == 'checkbox') {
      final options = (f['options'] as List?)?.map((o) => o as Map<String, dynamic>).toList() ?? [];
      final List<String> currentSelections = List<String>.from(_formData[f['name']] ?? []);
      
      fieldWidget = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(labelText, style: const TextStyle(fontWeight: FontWeight.bold)),
          if (err != null) Text(err, style: const TextStyle(color: Colors.red, fontSize: 12)),
          Column(
            children: options.map((o) => CheckboxListTile(
              title: Text(o['label'].toString()),
              value: currentSelections.contains(o['value'].toString()),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              dense: true,
              onChanged: (bool? checked) {
                setState(() {
                  if (checked == true) {
                    currentSelections.add(o['value'].toString());
                  } else {
                    currentSelections.remove(o['value'].toString());
                  }
                  _formData[f['name']] = currentSelections;
                  _errors.remove(f['name']);
                });
              }
            )).toList(),
          )
        ],
      );
    }
    else if (f['type'] == 'image') {
      final XFile? file = _formData[f['name']];
      fieldWidget = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(labelText, style: const TextStyle(fontWeight: FontWeight.bold)),
          if (err != null) Text(err, style: const TextStyle(color: Colors.red, fontSize: 12)),
          const SizedBox(height: 8),
          Row(
            children: [
              ElevatedButton.icon(
                onPressed: () async {
                  final source = f['imageSettings']?['source'] == 'camera' ? ImageSource.camera : ImageSource.gallery;
                  final picked = await _picker.pickImage(source: source);
                  if (picked != null) {
                    setState(() { _formData[f['name']] = picked; _errors.remove(f['name']); });
                  }
                },
                icon: const Icon(Icons.upload),
                label: const Text('Select Image')
              ),
              const SizedBox(width: 16),
              if (file != null) Expanded(child: Text(file.name, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.primary)))
            ],
          )
        ],
      );
    }
    else {
      // Text inputs (text, email, password, etc)
      int maxLines = f['type'] == 'textarea' ? 3 : 1;
      fieldWidget = TextFormField(
        initialValue: _formData[f['name']],
        decoration: InputDecoration(
          labelText: labelText,
          hintText: f['placeholder'],
          errorText: err,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        ),
        keyboardType: f['type'] == 'number' ? TextInputType.number : (f['type'] == 'email' ? TextInputType.emailAddress : (f['type'] == 'phone' ? TextInputType.phone : TextInputType.text)),
        obscureText: f['type'] == 'password',
        maxLength: f['type'] == 'phone' ? 10 : null,
        inputFormatters: f['type'] == 'phone' ? [FilteringTextInputFormatter.digitsOnly] : null,
        maxLines: f['type'] == 'password' ? 1 : maxLines,
        onChanged: (val) {
          _formData[f['name']] = val;
          if (_errors.containsKey(f['name'])) setState(() => _errors.remove(f['name']));
        },
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          fieldWidget,
          if (f['helperText'] != null && f['helperText'].toString().isNotEmpty && f['type'] != 'radio' && f['type'] != 'checkbox' && f['type'] != 'image')
             Padding(padding: const EdgeInsets.only(top: 4, left: 4), child: Text(f['helperText'], style: const TextStyle(color: Colors.grey, fontSize: 12))),
        ],
      )
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_success) {
      return Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.check_circle, color: AppColors.success, size: 64),
                const SizedBox(height: 16),
                const Text('Registration Successful!', style: TextStyle(color: AppColors.success, fontSize: 24, fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                const Text('Your request has been submitted and is pending administrator approval.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    minimumSize: const Size(double.infinity, 50)
                  ),
                  child: const Text('Return to Login'),
                )
              ],
            ),
          )
        )
      );
    }

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: Text(_form != null ? _form!['name'] : 'Register'), backgroundColor: AppColors.surface, elevation: 0),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 500),
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 10, offset: Offset(0, 4))]
            ),
            child: _form == null ? const Center(child: Text('Loading form...', style: TextStyle(color: Colors.grey))) : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.all(12),
                    margin: const EdgeInsets.only(bottom: 16),
                    decoration: BoxDecoration(color: Colors.red.withOpacity(0.1), border: Border.all(color: AppColors.danger), borderRadius: BorderRadius.circular(8)),
                    child: Text(_error, style: const TextStyle(color: AppColors.danger)),
                  ),

                ..._fields.map((f) => _renderField(f as Map<String, dynamic>)),

                if (_allowRoles) ...[
                  const Divider(height: 32),
                  DropdownButtonFormField<int>(
                    value: _requestedRoleId,
                    decoration: InputDecoration(
                      labelText: 'Request Role *',
                      helperText: 'This will require admin approval',
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    items: _roles.map((e) => DropdownMenuItem<int>(value: e['id'], child: Text(e['name']))).toList(),
                    onChanged: (v) => setState(() { _requestedRoleId = v; _error = ''; }),
                  ),
                  const SizedBox(height: 16),
                ],
                
                const Divider(height: 32),
                
                TextField(
                  controller: _passwordCtrl,
                  decoration: InputDecoration(
                    labelText: 'Password *',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                  obscureText: true,
                ),
                const SizedBox(height: 16),
                
                TextField(
                  controller: _confirmPasswordCtrl,
                  decoration: InputDecoration(
                    labelText: 'Confirm Password *',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                  obscureText: true,
                ),
                const SizedBox(height: 24),
                
                ElevatedButton(
                  onPressed: _isLoading ? null : _register,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))
                  ),
                  child: _isLoading 
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Text('Submit Registration', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
                
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Already have an account? Login', style: TextStyle(color: AppColors.secondary)),
                )
              ],
            )
          )
        )
      )
    );
  }
}
