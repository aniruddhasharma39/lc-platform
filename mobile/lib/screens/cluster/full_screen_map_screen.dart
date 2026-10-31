import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../services/home_cache_service.dart';
import '../../utils/app_feedback.dart';

class FullScreenMapScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final String token;
  final List<dynamic> initialGates;
  final Function(int gateId, String tab)? onNavigateToGate;

  const FullScreenMapScreen({
    super.key,
    required this.user,
    required this.token,
    required this.initialGates,
    this.onNavigateToGate,
  });

  @override
  State<FullScreenMapScreen> createState() => _FullScreenMapScreenState();
}

class _FullScreenMapScreenState extends State<FullScreenMapScreen> {
  final MapController _mapController = MapController();
  late List<dynamic> _gates;
  bool _isRefreshing = false;
  String? _selectedLcNumber;

  @override
  void initState() {
    super.initState();
    _gates = List.from(widget.initialGates);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fitMapToMarkers();
    });
  }

  String get _userId => (widget.user['id'] ?? widget.user['username'] ?? 'user').toString();

  Future<void> _refreshMapData() async {
    setState(() => _isRefreshing = true);
    try {
      final result = await HomeCacheService.instance.syncDashboard(
        userId: _userId,
        token: widget.token,
        forceFullReload: true,
      );

      if (mounted) {
        if (result.cacheData != null) {
          final summary = result.cacheData!.data;
          final updatedGates = (summary['gates'] is List) ? List.from(summary['gates']) : _gates;
          setState(() {
            _gates = updatedGates;
            _isRefreshing = false;
          });
          if (result.status != HomeSyncStatus.offline) {
            AppFeedback.showSuccess(context, 'Map markers refreshed successfully.');
          }
        } else {
          setState(() => _isRefreshing = false);
          AppFeedback.showError(context, 'Unable to refresh map markers.');
        }
      }
    } catch (_) {
      if (mounted) setState(() => _isRefreshing = false);
    }
  }

  void _fitMapToMarkers() {
    final validPoints = _gates
        .where((g) => g['latitude'] != null && g['longitude'] != null)
        .map((g) => LatLng(
              (g['latitude'] as num).toDouble(),
              (g['longitude'] as num).toDouble(),
            ))
        .toList();

    if (validPoints.isEmpty) {
      // Default to central India
      _mapController.move(const LatLng(22.9734, 78.6569), 4.8);
      return;
    }

    if (validPoints.length == 1) {
      _mapController.move(validPoints.first, 12);
      return;
    }

    // Compute bounding box
    double minLat = validPoints.first.latitude;
    double maxLat = validPoints.first.latitude;
    double minLng = validPoints.first.longitude;
    double maxLng = validPoints.first.longitude;

    for (var p in validPoints) {
      minLat = min(minLat, p.latitude);
      maxLat = max(maxLat, p.latitude);
      minLng = min(minLng, p.longitude);
      maxLng = max(maxLng, p.longitude);
    }

    final bounds = LatLngBounds(LatLng(minLat, minLng), LatLng(maxLat, maxLng));
    _mapController.fitCamera(
      CameraFit.bounds(
        bounds: bounds,
        padding: const EdgeInsets.all(50),
      ),
    );
  }

  void _zoomIn() {
    final currentZoom = _mapController.camera.zoom;
    _mapController.move(_mapController.camera.center, (currentZoom + 1).clamp(3.5, 18.0));
  }

  void _zoomOut() {
    final currentZoom = _mapController.camera.zoom;
    _mapController.move(_mapController.camera.center, (currentZoom - 1).clamp(3.5, 18.0));
  }

  void _showGateDetails(Map<String, dynamic> gate) {
    final gateId = gate['id'] as int;
    final lcNumber = (gate['hasMaster'] == true && gate['masterSerialNumber'] != null && gate['masterSerialNumber'] != 'Unassigned')
        ? gate['masterSerialNumber'].toString()
        : (gate['lcNumber']?.toString() ?? 'LC-GATE');
    final location = gate['locationName'] ?? '';
    final zone = gate['zone'] ?? '';
    final division = gate['division'] ?? '';
    final isUnconfigured = gate['status'] == 'UNCONFIGURED' || gate['hasMaster'] == false;
    final isOpen = !isUnconfigured && gate['status'] == 'OPEN';
    final todayCycles = gate['todayCycles'] ?? 0;
    final totalCycles = gate['totalCycles'] ?? 0;
    final lastClosedFormatted = gate['lastClosedFormatted'] ?? 'No recorded closure';
    final isSolar = gate['powerSource'] == 'SOLAR';

    setState(() => _selectedLcNumber = lcNumber);

    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      backgroundColor: Colors.white,
      builder: (ctx) {
        return Container(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F172A),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          lcNumber,
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                      ),
                      if (isSolar) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: Colors.amber.shade50,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: Colors.amber.shade200),
                          ),
                          child: Row(
                            children: [
                              Icon(Icons.wb_sunny_rounded, size: 12, color: Colors.amber.shade800),
                              const SizedBox(width: 4),
                              Text(
                                'Solar',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: Colors.amber.shade800,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: isUnconfigured
                          ? const Color(0xFFFEF3C7)
                          : (isOpen ? const Color(0xFFFEE2E2) : const Color(0xFFD1FAE5)),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: isUnconfigured
                            ? const Color(0xFFFDE68A)
                            : (isOpen ? const Color(0xFFFECACA) : const Color(0xFFA7F3D0)),
                      ),
                    ),
                    child: Text(
                      isUnconfigured ? '● UNCONFIGURED' : (isOpen ? '● OPEN' : '● CLOSED'),
                      style: TextStyle(
                        color: isUnconfigured
                            ? const Color(0xFFD97706)
                            : (isOpen ? const Color(0xFFDC2626) : const Color(0xFF059669)),
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),

              // Location and Zone
              Text(
                location,
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
              ),
              const SizedBox(height: 2),
              Text(
                '$zone • $division Division',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
              const SizedBox(height: 14),

              // Metric Card
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.history, color: Color(0xFF0284C7), size: 20),
                        const SizedBox(width: 8),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('CYCLES TODAY', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                            Text('$todayCycles times', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
                          ],
                        ),
                      ],
                    ),
                    Text('Total: $totalCycles', style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600, fontWeight: FontWeight.w500)),
                  ],
                ),
              ),
              const SizedBox(height: 10),

              // Last Closed
              Row(
                children: [
                  Icon(Icons.schedule, size: 14, color: Colors.grey.shade500),
                  const SizedBox(width: 6),
                  Text(
                    'Last Closed: $lastClosedFormatted',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700, fontWeight: FontWeight.w500),
                  ),
                ],
              ),
              const SizedBox(height: 18),

              // Navigation Actions
              Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      icon: const Icon(Icons.developer_board, size: 16),
                      label: const Text('Telemetry', style: TextStyle(fontWeight: FontWeight.bold)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0284C7),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: () {
                        Navigator.pop(ctx);
                        Navigator.pop(context);
                        if (widget.onNavigateToGate != null) {
                          widget.onNavigateToGate!(gateId, 'telemetry');
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.info_outline, size: 16),
                      label: const Text('About Gate', style: TextStyle(fontWeight: FontWeight.bold)),
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        side: BorderSide(color: Colors.grey.shade300),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                      onPressed: () {
                        Navigator.pop(ctx);
                        Navigator.pop(context);
                        if (widget.onNavigateToGate != null) {
                          widget.onNavigateToGate!(gateId, 'about');
                        }
                      },
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final validGates = _gates.where((g) => g['latitude'] != null && g['longitude'] != null).toList();
    final openCount = _gates.where((g) => g['status'] == 'OPEN').length;
    final closedCount = _gates.where((g) => g['status'] == 'CLOSED').length;
    final unconfiguredCount = _gates.where((g) => g['status'] == 'UNCONFIGURED' || g['hasMaster'] == false).length;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'India LC Gate Clusters Map',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            Text(
              '${validGates.length} active gate clusters',
              style: const TextStyle(fontSize: 11.5, color: Colors.white70),
            ),
          ],
        ),
        elevation: 0,
        actions: [
          IconButton(
            icon: _isRefreshing
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.refresh),
            tooltip: 'Refresh Gate Statuses',
            onPressed: _isRefreshing ? null : _refreshMapData,
          ),
        ],
      ),
      body: Stack(
        children: [
          // 1. Full Screen Interactive FlutterMap
          FlutterMap(
            mapController: _mapController,
            options: const MapOptions(
              initialCenter: LatLng(22.9734, 78.6569), // Central India
              initialZoom: 4.8,
              minZoom: 3.5,
              maxZoom: 18,
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                userAgentPackageName: 'com.lcgate.mobile',
              ),
              MarkerLayer(
                markers: validGates.map((g) {
                  final lat = (g['latitude'] as num).toDouble();
                  final lng = (g['longitude'] as num).toDouble();
                  final isUnconfigured = g['status'] == 'UNCONFIGURED' || g['hasMaster'] == false;
                  final isOpen = !isUnconfigured && g['status'] == 'OPEN';
                  final color = isUnconfigured
                      ? const Color(0xFFD97706)
                      : (isOpen ? const Color(0xFFDC2626) : const Color(0xFF059669));
                  final lcNumber = (g['hasMaster'] == true && g['masterSerialNumber'] != null && g['masterSerialNumber'] != 'Unassigned')
                      ? g['masterSerialNumber'].toString()
                      : (g['lcNumber']?.toString() ?? 'LC');
                  final isSelected = _selectedLcNumber == lcNumber;

                  return Marker(
                    point: LatLng(lat, lng),
                    width: 100,
                    height: 38,
                    child: GestureDetector(
                      onTap: () => _showGateDetails(g),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 200),
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(
                            color: isSelected ? const Color(0xFF0284C7) : color,
                            width: isSelected ? 3 : 2,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withOpacity(0.25),
                              blurRadius: 6,
                              offset: const Offset(0, 2),
                            )
                          ],
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                lcNumber,
                                style: const TextStyle(
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFF0F172A),
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }).toList(),
              ),
            ],
          ),

          // 2. Top Legend & Status Pill
          Positioned(
            top: 12,
            left: 12,
            right: 12,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.95),
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.12),
                    blurRadius: 8,
                    offset: const Offset(0, 2),
                  )
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 9,
                        height: 9,
                        decoration: const BoxDecoration(
                          color: Color(0xFF059669),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 5),
                      Text(
                        'Closed ($closedCount)',
                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFF059669)),
                      ),
                      const SizedBox(width: 14),
                      Container(
                        width: 9,
                        height: 9,
                        decoration: const BoxDecoration(
                          color: Color(0xFFDC2626),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 5),
                      Text(
                        'Opened ($openCount)',
                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFFDC2626)),
                      ),
                      if (unconfiguredCount > 0) ...[
                        const SizedBox(width: 14),
                        Container(
                          width: 9,
                          height: 9,
                          decoration: const BoxDecoration(
                            color: Color(0xFFD97706),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          'Unconfigured ($unconfiguredCount)',
                          style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: Color(0xFFD97706)),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),

          // 3. Floating Map Controls (Zoom In, Zoom Out, Recenter)
          Positioned(
            bottom: 24,
            right: 16,
            child: Column(
              children: [
                FloatingActionButton.small(
                  heroTag: 'map_fit_bounds',
                  backgroundColor: Colors.white,
                  foregroundColor: const Color(0xFF0F172A),
                  tooltip: 'Fit All Clusters',
                  onPressed: _fitMapToMarkers,
                  child: const Icon(Icons.crop_free, size: 20),
                ),
                const SizedBox(height: 8),
                FloatingActionButton.small(
                  heroTag: 'map_zoom_in',
                  backgroundColor: Colors.white,
                  foregroundColor: const Color(0xFF0F172A),
                  tooltip: 'Zoom In',
                  onPressed: _zoomIn,
                  child: const Icon(Icons.add, size: 20),
                ),
                const SizedBox(height: 8),
                FloatingActionButton.small(
                  heroTag: 'map_zoom_out',
                  backgroundColor: Colors.white,
                  foregroundColor: const Color(0xFF0F172A),
                  tooltip: 'Zoom Out',
                  onPressed: _zoomOut,
                  child: const Icon(Icons.remove, size: 20),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
