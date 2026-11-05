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
    _fetchEvidences();
  }

  Future<void> _fetchEvidences({bool isManual = false}) async {
    try {
      // 1. Direct fetch from dedicated evidence endpoint with cache-busting
      final directRes = await http.get(
        Uri.parse('$baseUrl/evidence/master/${widget.master['id']}?_t=${DateTime.now().millisecondsSinceEpoch}'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      );
      if (directRes.statusCode == 200) {
        final List data = json.decode(directRes.body);
        if (mounted) {
          setState(() => evidences = data);
          if (isManual) {
            AppFeedback.showSuccess(context, 'Evidence checklist synchronized.');
          }
        }
        return;
      }

      // 2. Fallback to /lcgate/:id
      final gateId = widget.master['gateId'];
      if (gateId != null) {
        final res = await http.get(
          Uri.parse('$baseUrl/lcgate/$gateId?_t=${DateTime.now().millisecondsSinceEpoch}'),
          headers: {
            'Authorization': 'Bearer ${widget.token}',
            'Cache-Control': 'no-cache',
          },
        );
        if (res.statusCode == 200) {
          final data = json.decode(res.body);
          final gateData = data is Map ? (data['cluster'] ?? data['gate'] ?? data) : null;
          final masters = (gateData?['masters'] as List?) ?? [];
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
    return evidences.any((e) {
      if (e is! Map) return false;
      if (childId != null) {
        return e['childDeviceId']?.toString() == childId.toString();
      }
      return e['category'] == category && e['childDeviceId'] == null;
    });
  }

  Map? _findEvidence(String category, [int? childId]) {
    for (final e in evidences) {
      if (e is! Map) continue;
      if (childId != null) {
        if (e['childDeviceId']?.toString() == childId.toString()) return e;
      } else {
        if (e['category'] == category && e['childDeviceId'] == null) return e;
      }
    }
    return null;
  }

  String _fullImageUrl(String url) {
    if (url.isEmpty) return '';
    String resolved = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      final base = baseUrl; // https://<host>/api/v1
      final host = base.endsWith('/api/v1')
          ? base.substring(0, base.length - '/api/v1'.length)
          : base;
      resolved = '$host$url';
    }
    final separator = resolved.contains('?') ? '&' : '?';
    return '$resolved${separator}_t=${DateTime.now().millisecondsSinceEpoch}';
  }

  void _onUploadSuccess(Map newEvidence) {
    setState(() {
      final newChildId = newEvidence['childDeviceId']?.toString();
      final newCat = newEvidence['category']?.toString();
      final index = evidences.indexWhere((e) {
        if (e is! Map) return false;
        if (newChildId != null) {
          return e['childDeviceId']?.toString() == newChildId;
        }
        return e['category'] == newCat && e['childDeviceId'] == null;
      });
      if (index >= 0) {
        evidences[index] = newEvidence;
      } else {
        evidences.add(newEvidence);
      }
    });
    _fetchEvidences(isManual: false);
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
      final evId = evidence['id'];
      http.Response res = await http.delete(
        Uri.parse('$baseUrl/evidence/$evId'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (res.statusCode != 204 && res.statusCode != 200) {
        // Fallback for proxies
        res = await http.post(
          Uri.parse('$baseUrl/evidence/$evId/delete'),
          headers: {'Authorization': 'Bearer ${widget.token}'},
        );
      }
      if (res.statusCode == 204 || res.statusCode == 200) {
        setState(() {
          evidences.removeWhere((e) => e is Map && e['id']?.toString() == evId?.toString());
        });
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            'Photo for "$itemTitle" deleted successfully.',
          );
        }
        _fetchEvidences(isManual: false);
      } else {
        String msg = res.body;
        if (mounted) {
          AppFeedback.showError(context, 'Failed to delete photo: $msg');
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
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Upload Evidence', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            Text(widget.master['serialNumber'] ?? '', style: const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
          ],
        ),
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
      bottomNavigationBar: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 8, offset: const Offset(0, -2)),
          ],
        ),
        child: SafeArea(
          child: ElevatedButton.icon(
            icon: const Icon(Icons.arrow_back, color: Colors.white, size: 20),
            label: const Text(
              'Done • Return to Gate Details',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Colors.white),
            ),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF0B3C7A),
              minimumSize: const Size.fromHeight(48),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            onPressed: () => Navigator.pop(context, true),
          ),
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
        onTap: isDone ? () => _viewPhoto(evidence!) : onUpload,
        leading: Icon(isDone ? Icons.check_circle : Icons.camera_alt, color: isDone ? Colors.green : Colors.blue, size: 32),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(description),
            const SizedBox(height: 2),
            Text(
              isDone ? 'Tap to view full photo' : 'Tap anywhere to upload photo',
              style: TextStyle(fontSize: 11, color: isDone ? Colors.green.shade700 : Colors.blue.shade700, fontWeight: FontWeight.w500),
            ),
          ],
        ),
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