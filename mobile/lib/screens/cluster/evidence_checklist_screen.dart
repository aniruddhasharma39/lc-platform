import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'upload_evidence_screen.dart';
import '../../config.dart';
import '../../utils/app_feedback.dart';

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

  Future<void> _fetchEvidences({bool isManual = false}) async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/lcgate'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 200) {
        final List data = json.decode(res.body);
        for (final g in data) {
          final masters = g['masters'] as List? ?? [];
          for (final m in masters) {
            if (m['id'] == widget.master['id']) {
              if (mounted) {
                setState(() => evidences = m['evidences'] ?? []);
                if (isManual) {
                  AppFeedback.showSuccess(context, 'Evidence checklist synchronized.');
                }
              }
              return;
            }
          }
        }
      }
    } catch (e) {
      if (mounted && isManual) {
        AppFeedback.showError(context, 'Unable to refresh checklist: $e');
      }
    }
  }

  bool _hasEvidence(String category, [int? childId]) {
    return evidences.any((e) => e['category'] == category && e['childDeviceId'] == childId);
  }

  Map? _findEvidence(String category, [int? childId]) {
    for (final e in evidences) {
      if (e['category'] == category && e['childDeviceId'] == childId) return e;
    }
    return null;
  }

  String _fullImageUrl(String url) {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    final base = baseUrl; // https://<host>/api/v1
    final host = base.endsWith('/api/v1')
        ? base.substring(0, base.length - '/api/v1'.length)
        : base;
    return '$host$url';
  }

  void _onUploadSuccess(Map newEvidence) {
    setState(() {
      // Replace the existing evidence for the same slot (re-upload), or add it.
      final index = evidences.indexWhere((e) =>
          e['category'] == newEvidence['category'] &&
          e['childDeviceId'] == newEvidence['childDeviceId']);
      if (index >= 0) {
        evidences[index] = newEvidence;
      } else {
        evidences.add(newEvidence);
      }
    });
  }

  Future<void> _deleteEvidence(Map evidence, String itemTitle) async {
    bool confirm = await showDialog(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text('Delete Photo for "$itemTitle"?'),
        content: const Text('Are you sure you want to delete this uploaded photo? This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogCtx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(dialogCtx, true),
            child: const Text('Delete', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    ) ?? false;

    if (!confirm) return;
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/evidence/${evidence['id']}'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode == 204 || res.statusCode == 200) {
        setState(() {
          evidences.removeWhere((e) => e['id'] == evidence['id']);
        });
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            'Photo for "$itemTitle" deleted successfully.',
          );
        }
      } else {
        String msg = res.body;
        if (res.statusCode == 404 || msg.contains('Cannot DELETE')) {
          msg = 'Server route not found (404). The backend on Render does not have the DELETE endpoint deployed yet.';
        }
        if (mounted) {
          AppFeedback.showError(context, msg);
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error deleting photo: $e');
      }
    }
  }

  void _viewPhoto(Map evidence) {
    final url = _fullImageUrl(evidence['imageUrl'] ?? '');
    if (url.isEmpty) return;
    showDialog(
      context: context,
      builder: (context) => Dialog(
        backgroundColor: Colors.black,
        child: Stack(
          children: [
            InteractiveViewer(
              minScale: 0.5,
              maxScale: 4,
              child: Center(
                child: Image.network(url, fit: BoxFit.contain),
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white, size: 28),
                onPressed: () => Navigator.pop(context),
              ),
            ),
          ],
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
    if (!mounted) return;
    if (result != null && result is Map) {
      _onUploadSuccess(result);
      AppFeedback.showSuccess(context, 'Checklist updated: photo recorded for "$name".');
    }
  }

  @override
  Widget build(BuildContext context) {
    bool hasMaster = _hasEvidence('MASTER');
    bool hasSim = _hasEvidence('SIM_CARD');
    bool hasPower = _hasEvidence('POWER_SOURCE');
    List childDevices = widget.master['childDevices'] ?? [];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Evidence Checklist'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh Checklist',
            onPressed: () => _fetchEvidences(isManual: true),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _fetchEvidences(isManual: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
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
              evidence: _findEvidence('MASTER'),
              onUpload: () => _navigateToUpload('MASTER', 'Master ESP'),
            ),

            _buildChecklistItem(
              title: 'SIM Card Photo',
              description: 'Photo showing the installed SIM card & ICCID number',
              isDone: hasSim,
              evidence: _findEvidence('SIM_CARD'),
              onUpload: () => _navigateToUpload('SIM_CARD', 'SIM Card'),
            ),
            
            _buildChecklistItem(
              title: '${widget.master['powerSource'] == 'SOLAR' ? 'Solar Panel' : 'Direct Power'} Source',
              description: 'Photo verifying the power installation',
              isDone: hasPower,
              evidence: _findEvidence('POWER_SOURCE'),
              onUpload: () => _navigateToUpload('POWER_SOURCE', 'Power Source'),
            ),

            ...childDevices.map((dev) {
              bool hasDev = _hasEvidence(dev['type'], dev['id']);
              return _buildChecklistItem(
                title: 'Slave ${dev['type']}',
                description: dev['type'] == 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor',
                isDone: hasDev,
                evidence: _findEvidence(dev['type'], dev['id']),
                onUpload: () => _navigateToUpload(dev['type'], 'Slave ${dev['type']}', dev['id']),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _buildChecklistItem({
    required String title,
    required String description,
    required bool isDone,
    required Map? evidence,
    required VoidCallback onUpload,
  }) {
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
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.visibility_outlined, color: Color(0xFF0B3C7A)),
                  tooltip: 'View Photo',
                  onPressed: () => _viewPhoto(evidence!),
                ),
                IconButton(
                  icon: const Icon(Icons.refresh, color: Color(0xFF0E9AA7)),
                  tooltip: 'Re-upload',
                  onPressed: onUpload,
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline, color: Colors.red),
                  tooltip: 'Delete Photo',
                  onPressed: () => _deleteEvidence(evidence!, title),
                ),
              ],
            )
          : ElevatedButton(
              onPressed: onUpload,
              style: ElevatedButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
              child: const Text('Upload'),
            ),
      ),
    );
  }
}