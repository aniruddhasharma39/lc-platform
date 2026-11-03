Future<void> saveAndOpenFilePlatform({
  required List<int> bytes,
  required String filename,
  required String mimeType,
}) async {
  throw UnsupportedError('Cannot download files on this platform');
}

