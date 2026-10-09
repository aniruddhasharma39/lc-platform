import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../config.dart';
import '../main.dart';
import 'roles_screen.dart';
import 'branding_screen.dart';
import 'registration_builder_screen.dart';

class DashboardScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final VoidCallback onLogout;
  const DashboardScreen({super.key, required this.user, required this.onLogout});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<dynamic> _users = [];
  List<dynamic> _roles = [];
  List<dynamic> _systemModules = [];
  bool _isLoading = false;
  String _currentView = 'home';

  @override
  void initState() {
    super.initState();
    if (widget.user['role'] == 'Developer') {
      _fetchData();
    }
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchData() async {
    setState(() => _isLoading = true);
    final token = await _getToken();
    try {
      var resUsers = await http.get(Uri.parse('$baseUrl/users'), headers: {'Authorization': 'Bearer $token'});
      var resRoles = await http.get(Uri.parse('$baseUrl/roles'), headers: {'Authorization': 'Bearer $token'});
      var resMods = await http.get(Uri.parse('$baseUrl/modules'), headers: {'Authorization': 'Bearer $token'});
      
      setState(() {
        final data = json.decode(resUsers.body);
        _users = data is Map && data['users'] != null ? data['users'] : [];
        _pendingRequests = data is Map && data['pendingRequests'] != null ? data['pendingRequests'] : [];
        
        final rolesData = json.decode(resRoles.body);
        _roles = rolesData is List ? rolesData : [];
        
        final modsData = json.decode(resMods.body);
        _systemModules = modsData is List ? modsData : [];
      });
    } catch (e) {
      print(e);
    } finally {
      setState(() => _isLoading = false);
    }
  }

  List<dynamic> _pendingRequests = [];

  Future<void> _actionUser(int id, String action, [Map<String, dynamic>? body, bool isRequest = false]) async {
    final token = await _getToken();
    final endpoint = isRequest ? 'request/$id/$action' : '$id/$action';
    try {
      await http.put(
        Uri.parse('http://10.0.2.2:5001/api/v1/users/$endpoint'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: body != null ? json.encode(body) : null
      ).catchError((_) => http.put(
        Uri.parse('$baseUrl/users/$endpoint'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: body != null ? json.encode(body) : null
      ));
      _fetchData();
    } catch (e) {
      print(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDev = widget.user['role'] == 'Developer';
    
    IconData getIconForModule(String slug) {
      switch (slug) {
        case 'manage-users': return Icons.group;
        case 'roles': return Icons.security;
        case 'branding': return Icons.brush;
        case 'registration': return Icons.build;
        case 'cluster': return Icons.device_hub;
        default: return Icons.extension;
      }
    }

    return Scaffold(
      appBar: AppBar(title: const Text('LC Platform'), backgroundColor: AppColors.surface),
      drawer: Drawer(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            DrawerHeader(
              decoration: const BoxDecoration(color: AppColors.surface),
              child: Row(
                children: [
                  CircleAvatar(backgroundColor: AppColors.secondary, child: Text(widget.user['fullName'].substring(0,2).toUpperCase(), style: const TextStyle(color: Colors.white))),
                  const SizedBox(width: 16),
                  Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.user['fullName'], style: const TextStyle(fontWeight: FontWeight.bold)),
                      Text(widget.user['role'], style: const TextStyle(color: Colors.grey, fontSize: 12)),
                    ],
                  )
                ],
              )
            ),
            ListTile(title: const Text('Home'), leading: const Icon(Icons.home), onTap: () {
              setState(() { _currentView = 'home'; });
              Navigator.pop(context);
            }),
            ..._systemModules.where((m) => (widget.user['allowedModules'] as List).contains(m['slug'])).map((m) {
              return ListTile(
                title: Text(m['name']),
                leading: Icon(getIconForModule(m['slug'])),
                onTap: () {
                  setState(() { _currentView = m['slug']; });
                  Navigator.pop(context);
                }
              );
            }).toList(),

            ListTile(title: const Text('Logout', style: TextStyle(color: AppColors.danger)), leading: const Icon(Icons.logout, color: AppColors.danger), onTap: widget.onLogout),
          ],
        )
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_currentView == 'home') return _buildUserDashboard();
    if (_currentView == 'manage-users') return _buildAdminDashboard();
    if (_currentView == 'roles') return RolesScreen(user: widget.user);
    if (_currentView == 'branding') return BrandingScreen(user: widget.user);
    if (_currentView == 'registration') return RegistrationBuilderScreen(user: widget.user);
    
    return Center(child: Text('Module $_currentView not implemented yet.'));
  }

  Widget _buildUserDashboard() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Text('Welcome to LC Platform', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          Text('You are logged in as ${widget.user['role']}', style: const TextStyle(color: Colors.grey)),
        ],
      )
    );
  }

  Widget _buildAdminDashboard() {
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          TabBar(
            labelColor: AppColors.primary,
            tabs: [
              const Tab(text: 'Existing Users'),
              Tab(text: 'Pending Approval (${_pendingRequests.length})'),
            ]
          ),
          Expanded(
            child: TabBarView(
              children: [
                _buildExistingUsersTab(),
                _buildPendingUsersTab(_pendingRequests),
              ]
            )
          )
        ],
      ),
    );
  }

  Widget _buildPendingUsersTab(List<dynamic> pending) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (pending.isEmpty) return const Center(child: Text('No pending requests.'));
    
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: pending.length,
      itemBuilder: (c, i) {
        final req = pending[i];
        final reqData = json.decode(req['data'] ?? '{}');
        int selectedRole = req['requestedRoleId'] ?? (_roles.isNotEmpty ? _roles[0]['id'] : 0);
        
        return Card(
          color: Colors.white,
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${reqData['fullName'] ?? 'Unknown'}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                Text('${reqData.entries.where((e) => e.key != 'password').map((e) => '${e.key}: ${e.value}').join(' | ')}', style: const TextStyle(color: Colors.grey)),
                const SizedBox(height: 8),
                Text('Requested Role ID: ${req['requestedRoleId']}', style: const TextStyle(fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                DropdownButtonFormField<int>(
                  value: selectedRole,
                  decoration: const InputDecoration(labelText: 'Assign Role'),
                  items: _roles.map((e) => DropdownMenuItem<int>(value: e['id'], child: Text(e['name']))).toList(),
                  onChanged: (v) => selectedRole = v!,
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: ElevatedButton(
                      style: ElevatedButton.styleFrom(backgroundColor: AppColors.success),
                      onPressed: () => _actionUser(req['id'], 'approve', {'roleId': selectedRole}, true),
                      child: const Text('Approve'),
                    )),
                    const SizedBox(width: 16),
                    Expanded(child: ElevatedButton(
                      style: ElevatedButton.styleFrom(backgroundColor: AppColors.danger),
                      onPressed: () => _actionUser(req['id'], 'reject', {'reason': 'Rejected by admin'}, true),
                      child: const Text('Reject'),
                    )),
                  ],
                )
              ],
            ),
          )
        );
      }
    );
  }

  Widget _buildExistingUsersTab() {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    
    final Map<String, List<dynamic>> grouped = {};
    for (var u in _users) {
      if (u['status'] == 'PENDING') continue;
      final rn = u['role']?['name'] ?? 'Unknown';
      if (!grouped.containsKey(rn)) grouped[rn] = [];
      grouped[rn]!.add(u);
    }
    
    return ListView(
      padding: const EdgeInsets.all(16),
      children: grouped.entries.map((e) {
        return ExpansionTile(
          title: Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: AppColors.secondary, borderRadius: BorderRadius.circular(16)),
                child: Text('${e.value.length}', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
              ),
              const SizedBox(width: 12),
              Text(e.key, style: const TextStyle(fontWeight: FontWeight.bold)),
            ],
          ),
          children: e.value.map((u) {
            return ListTile(
              title: Text(u['fullName']),
              subtitle: Text('${u['employeeId']} | ${u['department']}'),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(color: u['status'] == 'APPROVED' ? AppColors.success : Colors.grey, borderRadius: BorderRadius.circular(16)),
                    child: Text(u['status'], style: const TextStyle(color: Colors.white, fontSize: 10)),
                  ),
                  IconButton(
                    icon: Icon(u['status'] == 'DEACTIVATED' ? Icons.check_circle : Icons.block, color: u['status'] == 'DEACTIVATED' ? AppColors.success : AppColors.danger),
                    onPressed: () => _actionUser(u['id'], u['status'] == 'DEACTIVATED' ? 'reactivate' : 'deactivate'),
                  )
                ],
              )
            );
          }).toList(),
        );
      }).toList(),
    );
  }
}
