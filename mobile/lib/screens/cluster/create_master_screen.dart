import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class CreateMasterScreen extends StatefulWidget {
  final String token;
  final Map gate;

  const CreateMasterScreen({super.key, required this.token, required this.gate});

  @override
  State<CreateMasterScreen> createState() => _CreateMasterScreenState();
}

class _CreateMasterScreenState extends State<CreateMasterScreen> {
  final _seqCtrl = TextEditingController(text: '1');
  String _powerSource = 'SOLAR';
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _fetchSequence();
  }

  Future<void> _fetchSequence() async {
    try {
      final res = await http.get(
        Uri.parse('https://lc-platform.onrender.com/api/v1/lcgate/${widget.gate['id']}/next-master-sequence'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data['nextSequence'] != null) {
          setState(() => _seqCtrl.text = data['nextSequence'].toString().padLeft(2, '0'));
        }
      }
    } catch (e) {
      debugPrint('Error fetching master sequence: $e');
    }
  }

  Future<void> _submit() async {
    if (_seqCtrl.text.isEmpty) return;
    setState(() => _isLoading = true);

    try {
      final res = await http.post(
        Uri.parse('https://lc-platform.onrender.com/api/v1/lcgate/${widget.gate['id']}/masters'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode({
          'masterSequence': int.tryParse(_seqCtrl.text) ?? 1,
          'powerSource': _powerSource,
        }),
      );

      if (res.statusCode == 201) {
        Navigator.pop(context, true);
      } else {
        throw Exception(json.decode(res.body)['error'] ?? 'Failed to create');
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
    } finally {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Master Unit'), elevation: 0),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter, end: Alignment.bottomCenter,
            colors: [Theme.of(context).primaryColor.withOpacity(0.1), Colors.white],
          ),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Card(
            elevation: 4,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Master Configuration', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _seqCtrl,
                    readOnly: true,
                    decoration: InputDecoration(
                      labelText: 'Master Sequence (2 Digits) *',
                      prefixText: '${widget.gate['lcNumber']}-',
                      prefixStyle: const TextStyle(fontWeight: FontWeight.bold, color: Colors.indigo),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                      prefixIcon: const Icon(Icons.confirmation_number),
                    ),
                  ),
                  const SizedBox(height: 24),
                  const Text('Power Source', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: _powerSource,
                    decoration: InputDecoration(
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                      prefixIcon: const Icon(Icons.power),
                    ),
                    items: const [
                      DropdownMenuItem(value: 'SOLAR', child: Text('☀️ Solar Power')),
                      DropdownMenuItem(value: 'DIRECT', child: Text('🔌 Direct Current Supply')),
                    ],
                    onChanged: (val) {
                      if (val != null) setState(() => _powerSource = val);
                    },
                  ),
                  const SizedBox(height: 32),
                  ElevatedButton(
                    onPressed: _isLoading ? null : _submit,
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    child: _isLoading 
                      ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)) 
                      : const Text('Create Master Unit', style: TextStyle(fontSize: 16)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
