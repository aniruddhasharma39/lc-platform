import 'file_download_stub.dart'
    if (dart.library.html) 'file_download_web.dart'
    if (dart.library.io) 'file_download_io.dart';

Future<void> downloadFileUniversal({
  required List<int> bytes,
  required String filename,
  required String mimeType,
}) =>
    saveAndOpenFilePlatform(bytes: bytes, filename: filename, mimeType: mimeType);
