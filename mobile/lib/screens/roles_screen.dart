import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../config.dart';
import '../main.dart';

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
      
      setState(() {
        _roles = json.decode(resRoles.body);
        _modules = json.decode(resMods.body);
      });
    } catch (e) {
      print(e);
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _deleteRole(int id) async {
    final token = await _getToken();
    try {
      final res = await http.delete(
        Uri.parse('$baseUrl/roles/$id'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        _fetchData();
      } else {
        final err = json.decode(res.body);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err['error'])));
      }
    } catch (e) {
      print(e);
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
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
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
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
                ElevatedButton(
                  onPressed: isSaving ? null : () async {
                    setDialogState(() => isSaving = true);
                    final messenger = ScaffoldMessenger.of(context);
                    final token = await _getToken();
                    final url = role == null 
                      ? '$baseUrl/roles' 
                      : '$baseUrl/roles/${role['id']}';
                    final method = role == null ? http.post : http.put;
                    
                    try {
                      final res = await method(
                        Uri.parse(url),
                        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
                        body: json.encode({'name': name, 'moduleIds': selectedModuleIds})
                      );
                      
                      if (res.statusCode == 200 || res.statusCode == 201) {
                        if (context.mounted) Navigator.pop(context);
                        messenger.showSnackBar(const SnackBar(
                          content: Text('Role successfully saved!', style: TextStyle(color: Colors.white)), 
                          backgroundColor: Colors.green
                        ));
                        _fetchData();
                      } else {
                        final err = json.decode(res.body);
                        messenger.showSnackBar(SnackBar(
                          content: Text(err['error'] ?? 'Unknown error'),
                          backgroundColor: Colors.red
                        ));
                      }
                    } catch (e) {
                      messenger.showSnackBar(const SnackBar(
                        content: Text('Network error. Please try again.'),
                        backgroundColor: Colors.red
                      ));
                    } finally {
                      if (context.mounted) setDialogState(() => isSaving = false);
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
              final mods = (r['roleModules'] as List).map((rm) => rm['module']['name']).join(', ');
              return Card(
                color: Colors.white,
                margin: const EdgeInsets.only(bottom: 16),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r['name'], style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                      const SizedBox(height: 8),
                      Text(mods.isEmpty ? 'No modules access' : mods, style: const TextStyle(color: Colors.grey)),
                      if (r['name'] != 'Developer') ...[
                        const SizedBox(height: 16),
                        Row(
                          children: [
                            OutlinedButton(onPressed: () => _showRoleDialog(role: r), child: const Text('Edit')),
                            const SizedBox(width: 8),
                            OutlinedButton(
                              style: OutlinedButton.styleFrom(foregroundColor: AppColors.danger, side: const BorderSide(color: AppColors.danger)),
                              onPressed: () => _deleteRole(r['id']), 
                              child: const Text('Delete')
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
