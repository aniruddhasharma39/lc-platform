import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'dart:io' as io;

class UploadEvidenceScreen extends StatefulWidget {
  final String token;
  final int masterId;
  final int? childDeviceId;
  final String category; // 'MASTER', 'DEVICE_1', 'DEVICE_2'
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

class _UploadEvidenceScreenState extends State<UploadEvidenceScreen> {
  XFile? _image;
  final ImagePicker _picker = ImagePicker();
  bool _isLoading = false;

  Future<void> _takePhoto() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 70);
    if (photo != null) {
      setState(() {
        _image = photo;
      });
    }
  }

  Future<void> _upload() async {
    if (_image == null) return;
    setState(() => _isLoading = true);

    try {
      // Get Location
      Position? position;
      try {
        bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
        if (serviceEnabled) {
          LocationPermission permission = await Geolocator.checkPermission();
          if (permission == LocationPermission.denied) {
            permission = await Geolocator.requestPermission();
          }
          if (permission == LocationPermission.always || permission == LocationPermission.whileInUse) {
            position = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
          }
        }
      } catch (e) {
        print('Could not fetch location: $e');
      }

      // Read image to base64
      final bytes = await _image!.readAsBytes();
      final base64Image = 'data:image/jpeg;base64,${base64Encode(bytes)}';

      // Send to backend
      final res = await http.post(
        Uri.parse('https://lc-platform.onrender.com/api/v1/evidence'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${widget.token}',
        },
        body: json.encode({
          'masterId': widget.masterId,
          'childDeviceId': widget.childDeviceId,
          'category': widget.category,
          'imageBase64': base64Image,
          'latitude': position?.latitude,
          'longitude': position?.longitude,
        }),
      );

      if (res.statusCode == 201) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Uploaded successfully!')));
        Navigator.pop(context, json.decode(res.body));
      } else {
        throw Exception(res.body);
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
      appBar: AppBar(title: Text('Upload Photo: ${widget.targetName}')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (_image != null) ...[
                kIsWeb ? Image.network(_image!.path, height: 300) : Image.file(io.File(_image!.path), height: 300),
                const SizedBox(height: 24),
              ],
              ElevatedButton.icon(
                icon: const Icon(Icons.camera_alt),
                label: const Text('Take Photo'),
                onPressed: _takePhoto,
                style: ElevatedButton.styleFrom(minimumSize: const Size(200, 50)),
              ),
              const SizedBox(height: 24),
              if (_image != null)
                ElevatedButton.icon(
                  icon: _isLoading ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.cloud_upload),
                  label: const Text('Upload Evidence'),
                  onPressed: _isLoading ? null : _upload,
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.green, minimumSize: const Size(200, 50)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
