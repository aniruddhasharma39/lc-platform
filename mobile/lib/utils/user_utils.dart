import 'package:shared_preferences/shared_preferences.dart';

/// Resolves the canonical per-user cache identifier consistently across all
/// mobile screens and cache services (`home`, `lc_gates`, `reports`).
///
/// Prioritizes numeric DB `user['id']`, then persisted `'userId'` in
/// [SharedPreferences], and only falls back to `'employeeId'` / `'username'`
/// if no primary user ID exists.
String resolveCurrentUserId({
  Map<String, dynamic>? user,
  SharedPreferences? prefs,
}) {
  final mapId = user?['id']?.toString().trim();
  if (mapId != null && mapId.isNotEmpty && mapId != 'null') {
    return mapId;
  }

  final prefUserId = prefs?.getString('userId')?.trim();
  if (prefUserId != null && prefUserId.isNotEmpty && prefUserId != 'null') {
    return prefUserId;
  }

  final fallback = (user?['employeeId'] ??
          user?['username'] ??
          prefs?.getString('employeeId'))
      ?.toString()
      .trim();
  if (fallback != null && fallback.isNotEmpty && fallback != 'null') {
    return fallback;
  }

  return 'user';
}

/// Async helper to resolve canonical user ID via [SharedPreferences] when
/// [SharedPreferences] is not already in scope.
Future<String> loadCurrentUserId([Map<String, dynamic>? user]) async {
  final mapId = user?['id']?.toString().trim();
  if (mapId != null && mapId.isNotEmpty && mapId != 'null') {
    return mapId;
  }
  try {
    final prefs = await SharedPreferences.getInstance();
    return resolveCurrentUserId(user: user, prefs: prefs);
  } catch (_) {
    return resolveCurrentUserId(user: user);
  }
}

/// Persists canonical user ID keys into [SharedPreferences] on login or
/// `/auth/me` session hydration so secondary screens without `widget.user`
/// share the exact same cache namespace.
Future<void> persistUserSessionPrefs(
  SharedPreferences prefs,
  Map<String, dynamic> user,
) async {
  final id = user['id']?.toString().trim();
  if (id != null && id.isNotEmpty && id != 'null') {
    await prefs.setString('userId', id);
  }
  final empId = user['employeeId']?.toString().trim();
  if (empId != null && empId.isNotEmpty && empId != 'null') {
    await prefs.setString('employeeId', empId);
  }
}

/// Removes persisted identity keys on logout or session expiry.
Future<void> clearUserSessionPrefs(SharedPreferences prefs) async {
  await prefs.remove('userId');
  await prefs.remove('employeeId');
}

