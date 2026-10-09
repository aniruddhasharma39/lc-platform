import 'package:flutter/material.dart';
import 'upload_evidence_screen.dart';

class EvidenceChecklistScreen extends StatefulWidget {
  final String token;
  final Map master;

  const EvidenceChecklistScreen({super.key, required this.token, required this.master});

  @override
  State<EvidenceChecklistScreen> createState() => _EvidenceChecklistScreenState();
}

class _EvidenceChecklistScreenState extends State<EvidenceChecklistScreen> {
  late List evidences;

  @override
  void initState() {
    super.initState();
    evidences = widget.master['evidences'] ?? [];
  }

  bool _hasEvidence(String category, [int? childId]) {
    return evidences.any((e) => e['category'] == category && e['childDeviceId'] == childId);
  }

  void _onUploadSuccess(Map newEvidence) {
    setState(() {
      evidences.add(newEvidence);
    });
  }

  @override
  Widget build(BuildContext context) {
    bool hasMaster = _hasEvidence('MASTER');
    bool hasPower = _hasEvidence('POWER_SOURCE');
    List childDevices = widget.master['childDevices'] ?? [];

    return Scaffold(
      appBar: AppBar(title: const Text('Evidence Checklist')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: Text('Upload all required photos for this Master Unit.', style: TextStyle(color: Colors.grey)),
          ),
          
          _buildChecklistItem(
            title: 'Master Unit (ESP)',
            description: 'Photo showing the ESP installation',
            isDone: hasMaster,
            onUpload: () => _navigateToUpload('MASTER', 'Master ESP'),
          ),
          
          _buildChecklistItem(
            title: '${widget.master['powerSource'] == 'SOLAR' ? 'Solar Panel' : 'Direct Power'} Source',
            description: 'Photo verifying the power installation',
            isDone: hasPower,
            onUpload: () => _navigateToUpload('POWER_SOURCE', 'Power Source'),
          ),

          ...childDevices.map((dev) {
            bool hasDev = _hasEvidence(dev['type'], dev['id']);
            return _buildChecklistItem(
              title: 'Slave ${dev['type']}',
              description: dev['type'] == 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor',
              isDone: hasDev,
              onUpload: () => _navigateToUpload(dev['type'], 'Slave ${dev['type']}', dev['id']),
            );
          }),
        ],
      ),
    );
  }

  Widget _buildChecklistItem({required String title, required String description, required bool isDone, required VoidCallback onUpload}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: isDone ? const BorderSide(color: Colors.green, width: 2) : BorderSide.none,
      ),
      color: isDone ? Colors.green.shade50 : null,
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Icon(isDone ? Icons.check_circle : Icons.camera_alt, color: isDone ? Colors.green : Colors.blue, size: 32),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text(description),
        trailing: isDone 
          ? const Chip(label: Text('Verified', style: TextStyle(color: Colors.white, fontSize: 12)), backgroundColor: Colors.green)
          : ElevatedButton(
              onPressed: onUpload,
              style: ElevatedButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
              child: const Text('Upload'),
            ),
      ),
    );
  }

  void _navigateToUpload(String category, String name, [int? childId]) async {
    final result = await Navigator.push(context, MaterialPageRoute(
      builder: (_) => UploadEvidenceScreen(
        token: widget.token,
        masterId: widget.master['id'],
        childDeviceId: childId,
        category: category,
        targetName: name,
      )
    ));
    if (result != null && result is Map) {
      _onUploadSuccess(result);
    }
  }
}
