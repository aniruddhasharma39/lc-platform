import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../../config.dart';

class SupervisorAttendanceScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final String token;

  const SupervisorAttendanceScreen({
    super.key,
    required this.user,
    required this.token,
  });

  @override
  State<SupervisorAttendanceScreen> createState() => _SupervisorAttendanceScreenState();
}

class _SupervisorAttendanceScreenState extends State<SupervisorAttendanceScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  bool _isLoading = true;

  // Station Matrix Data
  List<dynamic> _gateMatrix = [];
  String _todayDate = '';
  int _gateCount = 0;

  // Pending Manual Fallback Requests
  List<dynamic> _pendingRequests = [];
  bool _isProcessingAction = false;

  // PWI/CPWI Authority Check for Face Re-Enrollment Approvals
  bool get _canApproveReenrollment {
    final role = (widget.user['role'] ?? '').toString().toLowerCase();
    final desig = (widget.user['designation'] ?? '').toString().toLowerCase();
    return role == 'pwi' ||
        role == 'cpwi' ||
        role == 'developer' ||
        role == 'admin' ||
        desig.contains('pwi') ||
        desig.contains('sse/p.way') ||
        desig.contains('je/p.way');
  }

  // Pending Face Re-Enrollment Requests
  List<dynamic> _pendingReenrollments = [];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _canApproveReenrollment ? 3 : 2, vsync: this);
    _fetchAllData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _fetchAllData() async {
    setState(() => _isLoading = true);
    final futures = <Future>[
      _fetchStationMatrix(),
      _fetchPendingManualRequests(),
    ];
    if (_canApproveReenrollment) {
      futures.add(_fetchPendingReenrollments());
    }
    await Future.wait(futures);
    if (mounted) setState(() => _isLoading = false);
  }

  Future<void> _fetchStationMatrix() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/attendance/station-matrix'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _gateMatrix = List.from(data['matrix'] ?? []);
            _todayDate = data['today'] ?? '';
            _gateCount = data['gateCount'] ?? _gateMatrix.length;
          });
        }
      }
    } catch (e) {
      debugPrint('Error fetching station attendance matrix: $e');
    }
  }

  Future<void> _fetchPendingManualRequests() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/attendance/pending-manual'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _pendingRequests = List.from(data['requests'] ?? []);
          });
        }
      }
    } catch (e) {
      debugPrint('Error fetching pending manual requests: $e');
    }
  }

  Future<void> _handleReviewRequest(int requestId, String action) async {
    setState(() => _isProcessingAction = true);
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/attendance/approve-manual/$requestId'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Content-Type': 'application/json',
        },
        body: json.encode({'action': action}),
      );

      if (!mounted) return;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Attendance request ${action == 'APPROVE' ? 'approved' : 'rejected'} successfully'),
            backgroundColor: action == 'APPROVE' ? const Color(0xFF16A34A) : Colors.red,
          ),
        );
        await _fetchAllData();
      } else {
        final data = json.decode(res.body);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(data['error'] ?? 'Review action failed'), backgroundColor: Colors.red),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isProcessingAction = false);
    }
  }

  Future<void> _fetchPendingReenrollments() async {
    try {
      final res = await http.get(
        Uri.parse('$baseUrl/attendance/pending-reenrollments'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _pendingReenrollments = List.from(data['requests'] ?? []);
          });
        }
      }
    } catch (e) {
      debugPrint('Error fetching pending re-enrollments: $e');
    }
  }

  Future<void> _handleReviewReenrollment(int reqId, String action, {String? notes}) async {
    setState(() => _isProcessingAction = true);
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/attendance/approve-reenrollment/$reqId'),
        headers: {
          'Authorization': 'Bearer ${widget.token}',
          'Content-Type': 'application/json',
        },
        body: json.encode({'action': action, 'notes': notes}),
      );

      if (!mounted) return;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Re-enrollment ${action == "APPROVE" ? "approved (Face profile unlocked)" : "rejected"} successfully'),
            backgroundColor: action == 'APPROVE' ? const Color(0xFF16A34A) : Colors.red,
          ),
        );
        await _fetchAllData();
      } else {
        final data = json.decode(res.body);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(data['error'] ?? 'Action failed'), backgroundColor: Colors.red),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isProcessingAction = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      appBar: AppBar(
        title: const Text('Gate Staffing & Attendance', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh Matrix',
            onPressed: _fetchAllData,
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: const Color(0xFF00E5FF),
          indicatorWeight: 3,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          labelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
          tabs: [
            Tab(
              icon: const Icon(Icons.grid_view_rounded, size: 20),
              text: 'Gate Matrix ($_gateCount)',
            ),
            Tab(
              icon: Badge(
                isLabelVisible: _pendingRequests.isNotEmpty,
                label: Text('${_pendingRequests.length}'),
                child: const Icon(Icons.pending_actions_rounded, size: 20),
              ),
              text: 'Pending (${_pendingRequests.length})',
            ),
            if (_canApproveReenrollment)
              Tab(
                icon: Badge(
                  isLabelVisible: _pendingReenrollments.isNotEmpty,
                  label: Text('${_pendingReenrollments.length}'),
                  child: const Icon(Icons.face_retouching_natural, size: 20),
                ),
                text: 'Face Re-Enroll (${_pendingReenrollments.length})',
              ),
          ],
        ),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : TabBarView(
              controller: _tabController,
              children: [
                _buildMatrixTab(),
                _buildPendingRequestsTab(),
                if (_canApproveReenrollment) _buildPendingReenrollmentsTab(),
              ],
            ),
    );
  }

  Widget _buildMatrixTab() {
    if (_gateMatrix.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.meeting_room_outlined, size: 54, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            const Text('No LC Gates configured under this station', style: TextStyle(color: Colors.black54, fontSize: 14)),
          ],
        ),
      );
    }

    // Metric Summary Counters
    int presentCount = 0;
    int lateCount = 0;
    int unstaffedCount = 0;
    int manualCount = 0;

    for (final g in _gateMatrix) {
      final s = (g['currentStatus'] ?? '').toString();
      if (s == 'PRESENT') {
        presentCount++;
      } else if (s == 'LATE') {
        lateCount++;
      } else if (s == 'UNSTAFFED') {
        unstaffedCount++;
      } else if (s.contains('MANUAL')) {
        manualCount++;
      }
    }

    return RefreshIndicator(
      onRefresh: _fetchStationMatrix,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // KPI Counter Strip
          Row(
            children: [
              _buildMiniMetric('Present', '$presentCount', const Color(0xFF16A34A)),
              const SizedBox(width: 8),
              _buildMiniMetric('Late', '$lateCount', const Color(0xFFD97706)),
              const SizedBox(width: 8),
              _buildMiniMetric('Unstaffed', '$unstaffedCount', const Color(0xFFDC2626)),
              const SizedBox(width: 8),
              _buildMiniMetric('Pending', '$manualCount', const Color(0xFFEA580C)),
            ],
          ),
          const SizedBox(height: 16),

          Text(
            'Station Gate Staffing Status ($_todayDate)',
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF1E293B)),
          ),
          const SizedBox(height: 10),

          ..._gateMatrix.map((gate) => _buildGateMatrixCard(gate)),
        ],
      ),
    );
  }

  Widget _buildMiniMetric(String label, String value, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.3)),
          boxShadow: [
            BoxShadow(color: Colors.black.withValues(alpha: 0.02), blurRadius: 4, offset: const Offset(0, 1)),
          ],
        ),
        child: Column(
          children: [
            Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: color)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B), fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  String _formatLcNumber(dynamic raw) {
    if (raw == null) return 'LC Gate';
    final s = raw.toString().trim();
    if (s.isEmpty) return 'LC Gate';
    final stripped = s.replaceAll(RegExp(r'^(?:LC\s*[-–—:]?\s*)+', caseSensitive: false), '').trim();
    return stripped.isNotEmpty ? 'LC-$stripped' : 'LC Gate';
  }

  Widget _buildGateMatrixCard(dynamic gate) {
    final status = (gate['currentStatus'] ?? 'UNSTAFFED').toString();
    final lcNumber = _formatLcNumber(gate['lcNumber']);
    final locationName = gate['locationName'] ?? '';
    final gateman = gate['assignedGateman'] ?? 'Unassigned';
    final shift = gate['shiftName'] ?? 'No Shift';
    final times = gate['shiftTimes'];
    final score = gate['similarityScore'];

    Color statusColor;
    String statusLabel;
    IconData statusIcon;

    switch (status) {
      case 'PRESENT':
        statusColor = const Color(0xFF16A34A);
        statusLabel = 'Checked In (On Time)';
        statusIcon = Icons.check_circle_rounded;
        break;
      case 'LATE':
        statusColor = const Color(0xFFD97706);
        statusLabel = 'Late Check-In';
        statusIcon = Icons.warning_amber_rounded;
        break;
      case 'MANUAL_PENDING':
        statusColor = const Color(0xFFEA580C);
        statusLabel = 'Manual Approval Pending';
        statusIcon = Icons.hourglass_top_rounded;
        break;
      case 'MANUAL_APPROVED':
        statusColor = const Color(0xFF0284C7);
        statusLabel = 'Approved (Manual)';
        statusIcon = Icons.thumb_up_alt_rounded;
        break;
      case 'COMPLETED':
        statusColor = const Color(0xFF2563EB);
        statusLabel = 'Shift Completed';
        statusIcon = Icons.task_alt_rounded;
        break;
      default:
        statusColor = const Color(0xFFDC2626);
        statusLabel = 'Unstaffed / Missing';
        statusIcon = Icons.error_outline_rounded;
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE2E8F0)),
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.03), blurRadius: 6, offset: const Offset(0, 2)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0D47A1).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      lcNumber,
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0D47A1)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    locationName,
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5, color: Color(0xFF1E293B)),
                  ),
                ],
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Icon(statusIcon, size: 12, color: statusColor),
                    const SizedBox(width: 4),
                    Text(
                      statusLabel,
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: statusColor),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),

          // Rostered Gateman & Shift Times
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  const Icon(Icons.person_rounded, size: 15, color: Color(0xFF64748B)),
                  const SizedBox(width: 5),
                  Text(gateman, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Color(0xFF334155))),
                ],
              ),
              Text(
                times != null ? '$shift ($times)' : shift,
                style: const TextStyle(fontSize: 11.5, color: Color(0xFF64748B)),
              ),
            ],
          ),

          if (score != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const Icon(Icons.verified_user_rounded, size: 14, color: Color(0xFF16A34A)),
                const SizedBox(width: 5),
                Text(
                  'Rekognition Match: $score%',
                  style: const TextStyle(fontSize: 11.5, color: Color(0xFF15803D), fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildPendingRequestsTab() {
    if (_pendingRequests.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.task_alt_rounded, size: 54, color: Colors.green.shade300),
            const SizedBox(height: 12),
            const Text(
              'All Clear! No pending manual attendance requests.',
              style: TextStyle(color: Colors.black54, fontSize: 14, fontWeight: FontWeight.w500),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchPendingManualRequests,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _pendingRequests.length,
        itemBuilder: (ctx, idx) {
          final req = _pendingRequests[idx];
          final reqId = req['id'];
          final user = req['user'] ?? {};
          final gate = req['gate'] ?? {};
          final reason = req['fallbackReason'] ?? 'Low-light or network timeout';
          final type = req['type'] ?? 'CHECK_IN';
          final selfieUrl = req['selfieUrl'];

          return Container(
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: const Color(0xFFFED7AA), width: 1.5),
              boxShadow: [
                BoxShadow(color: Colors.orange.withValues(alpha: 0.05), blurRadius: 8, offset: const Offset(0, 2)),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        CircleAvatar(
                          backgroundColor: const Color(0xFFEA580C),
                          radius: 16,
                          child: Text(
                            (user['fullName'] ?? 'G')[0].toUpperCase(),
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(user['fullName'] ?? 'Gateman', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                            Text('Emp ID: ${user['employeeId'] ?? 'N/A'}', style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
                          ],
                        ),
                      ],
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFF7ED),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFFDBA74)),
                      ),
                      child: Text(
                        type == 'CHECK_IN' ? 'Check-In' : 'Check-Out',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFFC2410C)),
                      ),
                    ),
                  ],
                ),
                const Divider(height: 20),

                // Gate & Reason details
                Row(
                  children: [
                    const Icon(Icons.meeting_room_outlined, size: 16, color: Color(0xFF0D47A1)),
                    const SizedBox(width: 6),
                    Text(
                      'Gate: ${_formatLcNumber(gate['lcNumber'])} (${gate['locationName'] ?? 'Station'})',
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Color(0xFF1E293B)),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF8FAFC),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Text(
                    'Reason: $reason',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF475569), fontStyle: FontStyle.italic),
                  ),
                ),
                if (selfieUrl != null && selfieUrl.toString().startsWith('http')) ...[
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: GestureDetector(
                          onTap: () {
                            showDialog(
                              context: context,
                              builder: (ctx) => Dialog(
                                backgroundColor: Colors.transparent,
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    ClipRRect(
                                      borderRadius: BorderRadius.circular(12),
                                      child: Image.network(
                                        selfieUrl,
                                        fit: BoxFit.contain,
                                        errorBuilder: (context, error, stackTrace) => Container(
                                          padding: const EdgeInsets.all(24),
                                          color: Colors.white,
                                          child: const Text('Failed to load image from Cloudinary CDN'),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(height: 12),
                                    IconButton(
                                      icon: const Icon(Icons.close, color: Colors.white, size: 30),
                                      onPressed: () => Navigator.pop(ctx),
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                          child: Stack(
                            alignment: Alignment.bottomRight,
                            children: [
                              Image.network(
                                selfieUrl,
                                width: 64,
                                height: 64,
                                fit: BoxFit.cover,
                                errorBuilder: (context, error, stackTrace) => Container(
                                  width: 64,
                                  height: 64,
                                  color: const Color(0xFFF1F5F9),
                                  child: const Icon(Icons.broken_image, size: 24, color: Colors.grey),
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.all(2),
                                color: Colors.black54,
                                child: const Icon(Icons.zoom_in, color: Colors.white, size: 14),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Proof Photo Attached',
                              style: TextStyle(fontSize: 12, color: Color(0xFF16A34A), fontWeight: FontWeight.bold),
                            ),
                            Text(
                              'Tap thumbnail to view full resolution on Cloudinary CDN',
                              style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ] else if (selfieUrl != null && selfieUrl.toString().startsWith('[PURGED')) ...[
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.auto_delete, size: 14, color: Color(0xFF64748B)),
                        SizedBox(width: 6),
                        Text(
                          'Photo Purged (24h Retention Expired)',
                          style: TextStyle(fontSize: 11, color: Color(0xFF64748B), fontStyle: FontStyle.italic),
                        ),
                      ],
                    ),
                  ),
                ] else if (selfieUrl != null) ...[
                  const SizedBox(height: 8),
                  const Text('Proof Photo: Attached by device camera', style: TextStyle(fontSize: 11, color: Colors.green, fontWeight: FontWeight.bold)),
                ],
                const SizedBox(height: 14),

                // Action Buttons: One-tap Approve / Reject
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red,
                          side: const BorderSide(color: Colors.red),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.close, size: 16),
                        label: const Text('Reject'),
                        onPressed: _isProcessingAction ? null : () => _handleReviewRequest(reqId, 'REJECT'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF16A34A),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.check, size: 18),
                        label: const Text('One-Tap Approve', style: TextStyle(fontWeight: FontWeight.bold)),
                        onPressed: _isProcessingAction ? null : () => _handleReviewRequest(reqId, 'APPROVE'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildPendingReenrollmentsTab() {
    if (_pendingReenrollments.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.verified_user_outlined, size: 54, color: Colors.green.shade300),
            const SizedBox(height: 12),
            const Text(
              'No Pending Face Re-Enrollment Requests',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF1E293B)),
            ),
            const SizedBox(height: 6),
            const Text(
              'All Gateman and Restkeeper biometric profiles are active.',
              style: TextStyle(color: Colors.black54, fontSize: 12),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchPendingReenrollments,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _pendingReenrollments.length,
        itemBuilder: (context, index) {
          final req = _pendingReenrollments[index];
          final reqId = req['id'] as int;
          final user = req['user'] ?? {};
          final fullName = user['fullName'] ?? 'Field Staff';
          final empId = user['employeeId'] ?? 'N/A';
          final desig = user['designation'] ?? 'Gateman';
          final station = user['station']?['name'] ?? 'Section';
          final reason = req['reason'] ?? 'Face matching failure / physical change';
          final faceImg = user['faceImageKey'];
          final createdAt = req['createdAt'] != null ? req['createdAt'].toString().substring(0, 10) : '';

          final assignedGates = (user['assignedGates'] as List?)
                  ?.map((ag) => ag['gate']?['lcNumber'] ?? '')
                  .where((n) => n.toString().isNotEmpty)
                  .join(', ') ??
              '';

          return Container(
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE2E8F0)),
              boxShadow: [
                BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 6, offset: const Offset(0, 2)),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0xFFBFDBFE)),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.shield_outlined, size: 12, color: Color(0xFF1D4ED8)),
                          SizedBox(width: 4),
                          Text(
                            'PWI Incharge Review',
                            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF1D4ED8)),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      createdAt,
                      style: const TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (faceImg != null && faceImg.toString().startsWith('http'))
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.network(
                          faceImg,
                          width: 52,
                          height: 52,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                            width: 52,
                            height: 52,
                            color: const Color(0xFFE2E8F0),
                            child: const Icon(Icons.person, color: Color(0xFF64748B)),
                          ),
                        ),
                      )
                    else
                      Container(
                        width: 52,
                        height: 52,
                        decoration: BoxDecoration(
                          color: const Color(0xFFEFF6FF),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Icon(Icons.face, color: Color(0xFF2563EB)),
                      ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            fullName,
                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '$desig • Emp ID: $empId',
                            style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                          ),
                          if (assignedGates.isNotEmpty)
                            Text(
                              'Assigned: $assignedGates ($station)',
                              style: const TextStyle(fontSize: 11, color: Color(0xFF0284C7), fontWeight: FontWeight.w600),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFFBEB),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFFDE68A)),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.info_outline, size: 16, color: Color(0xFFB45309)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Reason: $reason',
                          style: const TextStyle(fontSize: 12, color: Color(0xFF92400E)),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red,
                          side: const BorderSide(color: Colors.red),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.close, size: 16),
                        label: const Text('Reject'),
                        onPressed: _isProcessingAction ? null : () => _handleReviewReenrollment(reqId, 'REJECT'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: ElevatedButton.icon(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF2563EB),
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                        ),
                        icon: const Icon(Icons.lock_open, size: 18),
                        label: const Text('Approve & Unlock Face', style: TextStyle(fontWeight: FontWeight.bold)),
                        onPressed: _isProcessingAction ? null : () => _handleReviewReenrollment(reqId, 'APPROVE'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}