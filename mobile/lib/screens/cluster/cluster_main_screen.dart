import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'create_gate_screen.dart';
import 'gate_detail_screen.dart';

class ClusterMainScreen extends StatefulWidget {
  final String token;
  const ClusterMainScreen({super.key, required this.token});

  @override
  State<ClusterMainScreen> createState() => _ClusterMainScreenState();
}

class _ClusterMainScreenState extends State<ClusterMainScreen> {
  List<dynamic> _gates = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _fetchGates();
  }

  Future<void> _fetchGates() async {
    setState(() => _isLoading = true);
    try {
      final res = await http.get(
        Uri.parse('http://localhost:5001/api/v1/lcgate'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        setState(() {
          _gates = json.decode(res.body);
        });
      }
    } catch (e) {
      print('Error fetching gates: $e');
    } finally {
      setState(() => _isLoading = false);
    }
  }
  Future<void> _deleteGate(Map gate) async {
    final ctrl = TextEditingController();
    bool confirm = await showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Are you absolutely sure?', style: TextStyle(color: Colors.red)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('This action cannot be undone. It will permanently delete this LC Gate and all associated Master units, Slave devices, and photographic evidence.'),
            const SizedBox(height: 16),
            Text('Please type "${gate['name'] ?? gate['lcNumber']}" to confirm:'),
            const SizedBox(height: 8),
            TextField(
              controller: ctrl,
              decoration: const InputDecoration(border: OutlineInputBorder()),
            )
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              if (ctrl.text == (gate['name'] ?? gate['lcNumber'])) {
                Navigator.pop(context, true);
              } else {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Name does not match')));
              }
            }, 
            child: const Text('Delete this gate', style: TextStyle(color: Colors.white))
          ),
        ],
      )
    ) ?? false;

    if (!confirm) return;

    setState(() => _isLoading = true);
    try {
      final res = await http.delete(
        Uri.parse('http://localhost:5001/api/v1/lcgate/${gate['id']}'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 204) {
        _fetchGates();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to delete')));
        setState(() => _isLoading = false);
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('LC Gates & Clusters', style: TextStyle(fontWeight: FontWeight.bold)),
        elevation: 0,
        backgroundColor: Colors.transparent,
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('Create Gate'),
        onPressed: () async {
          final result = await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => CreateGateScreen(token: widget.token),
            ),
          );
          if (result == true) _fetchGates();
        },
      ),
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter, end: Alignment.bottomCenter,
            colors: [Theme.of(context).primaryColor.withOpacity(0.05), Colors.white],
          ),
        ),
        child: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _gates.isEmpty
              ? const Center(child: Text('No LC Gates found. Create one!', style: TextStyle(color: Colors.grey, fontSize: 16)))
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _gates.length,
                  itemBuilder: (context, index) {
                    final gate = _gates[index];
                    final masters = gate['masters'] as List? ?? [];
                    final deviceCount = masters.fold<int>(0, (sum, m) => sum + ((m['childDevices'] as List?)?.length ?? 0));
                    
                    return Card(
                      elevation: 4,
                      margin: const EdgeInsets.only(bottom: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(16),
                        onTap: () async {
                          final result = await Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (_) => GateDetailScreen(token: widget.token, gate: gate),
                            ),
                          );
                          if (result == true) _fetchGates();
                        },
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(gate['locationName'] ?? 'Unknown', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                                        if (gate['name'] != null && gate['name'].isNotEmpty)
                                          Text(gate['name'], style: const TextStyle(color: Colors.grey, fontSize: 14)),
                                      ],
                                    ),
                                  ),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Container(
                                        decoration: BoxDecoration(
                                          color: Colors.red.withOpacity(0.1),
                                          shape: BoxShape.circle,
                                        ),
                                        child: IconButton(
                                          padding: EdgeInsets.zero,
                                          constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
                                          icon: const Icon(Icons.delete_outline, color: Colors.red, size: 22),
                                          onPressed: () => _deleteGate(gate),
                                        ),
                                      ),
                                      const SizedBox(height: 8),
                                      Chip(
                                        label: Text('LC # ${gate['lcNumber']}', style: const TextStyle(color: Colors.indigo, fontWeight: FontWeight.bold)),
                                        backgroundColor: Colors.indigo.withOpacity(0.1),
                                        side: BorderSide.none,
                                      )
                                    ],
                                  )
                                ],
                              ),
                              const SizedBox(height: 16),
                              const Divider(height: 1),
                              const SizedBox(height: 12),
                              Row(
                                children: [
                                  _buildStat(masters.length.toString(), 'MASTERS'),
                                  const SizedBox(width: 32),
                                  _buildStat(deviceCount.toString(), 'DEVICES'),
                                ],
                              )
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
      ),
    );
  }

  Widget _buildStat(String value, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.indigo)),
        Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey, letterSpacing: 1.2)),
      ],
    );
  }
}
