import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../../config.dart';
import '../../main.dart';
import '../../utils/app_feedback.dart';
import '../cluster/railway_data.dart';
import 'scope_groups_screen.dart';

const List<String> kColorPresets = [
  '#0B3C7A', // Navy
  '#0E9AA7', // Teal
  '#6366F1', // Indigo
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#0284C7', // Sky Blue
];

class CreateEditScopeGroupScreen extends StatefulWidget {
  final Map<String, dynamic>? group;
  final String token;
  final int? preselectedParentId;
  final List<dynamic>? existingScopeGroups;

  const CreateEditScopeGroupScreen({
    super.key,
    this.group,
    required this.token,
    this.preselectedParentId,
    this.existingScopeGroups,
  });

  @override
  State<CreateEditScopeGroupScreen> createState() => _CreateEditScopeGroupScreenState();
}

class _CreateEditScopeGroupScreenState extends State<CreateEditScopeGroupScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  final _formKey = GlobalKey<FormState>();

  final _nameController = TextEditingController();
  final _descController = TextEditingController();
  final _subGroupNameCtrl = TextEditingController();

  int? _selectedParentId;
  String _selectedColor = '#0B3C7A';

  final List<String> _queuedSubGroupNames = [];
  final Set<int> _selectedGateIds = {};
  final Set<int> _selectedUserIds = {};

  List<dynamic> _allGates = [];
  List<dynamic> _allUsers = [];
  List<dynamic> _allScopeGroups = [];

  bool _isLoadingData = true;
  bool _isSaving = false;
  String? _errorMessage;

  // Gate filters
  final _gateSearchCtrl = TextEditingController();
  String _gateSearchQuery = '';
  String _gateFilterZone = '';
  String _gateFilterDivision = '';

  // User filters
  final _userSearchCtrl = TextEditingController();
  String _userSearchQuery = '';
  String _userFilterRole = 'ALL';

  bool get _isEdit => widget.group != null;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);

    if (_isEdit) {
      final g = widget.group!;
      _nameController.text = g['name'] ?? '';
      _descController.text = g['description'] ?? '';
      _selectedColor = g['color'] ?? '#0B3C7A';
      _selectedParentId = g['parentId'] as int?;

      final gatesList = (g['gates'] as List?) ?? [];
      for (final item in gatesList) {
        final gid = item['gate']?['id'] ?? item['gateId'] ?? item['id'];
        if (gid is int) _selectedGateIds.add(gid);
      }

      final usersList = (g['users'] as List?) ?? [];
      for (final item in usersList) {
        final uid = item['user']?['id'] ?? item['userId'] ?? item['id'];
        if (uid is int) _selectedUserIds.add(uid);
      }
    } else {
      _selectedParentId = widget.preselectedParentId;
    }

    if (widget.existingScopeGroups != null) {
      _allScopeGroups = widget.existingScopeGroups!;
    }

    _fetchInitialData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _nameController.dispose();
    _descController.dispose();
    _subGroupNameCtrl.dispose();
    _gateSearchCtrl.dispose();
    _userSearchCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchInitialData() async {
    setState(() => _isLoadingData = true);
    try {
      final gateResFuture = http.get(
        Uri.parse('$baseUrl/lcgate'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      final userResFuture = http.get(
        Uri.parse('$baseUrl/users'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      final groupsResFuture = http.get(
        Uri.parse('$baseUrl/scope-groups'),
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );

      final responses = await Future.wait([gateResFuture, userResFuture, groupsResFuture]);

      if (responses[0].statusCode == 200) {
        final gateData = json.decode(responses[0].body);
        _allGates = gateData is List ? gateData : [];
      }

      if (responses[1].statusCode == 200) {
        final userData = json.decode(responses[1].body);
        if (userData is Map<String, dynamic> && userData['users'] is List) {
          _allUsers = userData['users'];
        } else if (userData is List) {
          _allUsers = userData;
        }
      }

      if (responses[2].statusCode == 200) {
        final groupsData = json.decode(responses[2].body);
        if (groupsData is List) {
          _allScopeGroups = groupsData;
        }
      }
    } catch (e) {
      _errorMessage = 'Failed to load scope options: $e';
      if (mounted) {
        AppFeedback.showError(context, 'Failed to load scope configuration data: $e');
      }
    } finally {
      if (mounted) {
        setState(() => _isLoadingData = false);
      }
    }
  }

  // Prevent circular hierarchy references: group cannot be parent of itself or of its descendants
  Set<int> _getDescendantIds(int rootId) {
    final result = <int>{rootId};
    final queue = [rootId];
    while (queue.isNotEmpty) {
      final curr = queue.removeAt(0);
      for (final g in _allScopeGroups) {
        if (g['parentId'] == curr) {
          final cid = g['id'] as int?;
          if (cid != null && !result.contains(cid)) {
            result.add(cid);
            queue.add(cid);
          }
        }
      }
    }
    return result;
  }

  List<dynamic> get _availableParentGroups {
    if (!_isEdit || widget.group == null || widget.group!['id'] == null) {
      return _allScopeGroups;
    }
    final forbiddenIds = _getDescendantIds(widget.group!['id'] as int);
    return _allScopeGroups.where((g) => !forbiddenIds.contains(g['id'])).toList();
  }

  Map<String, dynamic>? get _parentGroupDetails {
    if (_selectedParentId == null) return null;
    return _allScopeGroups.firstWhere(
      (g) => g['id'] == _selectedParentId,
      orElse: () => null,
    );
  }

  List<dynamic> get _existingChildSubGroups {
    if (!_isEdit || widget.group == null) return [];
    final currentId = widget.group!['id'];
    return _allScopeGroups.where((g) => g['parentId'] == currentId).toList();
  }

  void _handleAddSubGroup() {
    final trimmed = _subGroupNameCtrl.text.trim();
    if (trimmed.isEmpty) return;

    if (_queuedSubGroupNames.any((s) => s.toLowerCase() == trimmed.toLowerCase())) {
      AppFeedback.showWarning(context, '"$trimmed" is already in the queued list.');
      return;
    }

    if (_nameController.text.trim().isNotEmpty &&
        _nameController.text.trim().toLowerCase() == trimmed.toLowerCase()) {
      AppFeedback.showWarning(context, 'A sub-group cannot have the exact same name as its parent group.');
      return;
    }

    setState(() {
      _queuedSubGroupNames.add(trimmed);
      _subGroupNameCtrl.clear();
    });
  }

  void _handleRemoveSubGroup(int index) {
    setState(() {
      _queuedSubGroupNames.removeAt(index);
    });
  }

  Future<void> _handleSave() async {
    if (!_formKey.currentState!.validate()) {
      _tabController.animateTo(0);
      AppFeedback.showWarning(context, 'Please enter a valid scope group name.');
      return;
    }

    setState(() {
      _isSaving = true;
      _errorMessage = null;
    });

    final groupName = _nameController.text.trim();
    final payload = {
      'name': groupName,
      'description': _descController.text.trim().isEmpty ? null : _descController.text.trim(),
      'color': _selectedColor,
      'parentId': _selectedParentId,
      'gateIds': _selectedGateIds.toList(),
      'userIds': _selectedUserIds.toList(),
      'subGroupNames': _queuedSubGroupNames,
    };

    try {
      final url = _isEdit
          ? '$baseUrl/scope-groups/${widget.group!['id']}'
          : '$baseUrl/scope-groups';

      final headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ${widget.token}',
      };

      final response = _isEdit
          ? await http.put(Uri.parse(url), headers: headers, body: json.encode(payload))
          : await http.post(Uri.parse(url), headers: headers, body: json.encode(payload));

      if (response.statusCode == 200 || response.statusCode == 201) {
        if (!mounted) return;
        final actionWord = _isEdit ? 'updated' : 'created';
        final subCount = _queuedSubGroupNames.length;
        final gateCount = _selectedGateIds.length;
        final userCount = _selectedUserIds.length;

        String msg = 'Scope group "$groupName" $actionWord';
        if (subCount > 0) msg += ' with $subCount sub-groups';
        msg += ' ($gateCount gates, $userCount users).';

        AppFeedback.showSuccess(context, msg);
        Navigator.pop(context, true);
      } else {
        String err = 'Failed to save scope group (${response.statusCode})';
        try {
          final data = json.decode(response.body);
          if (data['error'] != null) {
            err = data['error'];
          } else if (data['message'] != null) {
            err = data['message'];
          }
        } catch (_) {}
        if (mounted) {
          setState(() {
            _errorMessage = err;
            _isSaving = false;
          });
          AppFeedback.showError(context, err);
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _errorMessage = 'Network error: $e';
          _isSaving = false;
        });
        AppFeedback.showError(context, 'Network error saving scope group: $e');
      }
    }
  }

  // Gates Filtering
  List<dynamic> get _filteredGates {
    return _allGates.where((g) {
      if (_gateFilterZone.isNotEmpty && (g['zone'] ?? '') != _gateFilterZone) {
        return false;
      }
      if (_gateFilterDivision.isNotEmpty && (g['division'] ?? '') != _gateFilterDivision) {
        return false;
      }
      if (_gateSearchQuery.isNotEmpty) {
        final q = _gateSearchQuery.toLowerCase();
        final lc = (g['lcNumber'] ?? '').toString().toLowerCase();
        final loc = (g['locationName'] ?? '').toString().toLowerCase();
        final name = (g['name'] ?? '').toString().toLowerCase();
        final div = (g['division'] ?? '').toString().toLowerCase();
        return lc.contains(q) || loc.contains(q) || name.contains(q) || div.contains(q);
      }
      return true;
    }).toList();
  }

  // Users Filtering
  List<dynamic> get _filteredUsers {
    return _allUsers.where((u) {
      if (_userFilterRole != 'ALL') {
        final roleName = (u['role'] is Map ? u['role']['name'] : u['role']?.toString()) ?? '';
        if (roleName != _userFilterRole) return false;
      }
      if (_userSearchQuery.isNotEmpty) {
        final q = _userSearchQuery.toLowerCase();
        final name = (u['fullName'] ?? '').toString().toLowerCase();
        final email = (u['email'] ?? '').toString().toLowerCase();
        final emp = (u['employeeId'] ?? '').toString().toLowerCase();
        final dept = (u['department'] ?? '').toString().toLowerCase();
        return name.contains(q) || email.contains(q) || emp.contains(q) || dept.contains(q);
      }
      return true;
    }).toList();
  }

  List<String> get _userRolesList {
    final set = <String>{};
    for (final u in _allUsers) {
      final roleName = (u['role'] is Map ? u['role']['name'] : u['role']?.toString()) ?? '';
      if (roleName.isNotEmpty) set.add(roleName);
    }
    return set.toList()..sort();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _isEdit
              ? 'Edit Scope Group'
              : (_selectedParentId != null ? 'New Sub-Group' : 'New Scope Group'),
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
        ),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 1,
        bottom: TabBar(
          controller: _tabController,
          labelColor: AppColors.primary,
          unselectedLabelColor: Colors.grey.shade600,
          indicatorColor: AppColors.primary,
          indicatorWeight: 3,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [
            const Tab(icon: Icon(Icons.tune, size: 18), text: '1. Details'),
            Tab(
              icon: const Icon(Icons.create_new_folder_outlined, size: 18),
              text: '2. Sub-Groups${_queuedSubGroupNames.isNotEmpty ? " (${_queuedSubGroupNames.length})" : ""}',
            ),
            Tab(
              icon: const Icon(Icons.device_hub, size: 18),
              text: '3. Gates${_selectedGateIds.isNotEmpty ? " (${_selectedGateIds.length})" : ""}',
            ),
            Tab(
              icon: const Icon(Icons.people_outline, size: 18),
              text: '4. Users${_selectedUserIds.isNotEmpty ? " (${_selectedUserIds.length})" : ""}',
            ),
          ],
        ),
      ),
      body: _isLoadingData
          ? const Center(child: CircularProgressIndicator())
          : Form(
              key: _formKey,
              child: TabBarView(
                controller: _tabController,
                children: [
                  _buildDetailsTab(),
                  _buildSubGroupsTab(),
                  _buildGatesTab(),
                  _buildUsersTab(),
                ],
              ),
            ),
      bottomNavigationBar: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.05),
              blurRadius: 8,
              offset: const Offset(0, -2),
            ),
          ],
        ),
        child: SafeArea(
          child: ElevatedButton(
            onPressed: _isSaving ? null : _handleSave,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            child: _isSaving
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(_isEdit ? Icons.save : Icons.add_circle_outline, size: 20),
                      const SizedBox(width: 8),
                      Text(
                        _isEdit ? 'Save Changes' : 'Create Scope Group',
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }

  // TAB 1: DETAILS
  Widget _buildDetailsTab() {
    final parentGroup = _parentGroupDetails;
    final availableParents = _availableParentGroups;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (_errorMessage != null) ...[
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.red.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.red.shade200),
            ),
            child: Row(
              children: [
                Icon(Icons.error_outline, color: Colors.red.shade700, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _errorMessage!,
                    style: TextStyle(color: Colors.red.shade900, fontSize: 13),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],

        // Preselected parent notification pill
        if (parentGroup != null)
          Container(
            margin: const EdgeInsets.only(bottom: 16),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0xFFF5F3FF),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFFDDD6FE)),
            ),
            child: Row(
              children: [
                const Icon(Icons.folder_shared, color: Color(0xFF7C3AED), size: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Creating inside parent: "${parentGroup['name']}"',
                    style: const TextStyle(
                      color: Color(0xFF6D28D9),
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),

        // Scope Group Name
        const Text(
          'Scope Group Name *',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
        ),
        const SizedBox(height: 6),
        TextFormField(
          controller: _nameController,
          decoration: const InputDecoration(
            hintText: 'e.g. Western Railway, Ahmedabad Division, Section A...',
            prefixIcon: Icon(Icons.layers_outlined, size: 20),
          ),
          validator: (val) {
            if (val == null || val.trim().isEmpty) {
              return 'Scope Group Name is required';
            }
            return null;
          },
        ),
        const SizedBox(height: 18),

        // Parent Scope Group (Folder / Hierarchy Level)
        const Text(
          'Parent Scope Group (Folder / Hierarchy Level)',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
        ),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: Colors.grey.shade300),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<int?>(
              value: _selectedParentId,
              isExpanded: true,
              icon: const Icon(Icons.keyboard_arrow_down),
              items: [
                const DropdownMenuItem<int?>(
                  value: null,
                  child: Row(
                    children: [
                      Icon(Icons.folder_outlined, color: AppColors.primary, size: 20),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'None (Root Scope Group / Zone Level)',
                          style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Color(0xFF0F172A)),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                ...availableParents.map((g) {
                  final gid = g['id'] as int;
                  final parentObj = g['parent'];
                  final prefix = parentObj != null ? '${parentObj['name']} / ' : '';
                  final displayName = '$prefix${g['name']}';
                  final gColor = parseHexColor(g['color']);

                  return DropdownMenuItem<int?>(
                    value: gid,
                    child: Row(
                      children: [
                        Icon(Icons.folder, color: gColor, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            displayName,
                            style: const TextStyle(fontSize: 13.5, color: Color(0xFF1E293B)),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
              onChanged: (val) {
                setState(() => _selectedParentId = val);
              },
            ),
          ),
        ),
        const SizedBox(height: 5),
        Text(
          'Nest this group inside another folder (e.g. Western Railway → Ahmedabad Division). Users assigned to the parent group automatically inherit access to this sub-group.',
          style: TextStyle(fontSize: 12, color: Colors.grey.shade600, height: 1.3),
        ),
        const SizedBox(height: 18),

        // Description
        const Text(
          'Description (Optional)',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
        ),
        const SizedBox(height: 6),
        TextFormField(
          controller: _descController,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: 'Add an operational summary, area or purpose for this scope group...',
            alignLabelWithHint: true,
          ),
        ),
        const SizedBox(height: 20),

        // Color Swatches
        const Text(
          'Badge & Accent Color',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: kColorPresets.map((hex) {
            final color = parseHexColor(hex);
            final isSelected = _selectedColor.toUpperCase() == hex.toUpperCase();
            return GestureDetector(
              onTap: () => setState(() => _selectedColor = hex),
              child: Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: isSelected ? const Color(0xFF0F172A) : Colors.transparent,
                    width: 3,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: color.withValues(alpha: 0.35),
                      blurRadius: 6,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: isSelected
                    ? const Icon(Icons.check, color: Colors.white, size: 22)
                    : null,
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 24),

        // Overview Summary Card
        Card(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: Colors.grey.shade200),
          ),
          elevation: 1,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Scope Group Configuration Overview',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF5F3FF),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Column(
                          children: [
                            Text(
                              '${_queuedSubGroupNames.length + _existingChildSubGroups.length}',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF6D28D9)),
                            ),
                            const Text('Sub-Groups', style: TextStyle(fontSize: 11, color: Color(0xFF6D28D9))),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE0F2FE),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Column(
                          children: [
                            Text(
                              '${_selectedGateIds.length}',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF0369A1)),
                            ),
                            const Text('Gates Picked', style: TextStyle(fontSize: 11, color: Color(0xFF0369A1))),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: const Color(0xFFECFDF5),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Column(
                          children: [
                            Text(
                              '${_selectedUserIds.length}',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF065F46)),
                            ),
                            const Text('Users Assigned', style: TextStyle(fontSize: 11, color: Color(0xFF065F46))),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'Switch to the Sub-Groups, Gates, or Users tabs above to configure child divisions and direct cluster access.',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // TAB 2: SUB-GROUPS (Subgroup creation mirroring the web application)
  Widget _buildSubGroupsTab() {
    final existingSubs = _existingChildSubGroups;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Helper banner
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: const Color(0xFFF8FAFC),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                children: [
                  Icon(Icons.create_new_folder, color: AppColors.primary, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Create Sub-Groups Simultaneously',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Define child divisions or sub-folders now (e.g. Ahmedabad Division, Mumbai Division, Section 1). You can create a parent group and its sub-groups at the exact same time without needing to assign clusters immediately.',
                style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600, height: 1.4),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _subGroupNameCtrl,
                      decoration: InputDecoration(
                        hintText: 'Enter sub-group name...',
                        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide(color: Colors.grey.shade300),
                        ),
                        filled: true,
                        fillColor: Colors.white,
                      ),
                      onSubmitted: (_) => _handleAddSubGroup(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton.icon(
                    onPressed: _handleAddSubGroup,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Add Sub-Group', style: TextStyle(fontWeight: FontWeight.bold)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),

        // Header for queued sub-groups
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Sub-Groups Queued for Creation (${_queuedSubGroupNames.length})',
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 14,
                color: Color(0xFF0F172A),
              ),
            ),
            if (_queuedSubGroupNames.isNotEmpty)
              TextButton(
                onPressed: () => setState(() => _queuedSubGroupNames.clear()),
                child: const Text('Clear All', style: TextStyle(fontSize: 12, color: Colors.red)),
              ),
          ],
        ),
        const SizedBox(height: 8),

        if (_queuedSubGroupNames.isEmpty)
          Container(
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Colors.grey.shade300, style: BorderStyle.solid),
            ),
            alignment: Alignment.center,
            child: Column(
              children: [
                Icon(Icons.folder_open_outlined, size: 36, color: Colors.grey.shade400),
                const SizedBox(height: 8),
                Text(
                  'No sub-groups added to queue yet.',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5, color: Colors.grey.shade700),
                ),
                const SizedBox(height: 4),
                Text(
                  'Type a sub-group name above and tap "Add Sub-Group".',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
                ),
              ],
            ),
          )
        else
          ..._queuedSubGroupNames.asMap().entries.map((entry) {
            final idx = entry.key;
            final name = entry.value;
            final parentName = _nameController.text.trim().isNotEmpty
                ? _nameController.text.trim()
                : 'this parent group';

            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              elevation: 0.5,
              child: ListTile(
                leading: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: const Color(0xFFEDE9FE),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.folder, color: Color(0xFF6D28D9), size: 20),
                ),
                title: Text(name, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                subtitle: Text(
                  'Will be created as child folder in "$parentName"',
                  style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600),
                ),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline, color: Colors.red, size: 20),
                  onPressed: () => _handleRemoveSubGroup(idx),
                ),
              ),
            );
          }),

        // If editing, display existing sub-divisions of this group
        if (_isEdit && existingSubs.isNotEmpty) ...[
          const SizedBox(height: 24),
          Row(
            children: [
              const Icon(Icons.folder_copy, color: Color(0xFF6D28D9), size: 18),
              const SizedBox(width: 6),
              Text(
                'Existing Sub-Divisions (${existingSubs.length})',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                  color: Color(0xFF0F172A),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ...existingSubs.map((child) {
            final childGates = (child['gates'] as List?) ?? [];
            final childColor = parseHexColor(child['color']);

            return Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFFF1F5F9),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: Row(
                children: [
                  Icon(Icons.folder, color: childColor, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      child['name'] ?? 'Sub-Group',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5, color: Color(0xFF1E293B)),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: const Color(0xFFE0F2FE),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '${childGates.length} Gates',
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF0369A1)),
                    ),
                  ),
                ],
              ),
            );
          }),
        ],
      ],
    );
  }

  // TAB 3: GATES PICKER
  Widget _buildGatesTab() {
    final filtered = _filteredGates;
    final divisions = RailwayData.divisionsForZone(_gateFilterZone);

    return Column(
      children: [
        // Filter & Search bar
        Container(
          padding: const EdgeInsets.all(12),
          color: Colors.grey.shade50,
          child: Column(
            children: [
              TextField(
                controller: _gateSearchCtrl,
                decoration: InputDecoration(
                  hintText: 'Search gates by LC#, location, zone...',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  suffixIcon: _gateSearchQuery.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () {
                            _gateSearchCtrl.clear();
                            setState(() => _gateSearchQuery = '');
                          },
                        )
                      : null,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: Colors.grey.shade300)),
                ),
                onChanged: (val) => setState(() => _gateSearchQuery = val),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  // Zone Filter Dropdown
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.grey.shade300),
                      ),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          value: _gateFilterZone.isEmpty ? null : _gateFilterZone,
                          hint: const Text('All Railway Zones', style: TextStyle(fontSize: 12.5)),
                          isExpanded: true,
                          items: [
                            const DropdownMenuItem(value: '', child: Text('All Zones', style: TextStyle(fontSize: 12.5))),
                            ...RailwayData.zones.map(
                              (z) => DropdownMenuItem(value: z, child: Text(z, style: const TextStyle(fontSize: 12.5), overflow: TextOverflow.ellipsis)),
                            ),
                          ],
                          onChanged: (val) => setState(() {
                            _gateFilterZone = val ?? '';
                            _gateFilterDivision = '';
                          }),
                        ),
                      ),
                    ),
                  ),
                  if (divisions.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    // Division Filter Dropdown
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: Colors.grey.shade300),
                        ),
                        child: DropdownButtonHideUnderline(
                          child: DropdownButton<String>(
                            value: _gateFilterDivision.isEmpty ? null : _gateFilterDivision,
                            hint: const Text('All Divisions', style: TextStyle(fontSize: 12.5)),
                            isExpanded: true,
                            items: [
                              const DropdownMenuItem(value: '', child: Text('All Divisions', style: TextStyle(fontSize: 12.5))),
                              ...divisions.map(
                                (d) => DropdownMenuItem(value: d, child: Text(d, style: const TextStyle(fontSize: 12.5), overflow: TextOverflow.ellipsis)),
                              ),
                            ],
                            onChanged: (val) => setState(() => _gateFilterDivision = val ?? ''),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: filtered.isEmpty
                        ? null
                        : () {
                            setState(() {
                              for (final g in filtered) {
                                if (g['id'] is int) _selectedGateIds.add(g['id']);
                              }
                            });
                            AppFeedback.showInfo(context, 'Selected ${filtered.length} matching gates.');
                          },
                    child: const Text('Select All Filtered', style: TextStyle(fontSize: 12)),
                  ),
                  TextButton(
                    onPressed: filtered.isEmpty
                        ? null
                        : () {
                            setState(() {
                              for (final g in filtered) {
                                if (g['id'] is int) _selectedGateIds.remove(g['id']);
                              }
                            });
                            AppFeedback.showInfo(context, 'Cleared gate selections.');
                          },
                    child: const Text('Clear', style: TextStyle(fontSize: 12, color: Colors.grey)),
                  ),
                ],
              ),
            ],
          ),
        ),

        // Count Banner
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          color: const Color(0xFFF1F5F9),
          child: Row(
            children: [
              Text(
                'Showing ${filtered.length} of ${_allGates.length} gates',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF475569)),
              ),
              const Spacer(),
              Text(
                '${_selectedGateIds.length} Selected',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary),
              ),
            ],
          ),
        ),

        // Gates List
        Expanded(
          child: filtered.isEmpty
              ? Center(
                  child: Text(
                    _gateSearchQuery.isNotEmpty || _gateFilterZone.isNotEmpty
                        ? 'No gates match your filters.'
                        : 'No LC Gates available.',
                    style: TextStyle(color: Colors.grey.shade500),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: filtered.length,
                  separatorBuilder: (context, index) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final gate = filtered[index];
                    final gid = gate['id'] as int?;
                    if (gid == null) return const SizedBox.shrink();

                    final isSelected = _selectedGateIds.contains(gid);
                    final masters = (gate['masters'] as List?) ?? [];

                    return CheckboxListTile(
                      value: isSelected,
                      activeColor: AppColors.primary,
                      onChanged: (bool? val) {
                        setState(() {
                          if (val == true) {
                            _selectedGateIds.add(gid);
                          } else {
                            _selectedGateIds.remove(gid);
                          }
                        });
                      },
                      title: Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFFE0F2FE),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              gate['lcNumber'] ?? 'LC-Gate',
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF0369A1),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              gate['locationName'] ?? gate['name'] ?? 'Gate $gid',
                              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '${gate['zone'] ?? ''} • ${gate['division'] ?? ''}  (${masters.length} Masters)',
                          style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  // TAB 4: USERS PICKER
  Widget _buildUsersTab() {
    final filtered = _filteredUsers;
    final roles = _userRolesList;

    return Column(
      children: [
        // Filter & Search bar
        Container(
          padding: const EdgeInsets.all(12),
          color: Colors.grey.shade50,
          child: Column(
            children: [
              TextField(
                controller: _userSearchCtrl,
                decoration: InputDecoration(
                  hintText: 'Search users by name, email, department...',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  suffixIcon: _userSearchQuery.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () {
                            _userSearchCtrl.clear();
                            setState(() => _userSearchQuery = '');
                          },
                        )
                      : null,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide(color: Colors.grey.shade300)),
                ),
                onChanged: (val) => setState(() => _userSearchQuery = val),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  // Role Filter Dropdown
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.grey.shade300),
                      ),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          value: _userFilterRole,
                          isExpanded: true,
                          items: [
                            const DropdownMenuItem(value: 'ALL', child: Text('All Roles', style: TextStyle(fontSize: 12.5))),
                            ...roles.map(
                              (r) => DropdownMenuItem(value: r, child: Text(r, style: const TextStyle(fontSize: 12.5), overflow: TextOverflow.ellipsis)),
                            ),
                          ],
                          onChanged: (val) => setState(() => _userFilterRole = val ?? 'ALL'),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Select All / Clear
                  TextButton(
                    onPressed: filtered.isEmpty
                        ? null
                        : () {
                            setState(() {
                              for (final u in filtered) {
                                if (u['id'] is int) _selectedUserIds.add(u['id']);
                              }
                            });
                            AppFeedback.showInfo(context, 'Selected ${filtered.length} matching users.');
                          },
                    child: const Text('Select All', style: TextStyle(fontSize: 12)),
                  ),
                  TextButton(
                    onPressed: filtered.isEmpty
                        ? null
                        : () {
                            setState(() {
                              for (final u in filtered) {
                                if (u['id'] is int) _selectedUserIds.remove(u['id']);
                              }
                            });
                            AppFeedback.showInfo(context, 'Cleared user selections.');
                          },
                    child: const Text('Clear', style: TextStyle(fontSize: 12, color: Colors.grey)),
                  ),
                ],
              ),
            ],
          ),
        ),

        // Count Banner
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          color: const Color(0xFFF1F5F9),
          child: Row(
            children: [
              Text(
                'Showing ${filtered.length} of ${_allUsers.length} users',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF475569)),
              ),
              const Spacer(),
              Text(
                '${_selectedUserIds.length} Selected',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.primary),
              ),
            ],
          ),
        ),

        // Users List
        Expanded(
          child: filtered.isEmpty
              ? Center(
                  child: Text(
                    _userSearchQuery.isNotEmpty || _userFilterRole != 'ALL'
                        ? 'No users match your filters.'
                        : 'No users found.',
                    style: TextStyle(color: Colors.grey.shade500),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: filtered.length,
                  separatorBuilder: (context, index) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final user = filtered[index];
                    final uid = user['id'] as int?;
                    if (uid == null) return const SizedBox.shrink();

                    final isSelected = _selectedUserIds.contains(uid);
                    final roleName = (user['role'] is Map ? user['role']['name'] : user['role']?.toString()) ?? '';
                    final fullName = user['fullName'] ?? 'User #$uid';
                    final email = user['email'] ?? '';
                    final dept = user['department'] ?? '';

                    return CheckboxListTile(
                      value: isSelected,
                      activeColor: AppColors.primary,
                      onChanged: (bool? val) {
                        setState(() {
                          if (val == true) {
                            _selectedUserIds.add(uid);
                          } else {
                            _selectedUserIds.remove(uid);
                          }
                        });
                      },
                      secondary: CircleAvatar(
                        backgroundColor: AppColors.primary.withValues(alpha: 0.1),
                        foregroundColor: AppColors.primary,
                        child: Text(
                          fullName.isNotEmpty ? fullName[0].toUpperCase() : 'U',
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                      ),
                      title: Row(
                        children: [
                          Expanded(
                            child: Text(
                              fullName,
                              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (roleName.isNotEmpty) ...[
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFEF3C7),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                roleName,
                                style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                              ),
                            ),
                          ],
                        ],
                      ),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '$email${dept.isNotEmpty ? " • $dept" : ""}',
                          style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
