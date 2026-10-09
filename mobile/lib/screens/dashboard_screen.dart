import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../main.dart';

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
      final baseUrl = 'http://10.0.2.2:5001/api/v1';
      var resUsers = await http.get(Uri.parse('$baseUrl/users'), headers: {'Authorization': 'Bearer $token'}).catchError((_) => http.get(Uri.parse('http://localhost:5001/api/v1/users'), headers: {'Authorization': 'Bearer $token'}));
      var resRoles = await http.get(Uri.parse('$baseUrl/users/roles')).catchError((_) => http.get(Uri.parse('http://localhost:5001/api/v1/users/roles')));
      
      setState(() {
        _users = json.decode(resUsers.body);
        _roles = json.decode(resRoles.body);
      });
    } catch (e) {
      print(e);
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _actionUser(int id, String action, [Map<String, dynamic>? body]) async {
    final token = await _getToken();
    try {
      await http.put(
        Uri.parse('http://10.0.2.2:5001/api/v1/users/$id/$action'),
        headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
        body: body != null ? json.encode(body) : null
      ).catchError((_) => http.put(
        Uri.parse('http://localhost:5001/api/v1/users/$id/$action'),
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
            if (isDev)
              ListTile(title: const Text('Manage Users'), leading: const Icon(Icons.people), onTap: () {
                setState(() { _currentView = 'manageUsers'; });
                Navigator.pop(context);
              }),
            ListTile(title: const Text('Logout', style: TextStyle(color: AppColors.danger)), leading: const Icon(Icons.logout, color: AppColors.danger), onTap: widget.onLogout),
          ],
        )
      ),
      body: (isDev && _currentView == 'manageUsers') ? _buildAdminDashboard() : _buildUserDashboard(),
    );
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
    final pending = _users.where((u) => u['status'] == 'PENDING').toList();
    
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          TabBar(
            labelColor: AppColors.primary,
            tabs: [
              const Tab(text: 'Existing Users'),
              Tab(text: 'Pending Approval (${pending.length})'),
            ]
          ),
          Expanded(
            child: TabBarView(
              children: [
                _buildExistingUsersTab(),
                _buildPendingUsersTab(pending),
              ]
            )
          )
        ],
      ),
    );
  }

  Widget _buildPendingUsersTab(List<dynamic> pending) {
    if (_isLoading) return const Center(child: CircularProgressIndicator());
    if (pending.isEmpty) return const Center(child: Text('No pending users.'));
    
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: pending.length,
      itemBuilder: (c, i) {
        final u = pending[i];
        int selectedRole = u['requestedRoleId'];
        return Card(
          color: Colors.white,
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${u['fullName']} (${u['employeeId']})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                Text('${u['mobile']} | ${u['email']} | ${u['department']}', style: const TextStyle(color: Colors.grey)),
                const SizedBox(height: 8),
                Text('Requested Role: ${u['requestedRole']?['name']}', style: const TextStyle(fontWeight: FontWeight.bold)),
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
                      onPressed: () => _actionUser(u['id'], 'approve', {'roleId': selectedRole}),
                      child: const Text('Approve'),
                    )),
                    const SizedBox(width: 16),
                    Expanded(child: ElevatedButton(
                      style: ElevatedButton.styleFrom(backgroundColor: AppColors.danger),
                      onPressed: () => _actionUser(u['id'], 'reject', {'reason': 'Rejected by admin'}),
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
