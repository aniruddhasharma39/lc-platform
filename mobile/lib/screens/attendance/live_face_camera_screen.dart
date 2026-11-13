import 'dart:io';
import 'package:flutter/material.dart';
import 'package:camera/camera.dart';
import 'package:image_picker/image_picker.dart';
import '../../widgets/face_scanner_overlay.dart';

class LiveFaceCameraScreen extends StatefulWidget {
  final String title;
  final String subtitle;

  const LiveFaceCameraScreen({
    super.key,
    this.title = 'Face Biometric Capture',
    this.subtitle = 'Align your face inside the oval frame',
  });

  @override
  State<LiveFaceCameraScreen> createState() => _LiveFaceCameraScreenState();
}

class _LiveFaceCameraScreenState extends State<LiveFaceCameraScreen> with WidgetsBindingObserver {
  List<CameraDescription> _cameras = [];
  CameraController? _controller;
  bool _isCameraInitialized = false;
  bool _isFrontCamera = true;
  bool _isTakingPicture = false;
  bool _screenFlash = false;
  XFile? _capturedPhoto;
  String _guidanceMessage = 'Center your face inside the oval';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initCameras();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final CameraController? cameraController = _controller;
    if (cameraController == null || !cameraController.value.isInitialized) {
      return;
    }

    if (state == AppLifecycleState.inactive) {
      cameraController.dispose();
    } else if (state == AppLifecycleState.resumed) {
      _initCameraController(cameraController.description);
    }
  }

  Future<void> _initCameras() async {
    try {
      _cameras = await availableCameras();
      if (_cameras.isEmpty) {
        setState(() => _isCameraInitialized = false);
        return;
      }

      // Default to front camera
      final frontCamera = _cameras.firstWhere(
        (cam) => cam.lensDirection == CameraLensDirection.front,
        orElse: () => _cameras.first,
      );

      _isFrontCamera = frontCamera.lensDirection == CameraLensDirection.front;
      await _initCameraController(frontCamera);
    } catch (e) {
      debugPrint('Error discovering cameras: $e');
      setState(() => _isCameraInitialized = false);
    }
  }

  Future<void> _initCameraController(CameraDescription camera) async {
    final controller = CameraController(
      camera,
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );

    _controller = controller;

    try {
      await controller.initialize();
      if (mounted) {
        setState(() {
          _isCameraInitialized = true;
          _isFrontCamera = camera.lensDirection == CameraLensDirection.front;
        });
      }
    } catch (e) {
      debugPrint('Error initializing camera controller: $e');
      if (mounted) {
        setState(() => _isCameraInitialized = false);
      }
    }
  }

  Future<void> _flipCamera() async {
    if (_cameras.length < 2 || _controller == null) return;

    final newDirection = _isFrontCamera ? CameraLensDirection.back : CameraLensDirection.front;
    final newCamera = _cameras.firstWhere(
      (cam) => cam.lensDirection == newDirection,
      orElse: () => _cameras.first,
    );

    await _controller?.dispose();
    setState(() {
      _isCameraInitialized = false;
      _capturedPhoto = null;
    });
    await _initCameraController(newCamera);
  }

  Future<void> _capturePhoto() async {
    if (_controller == null || !_controller!.value.isInitialized || _isTakingPicture) {
      return;
    }

    setState(() {
      _isTakingPicture = true;
      _guidanceMessage = 'Capturing face... Hold still';
    });

    try {
      final photo = await _controller!.takePicture();
      if (mounted) {
        setState(() {
          _capturedPhoto = photo;
          _isTakingPicture = false;
          _guidanceMessage = 'Face captured! Check alignment below.';
        });
      }
    } catch (e) {
      debugPrint('Error capturing photo: $e');
      if (mounted) {
        setState(() {
          _isTakingPicture = false;
          _guidanceMessage = 'Capture failed. Tap shutter again.';
        });
      }
    }
  }

  Future<void> _fallbackSystemCamera() async {
    try {
      final picker = ImagePicker();
      final photo = await picker.pickImage(
        source: ImageSource.camera,
        preferredCameraDevice: _isFrontCamera ? CameraDevice.front : CameraDevice.rear,
        imageQuality: 92,
        maxWidth: 1200,
        maxHeight: 1200,
      );
      if (photo != null && mounted) {
        setState(() {
          _capturedPhoto = photo;
          _guidanceMessage = 'Photo selected! Confirm below.';
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Camera error: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _screenFlash ? Colors.white : Colors.black,
      appBar: AppBar(
        title: Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF0D47A1),
        foregroundColor: Colors.white,
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(
            tooltip: 'Night Illumination Flash',
            icon: Icon(
              _screenFlash ? Icons.flash_on : Icons.flash_off,
              color: _screenFlash ? Colors.amber : Colors.white70,
            ),
            onPressed: () {
              setState(() => _screenFlash = !_screenFlash);
            },
          ),
          if (_cameras.length > 1)
            IconButton(
              tooltip: 'Flip Camera',
              icon: const Icon(Icons.flip_camera_ios_rounded, color: Colors.white70),
              onPressed: _capturedPhoto == null ? _flipCamera : null,
            ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          // 1. Live Camera Preview OR Captured Photo Preview
          if (_capturedPhoto != null)
            Image.file(
              File(_capturedPhoto!.path),
              fit: BoxFit.cover,
            )
          else if (_isCameraInitialized && _controller != null)
            Center(
              child: CameraPreview(_controller!),
            )
          else
            Container(
              color: Colors.black,
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const CircularProgressIndicator(color: Colors.cyan),
                    const SizedBox(height: 16),
                    const Text(
                      'Opening biometric live camera...',
                      style: TextStyle(color: Colors.white70, fontSize: 13),
                    ),
                    const SizedBox(height: 24),
                    ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0288D1),
                        foregroundColor: Colors.white,
                      ),
                      icon: const Icon(Icons.photo_camera),
                      label: const Text('Use System Camera'),
                      onPressed: _fallbackSystemCamera,
                    ),
                  ],
                ),
              ),
            ),

          // 2. Oval Face Scanner Frame with Corner Alignment Markers
          FaceScannerOverlay(
            statusText: _guidanceMessage,
            isFaceDetected: _capturedPhoto != null,
          ),

          // 3. Bottom Control Bar (Shutter or Confirm/Retake)
          Positioned(
            bottom: 28,
            left: 20,
            right: 20,
            child: _capturedPhoto != null
                ? Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          style: OutlinedButton.styleFrom(
                            backgroundColor: Colors.black.withValues(alpha: 0.7),
                            foregroundColor: Colors.white,
                            side: const BorderSide(color: Colors.white70),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          icon: const Icon(Icons.replay_rounded),
                          label: const Text('Retake', style: TextStyle(fontWeight: FontWeight.bold)),
                          onPressed: () {
                            setState(() {
                              _capturedPhoto = null;
                              _guidanceMessage = 'Center your face inside the oval';
                            });
                          },
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF16A34A),
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          icon: const Icon(Icons.check_circle_rounded),
                          label: const Text('Confirm', style: TextStyle(fontWeight: FontWeight.bold)),
                          onPressed: () {
                            Navigator.pop(context, _capturedPhoto);
                          },
                        ),
                      ),
                    ],
                  )
                : Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        GestureDetector(
                          onTap: _isCameraInitialized && !_isTakingPicture ? _capturePhoto : null,
                          child: Container(
                            width: 76,
                            height: 76,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: Colors.white.withValues(alpha: 0.2),
                              border: Border.all(color: Colors.white, width: 4),
                            ),
                            child: Center(
                              child: Container(
                                width: 60,
                                height: 60,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: _isTakingPicture ? Colors.grey : const Color(0xFF00E5FF),
                                ),
                                child: Icon(
                                  _isTakingPicture ? Icons.hourglass_top : Icons.camera_alt_rounded,
                                  color: Colors.black,
                                  size: 32,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 10),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.black.withValues(alpha: 0.6),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Text(
                            'Tap to Capture',
                            style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
