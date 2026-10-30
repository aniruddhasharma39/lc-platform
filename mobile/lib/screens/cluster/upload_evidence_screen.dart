import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'dart:io' as io;
import '../../config.dart';
import '../../utils/app_feedback.dart';

class UploadEvidenceScreen extends StatefulWidget {
  final String token;
  final int masterId;
  final int? childDeviceId;
  final String category; // 'MASTER', 'DEVICE_1', 'DEVICE_2', 'POWER_SOURCE'
  final String targetName; // e.g., 'Master 123'

  const UploadEvidenceScreen({
    super.key,
    required this.token,
    required this.masterId,
    this.childDeviceId,
    required this.category,
    required this.targetName,
  });

  @override
  State<UploadEvidenceScreen> createState() => _UploadEvidenceScreenState();
}

class _UploadEvidenceScreenState extends State<UploadEvidenceScreen> with WidgetsBindingObserver {
  XFile? _image;
  final ImagePicker _picker = ImagePicker();
  bool _isLoading = false;
  double _uploadProgress = 0.0;
  String _progressStatus = '';
  String _sourceLabel = 'Camera';
  Timer? _progressTimer;

  Position? _currentPosition;
  bool _isCheckingLocation = false;
  bool _isLocationServiceEnabled = true;
  String? _locationStatusMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshLocationStatus();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _progressTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Re-check automatically when user returns from settings
      _refreshLocationStatus();
    }
  }

  Future<void> _refreshLocationStatus({bool isManual = false}) async {
    if (_isCheckingLocation) return;
    setState(() => _isCheckingLocation = true);

    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      setState(() => _isLocationServiceEnabled = serviceEnabled);

      if (!serviceEnabled) {
        setState(() {
          _currentPosition = null;
          _locationStatusMessage = 'Device Location (GPS) is turned OFF.';
        });
        if (mounted && isManual) {
          AppFeedback.showWarning(context, 'Device Location (GPS) is turned OFF.');
        }
        return;
      }

      final permission = await Geolocator.checkPermission();

      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        setState(() {
          _currentPosition = null;
          _locationStatusMessage = 'Location permission is required.';
        });
        if (mounted && isManual) {
          AppFeedback.showWarning(context, 'Location permission is required to upload evidence.');
        }
        return;
      }

      Position? pos;
      try {
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 4),
        );
      } catch (_) {
        pos = await Geolocator.getLastKnownPosition();
      }

      if (mounted) {
        setState(() {
          _currentPosition = pos;
          _locationStatusMessage = pos != null
              ? 'GPS Ready: ${pos.latitude.toStringAsFixed(4)}, ${pos.longitude.toStringAsFixed(4)}'
              : 'Acquiring GPS fix...';
        });
        if (isManual && pos != null) {
          AppFeedback.showSuccess(
            context,
            'GPS coordinates updated: ${pos.latitude.toStringAsFixed(4)}, ${pos.longitude.toStringAsFixed(4)}',
          );
        }
      }
    } catch (e) {
      debugPrint('Error refreshing location: $e');
    } finally {
      if (mounted) {
        setState(() => _isCheckingLocation = false);
      }
    }
  }

  Future<Position?> _requireLocation() async {
    // 1. Check if location services (GPS) are turned ON
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    setState(() => _isLocationServiceEnabled = serviceEnabled);

    if (!serviceEnabled) {
      if (mounted) {
        await showDialog(
          context: context,
          barrierDismissible: false,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.location_off, color: Colors.orange, size: 52),
            title: const Text('Turn On Location', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold)),
            content: const Text(
              'Device Location (GPS) is currently turned OFF.\n\nStrict location verification is required to upload evidence proofs.\nPlease turn ON your device location in system settings.',
              textAlign: TextAlign.center,
            ),
            actionsAlignment: MainAxisAlignment.center,
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Cancel'),
              ),
              ElevatedButton.icon(
                icon: const Icon(Icons.location_on),
                label: const Text('Turn On Location'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.blue.shade700,
                  foregroundColor: Colors.white,
                ),
                onPressed: () async {
                  Navigator.pop(ctx);
                  await Geolocator.openLocationSettings();
                },
              ),
            ],
          ),
        );
      }
      return null;
    }

    // 2. Check location permissions
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied) {
      if (mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.lock, color: Colors.red, size: 48),
            title: const Text('Location Permission Required'),
            content: const Text(
              'Location permission was denied. Evidence proof cannot be uploaded without GPS location stamp. Please allow location access.',
              textAlign: TextAlign.center,
            ),
            actions: [
              ElevatedButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
            ],
          ),
        );
      }
      return null;
    }

    if (permission == LocationPermission.deniedForever) {
      if (mounted) {
        await showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.location_disabled, color: Colors.red, size: 48),
            title: const Text('Permission Denied in Settings'),
            content: const Text(
              'Location permission is permanently denied. Please open App Settings and grant location access to upload evidence.',
              textAlign: TextAlign.center,
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              ElevatedButton(
                onPressed: () async {
                  Navigator.pop(ctx);
                  await Geolocator.openAppSettings();
                },
                child: const Text('Open App Settings'),
              ),
            ],
          ),
        );
      }
      return null;
    }

    // 3. Acquire current location
    Position? position;
    try {
      position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 8),
      );
    } catch (_) {
      position = await Geolocator.getLastKnownPosition();
    }

    if (position == null) {
      if (mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.gps_fixed, color: Colors.amber, size: 48),
            title: const Text('Unable to Acquire GPS Fix'),
            content: const Text(
              'Could not get GPS fix. Please ensure location is turned ON, move near an open window/area if indoors, and try again.',
              textAlign: TextAlign.center,
            ),
            actions: [
              ElevatedButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
            ],
          ),
        );
      }
      return null;
    }

    setState(() {
      _currentPosition = position;
      _locationStatusMessage = 'GPS Ready: ${position!.latitude.toStringAsFixed(4)}, ${position.longitude.toStringAsFixed(4)}';
    });
    return position;
  }

  Future<void> _captureWithCamera() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 70);
    if (photo != null) {
      setState(() {
        _image = photo;
        _sourceLabel = 'Live Camera';
      });
      if (mounted) {
        AppFeedback.showSuccess(context, 'Photo captured via Live Camera.');
      }
      _refreshLocationStatus();
    }
  }

  Future<void> _upload() async {
    if (_image == null) {
      AppFeedback.showWarning(context, 'Please capture or select a photo first.');
      return;
    }

    setState(() {
      _isLoading = true;
      _uploadProgress = 0.10;
      _progressStatus = 'Verifying GPS location...';
    });

    final position = await _requireLocation();
    if (position == null) {
      // STRICT: Abort upload if location is turned off or not available!
      if (mounted) {
        setState(() => _isLoading = false);
      }
      return;
    }

    try {
      // Step 2: Read image to base64
      setState(() {
        _uploadProgress = 0.40;
        _progressStatus = 'Preparing and optimizing photo...';
      });

      final bytes = await _image!.readAsBytes();
      final base64Image = 'data:image/jpeg;base64,${base64Encode(bytes)}';

      // Step 3: Preparing payload & starting upload
      setState(() {
        _uploadProgress = 0.60;
        _progressStatus = 'Uploading photo with GPS stamp...';
      });

      final body = <String, dynamic>{
        'masterId': widget.masterId,
        'category': widget.category,
        'imageBase64': base64Image,
        'latitude': position.latitude,
        'longitude': position.longitude,
      };
      if (widget.childDeviceId != null) {
        body['childDeviceId'] = widget.childDeviceId;
      }

      // Smooth progress ticker while awaiting network
      _progressTimer?.cancel();
      _progressTimer = Timer.periodic(const Duration(milliseconds: 250), (timer) {
        if (!mounted) {
          timer.cancel();
          return;
        }
        setState(() {
          if (_uploadProgress < 0.92) {
            _uploadProgress += 0.04;
          }
        });
      });

      final res = await http.post(
        Uri.parse('$baseUrl/evidence'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode(body),
      );

      _progressTimer?.cancel();

      if (res.statusCode == 201) {
        setState(() {
          _uploadProgress = 1.0;
          _progressStatus = 'Upload complete!';
        });
        if (mounted) {
          AppFeedback.showSuccess(
            context,
            'Evidence for "${widget.targetName}" uploaded with verified GPS coordinates!',
          );
        }
        await Future.delayed(const Duration(milliseconds: 300));
        if (mounted) {
          Navigator.pop(context, json.decode(res.body));
        }
      } else {
        String errMsg = 'Upload failed (${res.statusCode})';
        try {
          final errJson = json.decode(res.body);
          if (errJson is Map) {
            if (errJson['message'] != null) {
              errMsg = errJson['message'].toString();
            } else if (errJson['error'] != null) {
              errMsg = errJson['error'].toString();
            }
          }
        } catch (_) {
          errMsg = res.body;
        }
        throw Exception(errMsg);
      }
    } catch (e) {
      _progressTimer?.cancel();
      if (mounted) {
        String msg = e.toString();
        if (msg.startsWith('Exception: ')) {
          msg = msg.substring('Exception: '.length);
        }
        AppFeedback.showError(context, msg);
      }
    } finally {
      _progressTimer?.cancel();
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  Widget _buildLocationStatusCard() {
    if (_currentPosition != null) {
      return Container(
        constraints: const BoxConstraints(maxWidth: 360),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        margin: const EdgeInsets.only(bottom: 16),
        decoration: BoxDecoration(
          color: Colors.green.shade50,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Colors.green.shade300),
        ),
        child: Row(
          children: [
            Icon(Icons.check_circle, color: Colors.green.shade700, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'GPS Location Ready',
                    style: TextStyle(fontWeight: FontWeight.bold, color: Colors.green.shade900, fontSize: 13),
                  ),
                  Text(
                    '${_currentPosition!.latitude.toStringAsFixed(5)}, ${_currentPosition!.longitude.toStringAsFixed(5)}',
                    style: TextStyle(color: Colors.green.shade800, fontSize: 12),
                  ),
                ],
              ),
            ),
            IconButton(
              icon: const Icon(Icons.refresh, size: 20),
              color: Colors.green.shade700,
              tooltip: 'Refresh GPS',
              onPressed: _isLoading ? null : () => _refreshLocationStatus(isManual: true),
            ),
          ],
        ),
      );
    }

    if (!_isLocationServiceEnabled) {
      return Container(
        constraints: const BoxConstraints(maxWidth: 360),
        padding: const EdgeInsets.all(12),
        margin: const EdgeInsets.only(bottom: 16),
        decoration: BoxDecoration(
          color: Colors.orange.shade50,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Colors.orange.shade300),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.location_off, color: Colors.orange.shade800, size: 22),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Location (GPS) is Turned OFF',
                    style: TextStyle(fontWeight: FontWeight.bold, color: Colors.orange.shade900, fontSize: 13),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'Proof cannot be uploaded until device location is turned ON.',
              style: TextStyle(color: Colors.orange.shade900, fontSize: 12),
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                icon: const Icon(Icons.location_on, size: 18),
                label: const Text('Turn On Location'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.orange.shade700,
                  foregroundColor: Colors.white,
                  visualDensity: VisualDensity.compact,
                ),
                onPressed: () => Geolocator.openLocationSettings(),
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      constraints: const BoxConstraints(maxWidth: 360),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: Colors.blue.shade50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.blue.shade200),
      ),
      child: Row(
        children: [
          Icon(Icons.gps_fixed, color: Colors.blue.shade700, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              _locationStatusMessage ?? 'GPS location required for proof upload',
              style: TextStyle(color: Colors.blue.shade900, fontSize: 12, fontWeight: FontWeight.w500),
            ),
          ),
          IconButton(
            icon: _isCheckingLocation
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh, size: 20),
            color: Colors.blue.shade700,
            tooltip: 'Check GPS',
            onPressed: _isLoading ? null : () => _refreshLocationStatus(),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Upload Photo: ${widget.targetName}')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // Live Location Status Banner
              _buildLocationStatusCard(),

              if (_image != null) ...[
                kIsWeb ? Image.network(_image!.path, height: 300) : Image.file(io.File(_image!.path), height: 300),
                const SizedBox(height: 16),
                Text('Source: $_sourceLabel', style: const TextStyle(color: Colors.grey, fontSize: 13)),
                const SizedBox(height: 24),
              ],
              ElevatedButton.icon(
                icon: const Icon(Icons.camera_alt),
                label: Text(_image == null ? 'Capture Photo (Camera Only)' : 'Retake Photo (Camera)'),
                onPressed: _isLoading ? null : _captureWithCamera,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF0B3C7A),
                  foregroundColor: Colors.white,
                  minimumSize: const Size(220, 50),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: const [
                  Icon(Icons.verified_user_outlined, size: 14, color: Color(0xFF059669)),
                  SizedBox(width: 5),
                  Text(
                    'Live Camera capture enforced for proof integrity',
                    style: TextStyle(fontSize: 11, color: Color(0xFF059669), fontWeight: FontWeight.w600),
                  ),
                ],
              ),              const SizedBox(height: 20),

              // Visual Progress Bar when uploading
              if (_isLoading) ...[
                Container(
                  constraints: const BoxConstraints(maxWidth: 360),
                  padding: const EdgeInsets.all(16),
                  margin: const EdgeInsets.only(bottom: 20),
                  decoration: BoxDecoration(
                    color: Colors.blue.shade50,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Colors.blue.shade200),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              _progressStatus,
                              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.blue.shade900),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          Text(
                            '${(_uploadProgress * 100).toInt()}%',
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.blue.shade900),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: LinearProgressIndicator(
                          value: _uploadProgress.clamp(0.0, 1.0),
                          minHeight: 10,
                          backgroundColor: Colors.blue.shade100,
                          valueColor: AlwaysStoppedAnimation<Color>(Colors.blue.shade700),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              if (_image != null)
                ElevatedButton.icon(
                  icon: _isLoading
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                      : const Icon(Icons.cloud_upload),
                  label: Text(_isLoading ? 'Uploading (${(_uploadProgress * 100).toInt()}%)...' : 'Upload Evidence'),
                  onPressed: _isLoading ? null : _upload,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.green,
                    disabledBackgroundColor: Colors.green.shade300,
                    disabledForegroundColor: Colors.white,
                    minimumSize: const Size(220, 50),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}