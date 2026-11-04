import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

class RolesScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const RolesScreen({super.key, required this.user});

  @override
  State<RolesScreen> createState() => _RolesScreenState();
}

class _RolesScreenState extends State<RolesScreen> {
  List<dynamic> _roles = [];
  List<dynamic> _modules = [];
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _fetchData();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchData() async {
    setState(() => _isLoading = true);
    final token = await _getToken();
    try {
      var resRoles = await http.get(Uri.parse('$baseUrl/roles'), headers: {'Authorization': 'Bearer $token'});
      var resMods = await http.get(Uri.parse('$baseUrl/modules'), headers: {'Authorization': 'Bearer $token'});
      
      if (mounted) {
        setState(() {
          _roles = json.decode(resRoles.body);
          _modules = json.decode(resMods.body);
        });
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Failed to load roles and permissions: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  Future<void> _deleteRole(int id, String roleName) async {
    final token = await _getToken();
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/roles/$id'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        _fetchData();
        if (mounted) {
          AppFeedback.showSuccess(context, 'Role "$roleName" has been deleted successfully.');
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) {
          AppFeedback.showError(context, err['error'] ?? 'Failed to delete role.');
        }
      }
    } catch (e) {
      if (mounted) {
        AppFeedback.showError(context, 'Network error deleting role: $e');
      }
    }
  }

  void _showRoleDialog({Map<String, dynamic>? role}) {
    String name = role != null ? role['name'] : '';
    List<int> selectedModuleIds = role != null 
      ? (role['roleModules'] as List).map<int>((rm) => rm['moduleId'] as int).toList()
      : [];
      
    bool isSaving = false;

    showDialog(
      context: context,
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (stfCtx, setDialogState) {
            return AlertDialog(
              title: Text(role == null ? 'Create Role' : 'Edit Role'),
              content: SizedBox(
                width: double.maxFinite,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      decoration: const InputDecoration(labelText: 'Role Name'),
                      controller: TextEditingController(text: name)..selection = TextSelection.collapsed(offset: name.length),
                      onChanged: (val) => name = val,
                    ),
                    const SizedBox(height: 16),
                    const Text('Allowed Modules', style: TextStyle(fontWeight: FontWeight.bold)),
                    Expanded(
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: _modules.length,
                        itemBuilder: (c, i) {
                          final mod = _modules[i];
                          final isSelected = selectedModuleIds.contains(mod['id']);
                          return CheckboxListTile(
                            title: Text(mod['name']),
                            value: isSelected,
                            onChanged: (bool? val) {
                              setDialogState(() {
                                if (val == true) {
                                  if (!selectedModuleIds.contains(mod['id'])) {
                                    selectedModuleIds.add(mod['id']);
                                  }
                                } else {
                                  selectedModuleIds.remove(mod['id']);
                                }
                              });
                            }
                          );
                        }
                      )
                    )
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(dialogCtx), child: const Text('Cancel')),
                ElevatedButton(
                  onPressed: isSaving ? null : () async {
                    final trimmedName = name.trim();
                    if (trimmedName.isEmpty) {
                      AppFeedback.showWarning(context, 'Role name cannot be empty.');
                      return;
                    }

                    setDialogState(() => isSaving = true);
                    final token = await _getToken();
                    final url = role == null 
                      ? '$baseUrl/roles' 
                      : '$baseUrl/roles/${role['id']}';
                    final method = role == null ? http.post : http.put;
                    
                    try {
                      final res = await method(
                        Uri.parse(url),
                        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
                        body: json.encode({'name': trimmedName, 'moduleIds': selectedModuleIds})
                      );
                      
                      if (res.statusCode == 200 || res.statusCode == 201) {
                        if (dialogCtx.mounted) Navigator.pop(dialogCtx);
                        _fetchData();
                        if (!mounted) return;
                        if (role == null) {
                          AppFeedback.showSuccess(
                            context,
                            'Role "$trimmedName" created successfully with ${selectedModuleIds.length} module access!',
                          );
                        } else {
                          AppFeedback.showSuccess(
                            context,
                            'Role "$trimmedName" updated successfully.',
                          );
                        }
                      } else {
                        final err = json.decode(res.body);
                        if (!mounted) return;
                        AppFeedback.showError(
                          context,
                          err['error'] ?? 'Failed to save role.',
                        );
                      }
                    } catch (e) {
                      if (!mounted) return;
                      AppFeedback.showError(
                        context,
                        'Network error while saving role: $e',
                      );
                    } finally {
                      if (dialogCtx.mounted) setDialogState(() => isSaving = false);
                    }
                  }, 
                  child: isSaving 
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Save')
                )
              ],
            );
          }
        );
      }
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16.0),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Manage Roles', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary),
                onPressed: () => _showRoleDialog(),
                child: const Text('Create Role')
              )
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            itemCount: _roles.length,
            itemBuilder: (c, i) {
              final r = _roles[i];
              final isDev = r['name'] == 'Developer' || r['id'] == 1;
              final rawMods = (r['roleModules'] as List).map((rm) => rm['module']?['name']).where((n) => n != null).join(', ');
              final mods = isDev
                  ? 'All Modules: My Gates, Reports, Gate Management, Manage Users, Registration Builder, Roles, Branding, Scope Groups, Device Registry'
                  : (rawMods.isEmpty ? 'No modules access' : rawMods);
              return Card(
                color: Colors.white,
                margin: const EdgeInsets.only(bottom: 16),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(r['name'], style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                          if (isDev)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFFEFF6FF),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: const Color(0xFF93C5FD)),
                              ),
                              child: const Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.verified_user_rounded, size: 14, color: Color(0xFF1D4ED8)),
                                  SizedBox(width: 4),
                                  Text(
                                    'Full Master Access',
                                    style: TextStyle(
                                      color: Color(0xFF1D4ED8),
                                      fontSize: 11,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        mods,
                        style: TextStyle(
                          color: isDev ? const Color(0xFF1E3A8A) : Colors.grey.shade700,
                          fontSize: 13,
                          height: 1.35,
                        ),
                      ),
                      if (r['name'] != 'Developer') ...[
                        const SizedBox(height: 16),
                        Row(
                          children: [
                            OutlinedButton(onPressed: () => _showRoleDialog(role: r), child: const Text('Edit')),
                            const SizedBox(width: 8),
                            OutlinedButton(
                              style: OutlinedButton.styleFrom(
                                foregroundColor: AppColors.danger,
                                side: const BorderSide(color: AppColors.danger),
                              ),
                              onPressed: () async {
                                final roleName = (r['name'] ?? 'Role').toString();
                                final confirm = await showDialog<bool>(
                                  context: context,
                                  builder: (ctx) => AlertDialog(
                                    title: Text('Delete Role "$roleName"?'),
                                    content: const Text(
                                      'Are you sure you want to delete this role? Any users currently assigned to this role will lose their assigned module access.',
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () => Navigator.pop(ctx, false),
                                        child: const Text('Cancel'),
                                      ),
                                      ElevatedButton(
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: AppColors.danger,
                                          foregroundColor: Colors.white,
                                        ),
                                        onPressed: () => Navigator.pop(ctx, true),
                                        child: const Text('Delete Role'),
                                      ),
                                    ],
                                  ),
                                );
                                if (confirm == true) {
                                  _deleteRole(r['id'], roleName);
                                }
                              }, 
                              child: const Text('Delete'),
                            ),
                          ],
                        )
                      ]
                    ],
                  ),
                )
              );
            }
          )
        )
      ],
    );
  }
}
