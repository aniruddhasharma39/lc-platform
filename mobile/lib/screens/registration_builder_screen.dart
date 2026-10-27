import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../main.dart';
import '../utils/app_feedback.dart';

/// Palette Field metadata
class PaletteItem {
  final String type;
  final String label;
  final String category; // 'input' | 'contact' | 'choice' | 'media' | 'layout'
  final IconData icon;
  final String hint;

  const PaletteItem({
    required this.type,
    required this.label,
    required this.category,
    required this.icon,
    required this.hint,
  });
}

const List<PaletteItem> paletteFields = [
  PaletteItem(type: 'text', label: 'Short Text', category: 'input', icon: Icons.text_fields, hint: 'Single-line text for names, titles, codes'),
  PaletteItem(type: 'textarea', label: 'Long Text', category: 'input', icon: Icons.notes, hint: 'Multi-line comments, remarks, or notes'),
  PaletteItem(type: 'number', label: 'Number', category: 'input', icon: Icons.tag, hint: 'Numeric values, ages, badge numbers'),
  PaletteItem(type: 'password', label: 'Password', category: 'input', icon: Icons.lock_outline, hint: 'Secure credentials with hash validation'),
  PaletteItem(type: 'email', label: 'Email Address', category: 'contact', icon: Icons.email_outlined, hint: 'Validated electronic mail address'),
  PaletteItem(type: 'phone', label: 'Mobile Phone', category: 'contact', icon: Icons.phone_android, hint: '10-digit phone for SMS & OTP verification'),
  PaletteItem(type: 'dropdown', label: 'Dropdown Select', category: 'choice', icon: Icons.arrow_drop_down_circle_outlined, hint: 'Pick one option from a dropdown menu'),
  PaletteItem(type: 'radio', label: 'Single Choice (Radio)', category: 'choice', icon: Icons.radio_button_checked, hint: 'Pick one visible radio option'),
  PaletteItem(type: 'checkbox', label: 'Multiple Choice', category: 'choice', icon: Icons.check_box_outlined, hint: 'Select one or multiple checkboxes'),
  PaletteItem(type: 'date', label: 'Date Picker', category: 'media', icon: Icons.calendar_today_outlined, hint: 'Calendar date selection'),
  PaletteItem(type: 'image', label: 'Photo / Evidence', category: 'media', icon: Icons.camera_alt_outlined, hint: 'Camera capture or gallery photo upload'),
  PaletteItem(type: 'section', label: 'Section Container', category: 'layout', icon: Icons.folder_outlined, hint: 'Group related fields inside a collapsible block'),
];

class RegistrationBuilderScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  const RegistrationBuilderScreen({super.key, required this.user});

  @override
  State<RegistrationBuilderScreen> createState() => _RegistrationBuilderScreenState();
}

class _RegistrationBuilderScreenState extends State<RegistrationBuilderScreen> {
  bool _isLoading = true;
  List<dynamic> _forms = [];
  List<dynamic> _systemRoles = [];
  String _templateSearchQuery = '';

  // Studio / Editor State
  Map<String, dynamic>? _editingForm;
  List<Map<String, dynamic>> _fields = [];
  bool _allowRoles = true;
  String? _activeFieldId;
  List<String> _builderErrors = [];
  String _activeTab = 'canvas'; // 'canvas' | 'palette' | 'properties' | 'settings'
  String _paletteSearchQuery = '';
  final Map<String, bool> _collapsedSections = {};
  bool _isSaving = false;
  bool _isPublishing = false;
  bool _isCreatingForm = false;
  int? _deletingFormId;

  // Controllers for active field properties
  final TextEditingController _labelCtrl = TextEditingController();
  final TextEditingController _nameCtrl = TextEditingController();
  final TextEditingController _placeholderCtrl = TextEditingController();
  final TextEditingController _helperTextCtrl = TextEditingController();
  final TextEditingController _minLengthCtrl = TextEditingController();
  final TextEditingController _maxLengthCtrl = TextEditingController();
  final TextEditingController _formNameCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _fetchForms();
    _fetchRoles();
  }

  @override
  void dispose() {
    _labelCtrl.dispose();
    _nameCtrl.dispose();
    _placeholderCtrl.dispose();
    _helperTextCtrl.dispose();
    _minLengthCtrl.dispose();
    _maxLengthCtrl.dispose();
    _formNameCtrl.dispose();
    super.dispose();
  }

  Future<String> _getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token') ?? '';
  }

  Future<void> _fetchForms() async {
    setState(() => _isLoading = true);
    try {
      final token = await _getToken();
      final res = await http.get(
        Uri.parse('$baseUrl/registration-forms'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (mounted) {
          setState(() {
            _forms = (data is List) ? data : [];
          });
        }
      } else if (mounted) {
        AppFeedback.showError(context, 'Failed to load registration templates (HTTP ${res.statusCode})');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Network error loading templates: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _fetchRoles() async {
    try {
      final token = await _getToken();
      final res = await http.get(
        Uri.parse('$baseUrl/roles'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (res.statusCode == 200) {
        final data = json.decode(res.body);
        if (data is List && mounted) {
          setState(() => _systemRoles = data);
        }
      }
    } catch (_) {}
  }

  // --- Recursive Helpers ---
  int _countAllFields(List<dynamic> list) {
    int count = 0;
    for (final item in list) {
      count++;
      if (item is Map && item['type'] == 'section' && item['children'] is List) {
        count += _countAllFields(item['children'] as List);
      }
    }
    return count;
  }

  Map<String, dynamic>? _findField(List<Map<String, dynamic>> list, String id) {
    for (final f in list) {
      if (f['id'] == id) return f;
      if (f['type'] == 'section' && f['children'] is List) {
        final found = _findField((f['children'] as List).cast<Map<String, dynamic>>(), id);
        if (found != null) return found;
      }
    }
    return null;
  }

  List<Map<String, dynamic>> _cloneFields(List<dynamic> list) {
    return list.map((item) {
      final map = Map<String, dynamic>.from(item as Map);
      if (map['children'] is List) {
        map['children'] = _cloneFields(map['children'] as List);
      }
      if (map['options'] is List) {
        map['options'] = (map['options'] as List)
            .map((opt) => Map<String, dynamic>.from(opt as Map))
            .toList();
      }
      if (map['validation'] is Map) {
        map['validation'] = Map<String, dynamic>.from(map['validation'] as Map);
      }
      return map;
    }).toList();
  }

  // --- Form Creation, Open, Close, Save, Publish, Delete ---
  Future<void> _createForm() async {
    setState(() => _isCreatingForm = true);
    try {
      final token = await _getToken();
      final defaultSchema = json.encode({
        'fields': [
          {
            'id': 'fn_${DateTime.now().millisecondsSinceEpoch}',
            'type': 'text',
            'name': 'fullName',
            'label': 'Full Name',
            'required': true,
            'placeholder': 'Enter your complete legal name',
          },
          {
            'id': 'ph_${DateTime.now().millisecondsSinceEpoch}',
            'type': 'phone',
            'name': 'mobile',
            'label': 'Mobile Phone',
            'required': true,
            'unique': true,
            'placeholder': '10-digit mobile number for OTP',
          },
          {
            'id': 'em_${DateTime.now().millisecondsSinceEpoch}',
            'type': 'email',
            'name': 'email',
            'label': 'Email Address',
            'required': true,
            'unique': true,
            'placeholder': 'name@example.com',
          },
        ],
        'allowRoles': true,
      });

      final res = await http.post(
        Uri.parse('$baseUrl/registration-forms'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': 'Registration Form v${_forms.length + 1}',
          'schema': defaultSchema,
        }),
      );

      if (res.statusCode == 201) {
        final newForm = json.decode(res.body);
        if (mounted) {
          AppFeedback.showSuccess(context, 'New registration template created!');
          setState(() {
            _forms = [newForm, ..._forms];
          });
          _openForm(newForm);
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to create form template.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error creating form: $e');
    } finally {
      if (mounted) setState(() => _isCreatingForm = false);
    }
  }

  void _openForm(Map<String, dynamic> form) {
    List<Map<String, dynamic>> parsedFields = [];
    bool allowRoles = true;
    try {
      final schema = json.decode(form['schema'] ?? '{}');
      if (schema is Map) {
        if (schema['fields'] is List) {
          parsedFields = _cloneFields(schema['fields'] as List);
        }
        allowRoles = schema['allowRoles'] ?? true;
      }
    } catch (_) {}

    setState(() {
      _editingForm = Map<String, dynamic>.from(form);
      _formNameCtrl.text = form['name'] ?? 'Untitled Form';
      _fields = parsedFields;
      _allowRoles = allowRoles;
      _activeFieldId = null;
      _builderErrors = [];
      _activeTab = 'canvas';
    });
  }

  Future<void> _closeForm() async {
    final leave = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Exit Form Studio?'),
        content: const Text('Any unsaved changes will be lost. Are you sure you want to close this template?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Exit Studio', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    if (leave == true && mounted) {
      setState(() {
        _editingForm = null;
        _fields = [];
        _activeFieldId = null;
        _builderErrors = [];
      });
      _fetchForms();
    }
  }

  List<String> _validateBuilder() {
    final List<String> errors = [];
    final Set<String> keys = {};

    void checkField(Map<String, dynamic> f) {
      final label = (f['label'] ?? '').toString().trim();
      final type = (f['type'] ?? 'text').toString();
      final name = (f['name'] ?? '').toString().trim();

      if (label.isEmpty) {
        errors.add('Field is missing a display label (ID: ${f['id']})');
      }

      if (type != 'section') {
        if (name.isEmpty) {
          errors.add('Field "${label.isEmpty ? 'Untitled' : label}" is missing an API Key slug');
        } else {
          if (keys.contains(name)) {
            errors.add('Duplicate API Key slug found: "$name"');
          }
          keys.add(name);
        }
      }

      if (['dropdown', 'radio', 'checkbox'].contains(type)) {
        final options = f['options'] as List?;
        if (options == null || options.isEmpty) {
          errors.add('Field "$label" must have at least one choice option.');
        } else {
          final optVals = <String>{};
          for (final opt in options) {
            final val = (opt['value'] ?? '').toString().trim();
            if (val.isEmpty) {
              errors.add('Field "$label" contains an empty option value.');
            } else if (optVals.contains(val)) {
              errors.add('Field "$label" has duplicate option value: "$val"');
            }
            optVals.add(val);
          }
        }
      }

      if (f['validation'] is Map) {
        final valMap = f['validation'] as Map;
        final minL = valMap['minLength'] is int ? valMap['minLength'] as int : int.tryParse(valMap['minLength']?.toString() ?? '');
        final maxL = valMap['maxLength'] is int ? valMap['maxLength'] as int : int.tryParse(valMap['maxLength']?.toString() ?? '');
        if (minL != null && maxL != null && minL > maxL) {
          errors.add('Field "$label" has contradictory validation (Min Length $minL > Max Length $maxL)');
        }
      }

      if (f['children'] is List) {
        for (final child in f['children'] as List) {
          checkField(child as Map<String, dynamic>);
        }
      }
    }

    for (final f in _fields) {
      checkField(f);
    }

    bool hasRequiredEmail = false;
    bool hasRequiredPhone = false;

    void checkContact(Map<String, dynamic> f) {
      final type = (f['type'] ?? '').toString();
      final name = (f['name'] ?? '').toString().toLowerCase();
      final isReq = f['required'] == true;

      if ((type == 'email' || name.contains('email')) && isReq) {
        hasRequiredEmail = true;
      }
      if ((type == 'phone' || name.contains('mobile') || name.contains('phone')) && isReq) {
        hasRequiredPhone = true;
      }
      if (f['children'] is List) {
        for (final child in f['children'] as List) {
          checkContact(child as Map<String, dynamic>);
        }
      }
    }

    for (final f in _fields) {
      checkContact(f);
    }

    if (!hasRequiredEmail && !hasRequiredPhone) {
      errors.add('Registration form must have at least one required contact method (Email or Mobile Phone marked as Required) for OTP security & credentials.');
    }

    return errors;
  }

  Future<void> _saveDraft() async {
    if (_editingForm == null) return;
    final errors = _validateBuilder();
    setState(() => _builderErrors = errors);

    if (errors.isNotEmpty) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Row(
            children: [
              Icon(Icons.warning_amber_rounded, color: Colors.amber),
              SizedBox(width: 8),
              Text('Validation Notice'),
            ],
          ),
          content: Text('Your template has ${errors.length} validation issue(s). Save draft anyway?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save Draft Anyway')),
          ],
        ),
      );
      if (proceed != true) return;
    }

    setState(() => _isSaving = true);
    try {
      final token = await _getToken();
      final formId = _editingForm!['id'];
      final formName = _formNameCtrl.text.trim().isNotEmpty ? _formNameCtrl.text.trim() : _editingForm!['name'];
      final schemaPayload = json.encode({
        'fields': _fields,
        'allowRoles': _allowRoles,
      });

      final res = await http.put(
        Uri.parse('$baseUrl/registration-forms/$formId'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': formName,
          'schema': schemaPayload,
        }),
      );

      if (res.statusCode == 200) {
        final updated = json.decode(res.body);
        if (mounted) {
          setState(() {
            _editingForm = updated;
          });
          AppFeedback.showSuccess(context, 'Draft template saved successfully!');
          _fetchForms();
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to save draft.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error saving draft: $e');
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  Future<void> _publishLive() async {
    if (_editingForm == null) return;
    final errors = _validateBuilder();
    setState(() => _builderErrors = errors);

    if (errors.isNotEmpty) {
      AppFeedback.showError(context, 'Cannot publish: Please resolve ${errors.length} validation error(s).');
      return;
    }

    final formName = _formNameCtrl.text.trim().isNotEmpty ? _formNameCtrl.text.trim() : _editingForm!['name'];
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.cloud_upload_outlined, color: AppColors.primary),
            SizedBox(width: 8),
            Text('Publish Form Live?'),
          ],
        ),
        content: Text('Are you sure you want to publish "$formName"? This will immediately become the LIVE registration form for all public onboarding and applicant registrations.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF16A34A)),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Publish Live Now', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    setState(() => _isPublishing = true);
    try {
      final token = await _getToken();
      final formId = _editingForm!['id'];
      final schemaPayload = json.encode({
        'fields': _fields,
        'allowRoles': _allowRoles,
      });

      // 1. Save draft first
      await http.put(
        Uri.parse('$baseUrl/registration-forms/$formId'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'name': formName,
          'schema': schemaPayload,
        }),
      );

      // 2. Publish
      final res = await http.put(
        Uri.parse('$baseUrl/registration-forms/$formId/publish'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'Form "$formName" is now LIVE for registrations!');
          setState(() {
            _editingForm = null;
            _fields = [];
          });
          _fetchForms();
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to publish form.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error publishing form: $e');
    } finally {
      if (mounted) setState(() => _isPublishing = false);
    }
  }

  Future<void> _deleteForm(int id, String name) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Form Template?'),
        content: Text('Are you sure you want to permanently delete "$name"? This action cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    setState(() => _deletingFormId = id);
    try {
      final token = await _getToken();
      final res = await http.delete(
        Uri.parse('$baseUrl/registration-forms/$id'),
        headers: {'Authorization': 'Bearer $token'},
      );

      if (res.statusCode == 200) {
        if (mounted) {
          AppFeedback.showSuccess(context, 'Template "$name" deleted.');
          setState(() {
            _forms.removeWhere((f) => f['id'] == id);
          });
        }
      } else {
        final err = json.decode(res.body);
        if (mounted) AppFeedback.showError(context, err['error'] ?? 'Failed to delete template.');
      }
    } catch (e) {
      if (mounted) AppFeedback.showError(context, 'Error deleting template: $e');
    } finally {
      if (mounted) setState(() => _deletingFormId = null);
    }
  }

  // --- Field Manipulation ---
  Map<String, dynamic> _createNewFieldObject(String type) {
    final suffix = DateTime.now().millisecondsSinceEpoch.toString().substring(8);
    final defaultLabels = {
      'text': 'Full Name',
      'textarea': 'Additional Remarks',
      'number': 'Employee Badge Number',
      'email': 'Email Address',
      'phone': 'Mobile Phone Number',
      'password': 'Create Password',
      'dropdown': 'Department / Section',
      'radio': 'Gender / Category',
      'checkbox': 'Agreed Declarations',
      'date': 'Date of Joining',
      'image': 'Government ID Proof',
      'section': 'Personal Details',
    };

    final defaultKeys = {
      'text': 'fullName_$suffix',
      'textarea': 'remarks_$suffix',
      'number': 'badgeNumber_$suffix',
      'email': 'email',
      'phone': 'mobile',
      'password': 'password',
      'dropdown': 'department_$suffix',
      'radio': 'category_$suffix',
      'checkbox': 'declarations_$suffix',
      'date': 'joiningDate_$suffix',
      'image': 'idProof_$suffix',
      'section': '',
    };

    final newField = <String, dynamic>{
      'id': 'f_${DateTime.now().millisecondsSinceEpoch}_$suffix',
      'type': type,
      'name': defaultKeys[type] ?? 'field_$suffix',
      'label': defaultLabels[type] ?? 'New Field',
      'required': ['email', 'phone', 'text'].contains(type),
      'unique': ['email', 'phone'].contains(type),
    };

    if (type == 'section') {
      newField['children'] = <Map<String, dynamic>>[];
    }

    if (['dropdown', 'radio', 'checkbox'].contains(type)) {
      newField['options'] = [
        {'id': 'opt_1_$suffix', 'label': 'Option 1', 'value': 'option_1'},
        {'id': 'opt_2_$suffix', 'label': 'Option 2', 'value': 'option_2'},
      ];
    }

    return newField;
  }

  void _addField(String type, {String? targetSectionId}) {
    final newField = _createNewFieldObject(type);
    setState(() {
      if (targetSectionId != null) {
        for (final f in _fields) {
          if (f['id'] == targetSectionId && f['children'] is List) {
            (f['children'] as List).add(newField);
            break;
          }
        }
      } else {
        _fields.add(newField);
      }
      _selectField(newField['id']);
      _activeTab = 'properties';
    });
    AppFeedback.showSuccess(context, 'Added "${newField['label']}"');
  }

  void _duplicateField(String id) {
    Map<String, dynamic>? cloneField(Map<String, dynamic> src) {
      final suffix = DateTime.now().millisecondsSinceEpoch.toString().substring(8);
      final copy = Map<String, dynamic>.from(src);
      copy['id'] = 'f_${DateTime.now().millisecondsSinceEpoch}_$suffix';
      if (copy['type'] != 'section') {
        copy['name'] = '${copy['name']}_copy';
      }
      copy['label'] = '${copy['label']} (Copy)';
      if (copy['children'] is List) {
        copy['children'] = (copy['children'] as List)
            .map((c) => cloneField(c as Map<String, dynamic>))
            .whereType<Map<String, dynamic>>()
            .toList();
      }
      if (copy['options'] is List) {
        copy['options'] = (copy['options'] as List)
            .map((opt) => Map<String, dynamic>.from(opt as Map))
            .toList();
      }
      return copy;
    }

    bool walk(List<Map<String, dynamic>> list) {
      for (int i = 0; i < list.length; i++) {
        if (list[i]['id'] == id) {
          final dup = cloneField(list[i]);
          if (dup != null) {
            list.insert(i + 1, dup);
            _selectField(dup['id']);
          }
          return true;
        }
        if (list[i]['children'] is List) {
          if (walk((list[i]['children'] as List).cast<Map<String, dynamic>>())) {
            return true;
          }
        }
      }
      return false;
    }

    setState(() {
      walk(_fields);
    });
    AppFeedback.showSuccess(context, 'Field duplicated successfully!');
  }

  void _deleteField(String id) {
    bool walk(List<Map<String, dynamic>> list) {
      for (int i = 0; i < list.length; i++) {
        if (list[i]['id'] == id) {
          list.removeAt(i);
          return true;
        }
        if (list[i]['children'] is List) {
          if (walk((list[i]['children'] as List).cast<Map<String, dynamic>>())) {
            return true;
          }
        }
      }
      return false;
    }

    setState(() {
      walk(_fields);
      if (_activeFieldId == id) {
        _activeFieldId = null;
        if (_activeTab == 'properties') _activeTab = 'canvas';
      }
    });
    AppFeedback.showInfo(context, 'Field deleted');
  }

  void _moveFieldUp(String id) {
    bool walk(List<Map<String, dynamic>> list) {
      for (int i = 0; i < list.length; i++) {
        if (list[i]['id'] == id) {
          if (i > 0) {
            final item = list.removeAt(i);
            list.insert(i - 1, item);
          }
          return true;
        }
        if (list[i]['children'] is List) {
          if (walk((list[i]['children'] as List).cast<Map<String, dynamic>>())) {
            return true;
          }
        }
      }
      return false;
    }

    setState(() {
      walk(_fields);
    });
  }

  void _moveFieldDown(String id) {
    bool walk(List<Map<String, dynamic>> list) {
      for (int i = 0; i < list.length; i++) {
        if (list[i]['id'] == id) {
          if (i < list.length - 1) {
            final item = list.removeAt(i);
            list.insert(i + 1, item);
          }
          return true;
        }
        if (list[i]['children'] is List) {
          if (walk((list[i]['children'] as List).cast<Map<String, dynamic>>())) {
            return true;
          }
        }
      }
      return false;
    }

    setState(() {
      walk(_fields);
    });
  }

  void _selectField(String id) {
    final f = _findField(_fields, id);
    if (f != null) {
      _activeFieldId = id;
      _labelCtrl.text = f['label'] ?? '';
      _nameCtrl.text = f['name'] ?? '';
      _placeholderCtrl.text = f['placeholder'] ?? '';
      _helperTextCtrl.text = f['helperText'] ?? '';

      final valMap = f['validation'] as Map?;
      _minLengthCtrl.text = valMap?['minLength']?.toString() ?? '';
      _maxLengthCtrl.text = valMap?['maxLength']?.toString() ?? '';
    }
  }

  void _updateActiveField(void Function(Map<String, dynamic> f) updater) {
    if (_activeFieldId == null) return;
    setState(() {
      final f = _findField(_fields, _activeFieldId!);
      if (f != null) {
        updater(f);
      }
    });
  }

  // --- UI Views ---
  @override
  Widget build(BuildContext context) {
    if (_editingForm != null) {
      return _buildEditorView();
    }
    return _buildCatalogView();
  }

  // ==========================================
  // CATALOG VIEW
  // ==========================================
  Widget _buildCatalogView() {
    final totalTemplates = _forms.length;
    final liveTemplate = _forms.firstWhere(
      (f) => f['status'] == 'LIVE',
      orElse: () => null,
    );

    int liveFieldCount = 0;
    if (liveTemplate != null) {
      try {
        final parsed = json.decode(liveTemplate['schema'] ?? '{}');
        liveFieldCount = _countAllFields(parsed['fields'] ?? []);
      } catch (_) {}
    }

    final filteredTemplates = _forms.where((f) {
      final name = (f['name'] ?? '').toString().toLowerCase();
      final status = (f['status'] ?? '').toString().toLowerCase();
      final q = _templateSearchQuery.toLowerCase();
      return name.contains(q) || status.contains(q);
    }).toList();

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      body: RefreshIndicator(
        onRefresh: _fetchForms,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.description, color: AppColors.primary, size: 26),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Registration Builder',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'Design, customize, and publish dynamic user onboarding and verification forms',
                          style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                        ),
                      ],
                    ),
                  ),
                  ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF16A34A),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    onPressed: _isCreatingForm ? null : _createForm,
                    icon: _isCreatingForm
                        ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.add, size: 18),
                    label: Text(
                      _isCreatingForm ? 'Creating...' : 'Create Form',
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // 4 Stat Cards
              LayoutBuilder(
                builder: (context, constraints) {
                  final isWide = constraints.maxWidth > 560;
                  final cards = [
                    _buildStatCard(
                      icon: Icons.assignment_outlined,
                      iconBg: const Color(0xFFEFF6FF),
                      iconColor: const Color(0xFF2563EB),
                      label: 'Total Templates',
                      value: '$totalTemplates',
                    ),
                    _buildStatCard(
                      icon: Icons.check_circle_outline,
                      iconBg: const Color(0xFFF0FDF4),
                      iconColor: const Color(0xFF16A34A),
                      label: 'Active Live Form',
                      value: liveTemplate != null ? (liveTemplate['name'] ?? 'LIVE') : 'None Live',
                    ),
                    _buildStatCard(
                      icon: Icons.layers_outlined,
                      iconBg: const Color(0xFFECFEFF),
                      iconColor: const Color(0xFF0891B2),
                      label: 'Live Form Fields',
                      value: '$liveFieldCount',
                    ),
                    _buildStatCard(
                      icon: Icons.phone_android,
                      iconBg: const Color(0xFFFFFBEB),
                      iconColor: const Color(0xFFD97706),
                      label: 'Console Engine',
                      value: 'Mobile Responsive',
                    ),
                  ];

                  if (isWide) {
                    return Row(
                      children: cards.map((c) => Expanded(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: c))).toList(),
                    );
                  } else {
                    return Column(
                      children: [
                        Row(
                          children: [
                            Expanded(child: cards[0]),
                            const SizedBox(width: 8),
                            Expanded(child: cards[1]),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(child: cards[2]),
                            const SizedBox(width: 8),
                            Expanded(child: cards[3]),
                          ],
                        ),
                      ],
                    );
                  }
                },
              ),
              const SizedBox(height: 16),

              // Search Bar
              TextField(
                onChanged: (val) => setState(() => _templateSearchQuery = val),
                decoration: InputDecoration(
                  hintText: 'Search registration templates...',
                  hintStyle: const TextStyle(fontSize: 13, color: Color(0xFF94A3B8)),
                  prefixIcon: const Icon(Icons.search, size: 20, color: Color(0xFF94A3B8)),
                  filled: true,
                  fillColor: Colors.white,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: AppColors.primary),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Template Cards List
              if (_isLoading)
                const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
              else if (filteredTemplates.isEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Column(
                    children: [
                      const Icon(Icons.description_outlined, size: 48, color: Color(0xFF94A3B8)),
                      const SizedBox(height: 12),
                      const Text(
                        'No registration templates found',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _templateSearchQuery.isEmpty
                            ? 'Tap "+ Create Form" above to build your first registration template.'
                            : 'No templates match your search criteria.',
                        style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                )
              else
                ...filteredTemplates.map((form) {
                  final formId = form['id'] as int;
                  final name = (form['name'] ?? 'Form #$formId').toString();
                  final status = (form['status'] ?? 'DRAFT').toString().toUpperCase();
                  final version = form['version'] ?? 1;
                  final isLive = status == 'LIVE';

                  int fieldCount = 0;
                  try {
                    final p = json.decode(form['schema'] ?? '{}');
                    fieldCount = _countAllFields(p['fields'] ?? []);
                  } catch (_) {}

                  DateTime? createdAt;
                  if (form['createdAt'] != null) {
                    createdAt = DateTime.tryParse(form['createdAt'].toString());
                  }

                  final createdStr = createdAt != null
                      ? '${createdAt.year}-${createdAt.month.toString().padLeft(2, '0')}-${createdAt.day.toString().padLeft(2, '0')}'
                      : 'Recently';

                  return Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: isLive ? const Color(0xFF16A34A).withValues(alpha: 0.5) : const Color(0xFFE2E8F0),
                        width: isLive ? 1.5 : 1.0,
                      ),
                      boxShadow: [
                        BoxSideShadow(
                          color: Colors.black.withValues(alpha: 0.03),
                          blurRadius: 4,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    name,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 15,
                                      color: Color(0xFF0F172A),
                                    ),
                                  ),
                                  const SizedBox(height: 3),
                                  Text(
                                    'Version $version • $fieldCount Field${fieldCount == 1 ? '' : 's'}',
                                    style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                                  ),
                                ],
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                              decoration: BoxDecoration(
                                color: isLive ? const Color(0xFFDCFCE7) : const Color(0xFFF1F5F9),
                                borderRadius: BorderRadius.circular(20),
                                border: Border.all(
                                  color: isLive ? const Color(0xFF86EFAC) : const Color(0xFFCBD5E1),
                                ),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (isLive) ...[
                                    Container(
                                      width: 6,
                                      height: 6,
                                      decoration: const BoxDecoration(
                                        shape: BoxShape.circle,
                                        color: Color(0xFF16A34A),
                                      ),
                                    ),
                                    const SizedBox(width: 5),
                                  ],
                                  Text(
                                    status,
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.bold,
                                      color: isLive ? const Color(0xFF15803D) : const Color(0xFF475569),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Created: $createdStr',
                          style: const TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
                        ),
                        const SizedBox(height: 12),
                        const Divider(height: 1, color: Color(0xFFF1F5F9)),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Expanded(
                              child: ElevatedButton.icon(
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: AppColors.primary,
                                  foregroundColor: Colors.white,
                                  padding: const EdgeInsets.symmetric(vertical: 8),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                ),
                                onPressed: () => _openForm(form),
                                icon: const Icon(Icons.edit_outlined, size: 16),
                                label: const Text('Edit Form', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
                              ),
                            ),
                            if (!isLive) ...[
                              const SizedBox(width: 8),
                              IconButton(
                                style: IconButton.styleFrom(
                                  backgroundColor: const Color(0xFFFEE2E2),
                                  foregroundColor: AppColors.danger,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                ),
                                onPressed: _deletingFormId == formId ? null : () => _deleteForm(formId, name),
                                icon: _deletingFormId == formId
                                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.danger))
                                    : const Icon(Icons.delete_outline, size: 18),
                                tooltip: 'Delete Template',
                              ),
                            ],
                          ],
                        ),
                      ],
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatCard({
    required IconData icon,
    required Color iconBg,
    required Color iconColor,
    required String label,
    required String value,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(8)),
            child: Icon(icon, color: iconColor, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ==========================================
  // STUDIO / EDITOR VIEW
  // ==========================================
  Widget _buildEditorView() {
    final totalFields = _countAllFields(_fields);
    final status = (_editingForm?['status'] ?? 'DRAFT').toString().toUpperCase();
    final isLive = status == 'LIVE';
    final version = _editingForm?['version'] ?? 1;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _closeForm();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF8FAFC),
        appBar: AppBar(
          backgroundColor: Colors.white,
          elevation: 1,
          leading: IconButton(
            icon: const Icon(Icons.arrow_back, color: Color(0xFF0F172A)),
            onPressed: _closeForm,
            tooltip: 'Cancel & Exit',
          ),
          titleSpacing: 0,
          title: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _formNameCtrl,
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                    hintText: 'Form Template Name',
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: isLive ? const Color(0xFFDCFCE7) : const Color(0xFFF1F5F9),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: isLive ? const Color(0xFF86EFAC) : const Color(0xFFCBD5E1)),
                ),
                child: Text(
                  status,
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: isLive ? const Color(0xFF15803D) : const Color(0xFF475569),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text('v$version', style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
              const SizedBox(width: 8),
            ],
          ),
          actions: [
            IconButton(
              icon: const Icon(Icons.visibility_outlined, color: AppColors.primary),
              tooltip: 'Live Preview',
              onPressed: _openLivePreviewModal,
            ),
            IconButton(
              icon: _isSaving
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary))
                  : const Icon(Icons.save_outlined, color: AppColors.primary),
              tooltip: 'Save Draft',
              onPressed: _isSaving ? null : _saveDraft,
            ),
            IconButton(
              icon: _isPublishing
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF16A34A)))
                  : const Icon(Icons.cloud_upload_outlined, color: Color(0xFF16A34A)),
              tooltip: 'Publish Live',
              onPressed: _isPublishing ? null : _publishLive,
            ),
          ],
        ),
        body: Column(
          children: [
            // Validation Warning Banner (if any)
            if (_builderErrors.isNotEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                color: const Color(0xFFFEF2F2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.warning_amber_rounded, color: AppColors.danger, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Form Validation Warning:',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppColors.danger),
                          ),
                          const SizedBox(height: 2),
                          ..._builderErrors.map((err) => Text('• $err', style: const TextStyle(fontSize: 11, color: Color(0xFF991B1B)))),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

            // Segmented Navigation Bar (<1024px parity)
            Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
              ),
              child: Row(
                children: [
                  _buildTabButton(
                    id: 'canvas',
                    label: 'Canvas',
                    icon: Icons.view_agenda_outlined,
                    badge: '$totalFields',
                  ),
                  _buildTabButton(
                    id: 'palette',
                    label: '+ Add Field',
                    icon: Icons.add_circle_outline,
                  ),
                  _buildTabButton(
                    id: 'properties',
                    label: _activeFieldId != null ? 'Properties' : 'Properties',
                    icon: Icons.tune,
                    disabled: _activeFieldId == null,
                  ),
                  _buildTabButton(
                    id: 'settings',
                    label: 'Settings',
                    icon: Icons.settings_outlined,
                  ),
                ],
              ),
            ),

            // Active Tab Content
            Expanded(
              child: IndexedStack(
                index: _getTabIndex(_activeTab),
                children: [
                  _buildCanvasTab(),
                  _buildPaletteTab(),
                  _buildPropertiesTab(),
                  _buildSettingsTab(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  int _getTabIndex(String tab) {
    switch (tab) {
      case 'canvas':
        return 0;
      case 'palette':
        return 1;
      case 'properties':
        return 2;
      case 'settings':
        return 3;
      default:
        return 0;
    }
  }

  Widget _buildTabButton({
    required String id,
    required String label,
    required IconData icon,
    String? badge,
    bool disabled = false,
  }) {
    final isActive = _activeTab == id;
    final color = disabled
        ? const Color(0xFFCBD5E1)
        : isActive
            ? AppColors.primary
            : const Color(0xFF64748B);

    return Expanded(
      child: InkWell(
        onTap: disabled
            ? () => AppFeedback.showInfo(context, 'Please select a field first')
            : () => setState(() => _activeTab = id),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: isActive ? AppColors.primary : Colors.transparent,
                width: 2.5,
              ),
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 16, color: color),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
                    color: color,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (badge != null) ...[
                const SizedBox(width: 4),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(
                    color: isActive ? AppColors.primary : const Color(0xFFE2E8F0),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    badge,
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: isActive ? Colors.white : const Color(0xFF475569),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  // ==========================================
  // TAB 1: CANVAS
  // ==========================================
  Widget _buildCanvasTab() {
    if (_fields.isEmpty) {
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.08),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.description_outlined, size: 48, color: AppColors.primary),
              ),
              const SizedBox(height: 16),
              const Text(
                'Start Building Your Registration Form',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 6),
              const Text(
                'Add elements from the "+ Add Field" library or tap a starter shortcut below to begin.',
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: [
                  OutlinedButton.icon(
                    onPressed: () => _addField('text'),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('+ Full Name'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _addField('phone'),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('+ Phone (SMS/OTP)'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _addField('email'),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('+ Email'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _addField('section'),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('+ Section'),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        ..._fields.map((f) => _buildFieldCard(f)),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 12),
            side: const BorderSide(color: AppColors.primary, style: BorderStyle.solid),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          onPressed: () => setState(() => _activeTab = 'palette'),
          icon: const Icon(Icons.add, color: AppColors.primary),
          label: const Text('+ Add New Field', style: TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary)),
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _buildFieldCard(Map<String, dynamic> field, {bool isChild = false}) {
    final id = field['id'].toString();
    final type = (field['type'] ?? 'text').toString();
    final label = (field['label'] ?? 'Untitled Field').toString();
    final name = (field['name'] ?? '').toString();
    final isReq = field['required'] == true;
    final isUnique = field['unique'] == true;
    final isSection = type == 'section';
    final isActive = _activeFieldId == id;
    final isCollapsed = _collapsedSections[id] == true;

    return Container(
      margin: EdgeInsets.only(bottom: 8, left: isChild ? 14 : 0),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: isActive
              ? AppColors.primary
              : isSection
                  ? const Color(0xFFCBD5E1)
                  : const Color(0xFFE2E8F0),
          width: isActive ? 2 : 1,
        ),
        boxShadow: [
          BoxSideShadow(
            color: Colors.black.withValues(alpha: 0.02),
            blurRadius: 3,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header Row
          InkWell(
            onTap: () {
              _selectField(id);
              setState(() => _activeTab = 'properties');
            },
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: [
                  const Icon(Icons.drag_indicator, size: 18, color: Color(0xFF94A3B8)),
                  const SizedBox(width: 6),
                  if (isSection)
                    Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEFF6FF),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: const Icon(Icons.folder_outlined, size: 14, color: AppColors.primary),
                    )
                  else if (isReq)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFEE2E2),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text('* Req', style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.danger)),
                    ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          label,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            color: isActive ? AppColors.primary : const Color(0xFF0F172A),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF1F5F9),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                type.toUpperCase(),
                                style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                              ),
                            ),
                            if (!isSection && name.isNotEmpty) ...[
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  name,
                                  style: const TextStyle(fontSize: 10, color: Color(0xFF94A3B8), fontFamily: 'monospace'),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                            if (isUnique) ...[
                              const SizedBox(width: 6),
                              const Icon(Icons.fingerprint, size: 12, color: Color(0xFF0891B2)),
                              const SizedBox(width: 2),
                              const Text('Unique', style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: Color(0xFF0891B2))),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),

                  // Actions Toolbar
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        icon: const Icon(Icons.arrow_upward, size: 16, color: Color(0xFF64748B)),
                        tooltip: 'Move Up',
                        onPressed: () => _moveFieldUp(id),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        icon: const Icon(Icons.arrow_downward, size: 16, color: Color(0xFF64748B)),
                        tooltip: 'Move Down',
                        onPressed: () => _moveFieldDown(id),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        icon: Icon(Icons.settings, size: 16, color: isActive ? AppColors.primary : const Color(0xFF64748B)),
                        tooltip: 'Edit Properties',
                        onPressed: () {
                          _selectField(id);
                          setState(() => _activeTab = 'properties');
                        },
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        icon: const Icon(Icons.copy, size: 16, color: Color(0xFF64748B)),
                        tooltip: 'Duplicate',
                        onPressed: () => _duplicateField(id),
                      ),
                      IconButton(
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                        icon: const Icon(Icons.delete_outline, size: 16, color: AppColors.danger),
                        tooltip: 'Delete',
                        onPressed: () => _deleteField(id),
                      ),
                      if (isSection)
                        IconButton(
                          visualDensity: VisualDensity.compact,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                          icon: Icon(isCollapsed ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_up, size: 18),
                          onPressed: () {
                            setState(() {
                              _collapsedSections[id] = !isCollapsed;
                            });
                          },
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          // Section Children Container
          if (isSection && !isCollapsed) ...[
            const Divider(height: 1, color: Color(0xFFF1F5F9)),
            Container(
              padding: const EdgeInsets.all(10),
              color: const Color(0xFFF8FAFC),
              child: Column(
                children: [
                  if (field['children'] is List && (field['children'] as List).isNotEmpty)
                    ...(field['children'] as List).map((child) => _buildFieldCard(child as Map<String, dynamic>, isChild: true))
                  else
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Text(
                        'Empty Section: Tap "+ Add Field inside" below',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade500, fontStyle: FontStyle.italic),
                      ),
                    ),
                  const SizedBox(height: 6),
                  TextButton.icon(
                    style: TextButton.styleFrom(
                      foregroundColor: AppColors.primary,
                      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold),
                    ),
                    onPressed: () => _addField('text', targetSectionId: id),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Add Field Inside Section'),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  // ==========================================
  // TAB 2: PALETTE (+ ADD FIELD)
  // ==========================================
  Widget _buildPaletteTab() {
    final filtered = paletteFields.where((p) {
      final q = _paletteSearchQuery.toLowerCase();
      return p.label.toLowerCase().contains(q) ||
          p.hint.toLowerCase().contains(q) ||
          p.category.toLowerCase().contains(q);
    }).toList();

    const categories = [
      {'key': 'input', 'title': 'Text & Input'},
      {'key': 'contact', 'title': 'Contact & Verification'},
      {'key': 'choice', 'title': 'Options & Choices'},
      {'key': 'media', 'title': 'Media & Date'},
      {'key': 'layout', 'title': 'Sections & Layout'},
    ];

    return SingleChildScrollView(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Search Box
          TextField(
            onChanged: (val) => setState(() => _paletteSearchQuery = val),
            decoration: InputDecoration(
              hintText: 'Search field types...',
              hintStyle: const TextStyle(fontSize: 13, color: Color(0xFF94A3B8)),
              prefixIcon: const Icon(Icons.search, size: 18, color: Color(0xFF94A3B8)),
              filled: true,
              fillColor: Colors.white,
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: const BorderSide(color: AppColors.primary),
              ),
            ),
          ),
          const SizedBox(height: 14),

          // Categories
          ...categories.map((cat) {
            final catItems = filtered.where((p) => p.category == cat['key']).toList();
            if (catItems.isEmpty) return const SizedBox.shrink();

            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    cat['title']!,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF475569),
                      letterSpacing: 0.4,
                    ),
                  ),
                ),
                ...catItems.map((p) => _buildPaletteItemRow(p)),
                const SizedBox(height: 8),
              ],
            );
          }),

          // Role selection toggle card at bottom of palette
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Row(
              children: [
                Checkbox(
                  value: _allowRoles,
                  activeColor: AppColors.primary,
                  onChanged: (val) => setState(() => _allowRoles = val ?? true),
                ),
                const SizedBox(width: 8),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Allow Role Selection on Form',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                      ),
                      SizedBox(height: 2),
                      Text(
                        'Prompts applicants to request a designated role (e.g. Gatesman, Section Master).',
                        style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _buildPaletteItemRow(PaletteItem item) {
    Color iconColor;
    Color iconBg;
    switch (item.category) {
      case 'input':
        iconColor = const Color(0xFF2563EB);
        iconBg = const Color(0xFFEFF6FF);
        break;
      case 'contact':
        iconColor = const Color(0xFF16A34A);
        iconBg = const Color(0xFFF0FDF4);
        break;
      case 'choice':
        iconColor = const Color(0xFF9333EA);
        iconBg = const Color(0xFFFAF5FF);
        break;
      case 'media':
        iconColor = const Color(0xFFEA580C);
        iconBg = const Color(0xFFFFF7ED);
        break;
      case 'layout':
      default:
        iconColor = const Color(0xFF0891B2);
        iconBg = const Color(0xFFECFEFF);
        break;
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: ListTile(
        onTap: () {
          _addField(item.type);
          setState(() => _activeTab = 'canvas');
        },
        leading: Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(8)),
          child: Icon(item.icon, color: iconColor, size: 20),
        ),
        title: Text(
          item.label,
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
        ),
        subtitle: Text(
          item.hint,
          style: const TextStyle(fontSize: 11, color: Color(0xFF64748B)),
        ),
        trailing: const Icon(Icons.add, color: AppColors.primary, size: 20),
      ),
    );
  }

  // ==========================================
  // TAB 3: PROPERTIES INSPECTOR
  // ==========================================
  Widget _buildPropertiesTab() {
    if (_activeFieldId == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.08),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.tune, size: 40, color: AppColors.primary),
              ),
              const SizedBox(height: 14),
              const Text(
                'No Field Selected',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFF0F172A)),
              ),
              const SizedBox(height: 4),
              const Text(
                'Select a field in the Canvas or tap its gear ⚙️ icon to inspect and customize properties.',
                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: () => setState(() => _activeTab = 'canvas'),
                icon: const Icon(Icons.view_agenda_outlined, size: 16),
                label: const Text('Return to Canvas'),
              ),
            ],
          ),
        ),
      );
    }

    final field = _findField(_fields, _activeFieldId!);
    if (field == null) {
      return const Center(child: Text('Field not found.'));
    }

    final type = (field['type'] ?? 'text').toString();
    final isSection = type == 'section';
    final hasOptions = ['dropdown', 'radio', 'checkbox'].contains(type);
    final hasValidation = ['text', 'textarea', 'password', 'number'].contains(type);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Inspector Header
          Row(
            children: [
              const Icon(Icons.tune, size: 18, color: AppColors.primary),
              const SizedBox(width: 8),
              const Text('Field Properties', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A))),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(color: const Color(0xFFEFF6FF), borderRadius: BorderRadius.circular(4)),
                child: Text(type.toUpperCase(), style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.primary)),
              ),
              const Spacer(),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.close, size: 18),
                onPressed: () => setState(() => _activeTab = 'canvas'),
              ),
            ],
          ),
          const Divider(height: 20),

          // Display Label
          const Text('Display Label', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
          const SizedBox(height: 4),
          TextField(
            controller: _labelCtrl,
            decoration: const InputDecoration(
              hintText: 'e.g. Full Name, Email, Employee ID',
              isDense: true,
            ),
            onChanged: (val) {
              _updateActiveField((f) {
                f['label'] = val;
                // Auto-generate slug if default
                final curName = (f['name'] ?? '').toString();
                if (curName.startsWith('fullName_') || curName.startsWith('field_') || curName.isEmpty) {
                  final clean = val.replaceAll(RegExp(r'[^a-zA-Z0-9]'), '');
                  if (clean.isNotEmpty) {
                    final camel = clean[0].toLowerCase() + clean.substring(1);
                    f['name'] = camel;
                    _nameCtrl.text = camel;
                  }
                }
              });
            },
          ),
          const SizedBox(height: 4),
          const Text('Visible title displayed to the user on the registration screen.', style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
          const SizedBox(height: 14),

          // API Key / Database Key (if not section)
          if (!isSection) ...[
            const Text('API Key / Database Slug', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
            const SizedBox(height: 4),
            TextField(
              controller: _nameCtrl,
              decoration: const InputDecoration(
                hintText: 'e.g. fullName, mobile, employeeId',
                isDense: true,
              ),
              onChanged: (val) {
                final clean = val.replaceAll(RegExp(r'[^a-zA-Z0-9_]'), '');
                _updateActiveField((f) => f['name'] = clean);
              },
            ),
            const SizedBox(height: 4),
            const Text('Unique programmatic identifier for API submissions and DB storage.', style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8))),
            const SizedBox(height: 14),

            // Placeholder Text
            const Text('Placeholder Text', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
            const SizedBox(height: 4),
            TextField(
              controller: _placeholderCtrl,
              decoration: const InputDecoration(
                hintText: 'e.g. Enter your full name...',
                isDense: true,
              ),
              onChanged: (val) => _updateActiveField((f) => f['placeholder'] = val),
            ),
            const SizedBox(height: 14),
          ],

          // Helper Text
          const Text('Helper Note / Description', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
          const SizedBox(height: 4),
          TextField(
            controller: _helperTextCtrl,
            decoration: const InputDecoration(
              hintText: 'e.g. Please provide a government registered number',
              isDense: true,
            ),
            onChanged: (val) => _updateActiveField((f) => f['helperText'] = val),
          ),
          const SizedBox(height: 16),

          // Toggles: Required & Unique
          if (!isSection) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Mandatory Field (* Required)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
                subtitle: const Text('Applicant cannot submit without filling this', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                value: field['required'] == true,
                onChanged: (val) => _updateActiveField((f) => f['required'] = val),
              ),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Row(
                  children: [
                    Icon(Icons.fingerprint, size: 16, color: Color(0xFF0891B2)),
                    SizedBox(width: 6),
                    Text('Unique Identifier', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
                  ],
                ),
                subtitle: const Text('Value cannot be duplicated across users (e.g. Email, Mobile)', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                value: field['unique'] == true,
                onChanged: (val) => _updateActiveField((f) => f['unique'] = val),
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Validation Rules (Min / Max Length)
          if (hasValidation) ...[
            const Text('Validation Constraints', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _minLengthCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Min Length',
                      isDense: true,
                    ),
                    onChanged: (val) {
                      _updateActiveField((f) {
                        f['validation'] ??= <String, dynamic>{};
                        final parsed = int.tryParse(val);
                        if (parsed != null) {
                          f['validation']['minLength'] = parsed;
                        } else {
                          (f['validation'] as Map).remove('minLength');
                        }
                      });
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _maxLengthCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Max Length',
                      isDense: true,
                    ),
                    onChanged: (val) {
                      _updateActiveField((f) {
                        f['validation'] ??= <String, dynamic>{};
                        final parsed = int.tryParse(val);
                        if (parsed != null) {
                          f['validation']['maxLength'] = parsed;
                        } else {
                          (f['validation'] as Map).remove('maxLength');
                        }
                      });
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
          ],

          // Options List Management (dropdown, radio, checkbox)
          if (hasOptions) ...[
            Row(
              children: [
                const Text('Choice Options', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                const Spacer(),
                TextButton.icon(
                  onPressed: () {
                    _updateActiveField((f) {
                      final opts = (f['options'] as List? ?? []).cast<Map<String, dynamic>>();
                      final idx = opts.length + 1;
                      opts.add({
                        'id': 'opt_${DateTime.now().millisecondsSinceEpoch}',
                        'label': 'Option $idx',
                        'value': 'opt_$idx',
                      });
                      f['options'] = opts;
                    });
                  },
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('Add Option', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            ...((field['options'] as List? ?? []).asMap().entries.map((entry) {
              final idx = entry.key;
              final opt = entry.value as Map<String, dynamic>;
              return Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        initialValue: opt['label'] ?? '',
                        decoration: const InputDecoration(
                          labelText: 'Label',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                        ),
                        onChanged: (val) => _updateActiveField((f) {
                          final opts = f['options'] as List;
                          opts[idx]['label'] = val;
                        }),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextFormField(
                        initialValue: opt['value'] ?? '',
                        decoration: const InputDecoration(
                          labelText: 'Value',
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                        ),
                        onChanged: (val) => _updateActiveField((f) {
                          final opts = f['options'] as List;
                          opts[idx]['value'] = val;
                        }),
                      ),
                    ),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.delete_outline, size: 18, color: AppColors.danger),
                      onPressed: () => _updateActiveField((f) {
                        final opts = f['options'] as List;
                        opts.removeAt(idx);
                      }),
                    ),
                  ],
                ),
              );
            })),
          ],

          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: 12),
              ),
              onPressed: () => setState(() => _activeTab = 'canvas'),
              child: const Text('Done & Return to Canvas', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  // ==========================================
  // TAB 4: SETTINGS
  // ==========================================
  Widget _buildSettingsTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Form Configuration', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
          const SizedBox(height: 16),
          const Text('Template Name', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
          const SizedBox(height: 6),
          TextField(
            controller: _formNameCtrl,
            decoration: const InputDecoration(
              hintText: 'e.g. Standard Applicant Onboarding Form',
              isDense: true,
            ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Require Role Selection on Form', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
              subtitle: const Text('When checked, applicants can request a specific role during registration (e.g. Gatesman, Section Master). Admins can approve or alter it.', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
              value: _allowRoles,
              onChanged: (val) => setState(() => _allowRoles = val),
            ),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(vertical: 12),
              ),
              onPressed: () => setState(() => _activeTab = 'canvas'),
              icon: const Icon(Icons.view_agenda_outlined, size: 18),
              label: const Text('Return to Canvas', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
          ),
        ],
      ),
    );
  }

  // ==========================================
  // INTERACTIVE LIVE PREVIEW MODAL
  // ==========================================
  void _openLivePreviewModal() {
    final errors = _validateBuilder();
    setState(() => _builderErrors = errors);

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _LivePreviewSheet(
        fields: _fields,
        allowRoles: _allowRoles,
        roles: _systemRoles,
        validationErrors: errors,
      ),
    );
  }
}

/// Simulated Live Interactive Registration Form
class _LivePreviewSheet extends StatefulWidget {
  final List<Map<String, dynamic>> fields;
  final bool allowRoles;
  final List<dynamic> roles;
  final List<String> validationErrors;

  const _LivePreviewSheet({
    required this.fields,
    required this.allowRoles,
    required this.roles,
    required this.validationErrors,
  });

  @override
  State<_LivePreviewSheet> createState() => _LivePreviewSheetState();
}

class _LivePreviewSheetState extends State<_LivePreviewSheet> {
  final Map<String, dynamic> _formData = {};
  final _formKey = GlobalKey<FormState>();
  String? _selectedRole;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: MediaQuery.of(context).size.height * 0.90,
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
        children: [
          // Drag indicator handle
          const SizedBox(height: 10),
          Center(
            child: Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(color: const Color(0xFFCBD5E1), borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const SizedBox(height: 10),

          // Top Header Bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(color: const Color(0xFFEFF6FF), borderRadius: BorderRadius.circular(8)),
                  child: const Icon(Icons.phone_android, size: 20, color: AppColors.primary),
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Live Registration Preview', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Color(0xFF0F172A))),
                      Text('Dynamic form simulation & applicant validation check', style: TextStyle(fontSize: 11, color: Color(0xFF64748B))),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: Color(0xFFE2E8F0)),

          // Body
          Expanded(
            child: Form(
              key: _formKey,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (widget.validationErrors.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(bottom: 14),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFEF2F2),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFFECACA)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.danger),
                              SizedBox(width: 6),
                              Text('Schema Validation Warnings:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.danger)),
                            ],
                          ),
                          const SizedBox(height: 4),
                          ...widget.validationErrors.map((e) => Text('• $e', style: const TextStyle(fontSize: 11, color: Color(0xFF991B1B)))),
                        ],
                      ),
                    ),

                  // Fields rendering
                  ...widget.fields.map((f) => _renderFieldWidget(f)),

                  // Role selector (if allowed)
                  if (widget.allowRoles) ...[
                    const SizedBox(height: 8),
                    const Text('Requested Role', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      initialValue: _selectedRole,
                      decoration: const InputDecoration(
                        hintText: 'Select requested role',
                        isDense: true,
                      ),
                      items: widget.roles.map((r) {
                        final rName = (r['name'] ?? 'Role').toString();
                        return DropdownMenuItem<String>(value: rName, child: Text(rName));
                      }).toList(),
                      onChanged: (val) => setState(() => _selectedRole = val),
                    ),
                    const SizedBox(height: 16),
                  ],

                  const SizedBox(height: 16),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF16A34A),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    onPressed: () {
                      if (_formKey.currentState?.validate() ?? false) {
                        final filledCount = _formData.values.where((v) => v != null && v.toString().isNotEmpty).length;
                        AppFeedback.showSuccess(
                          context,
                          'Preview Form Submitted! Form validation and data capture verified ($filledCount fields captured).',
                        );
                      } else {
                        AppFeedback.showError(context, 'Please complete all required fields properly.');
                      }
                    },
                    child: const Text('Submit Application (Test)', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14)),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _renderFieldWidget(Map<String, dynamic> field) {
    final type = (field['type'] ?? 'text').toString();
    final label = (field['label'] ?? 'Field').toString();
    final name = (field['name'] ?? field['id']).toString();
    final isReq = field['required'] == true;
    final placeholder = field['placeholder']?.toString();
    final helper = field['helperText']?.toString();

    if (type == 'section') {
      final children = (field['children'] as List? ?? []).cast<Map<String, dynamic>>();
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFFF8FAFC),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.folder_outlined, size: 18, color: AppColors.primary),
                const SizedBox(width: 8),
                Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A))),
              ],
            ),
            if (helper != null && helper.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(helper, style: const TextStyle(fontSize: 11, color: Color(0xFF64748B))),
            ],
            const Divider(height: 16),
            ...children.map((c) => _renderFieldWidget(c)),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF334155))),
              if (isReq) ...[
                const SizedBox(width: 4),
                const Text('*', style: TextStyle(color: AppColors.danger, fontWeight: FontWeight.bold)),
              ],
            ],
          ),
          const SizedBox(height: 4),

          // Field types handling
          if (type == 'textarea')
            TextFormField(
              maxLines: 3,
              decoration: InputDecoration(
                hintText: placeholder,
                helperText: helper,
                isDense: true,
              ),
              validator: isReq ? (v) => (v == null || v.trim().isEmpty) ? 'Required' : null : null,
              onChanged: (v) => _formData[name] = v,
            )
          else if (type == 'password')
            TextFormField(
              obscureText: true,
              decoration: InputDecoration(
                hintText: placeholder ?? 'Enter password',
                helperText: helper,
                isDense: true,
              ),
              validator: isReq ? (v) => (v == null || v.trim().isEmpty) ? 'Required' : null : null,
              onChanged: (v) => _formData[name] = v,
            )
          else if (type == 'number')
            TextFormField(
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                hintText: placeholder,
                helperText: helper,
                isDense: true,
              ),
              validator: isReq ? (v) => (v == null || v.trim().isEmpty) ? 'Required' : null : null,
              onChanged: (v) => _formData[name] = v,
            )
          else if (type == 'dropdown')
            DropdownButtonFormField<String>(
              decoration: InputDecoration(
                hintText: placeholder ?? 'Choose an option',
                helperText: helper,
                isDense: true,
              ),
              items: (field['options'] as List? ?? []).map((opt) {
                final o = opt as Map<String, dynamic>;
                return DropdownMenuItem<String>(
                  value: o['value']?.toString(),
                  child: Text(o['label']?.toString() ?? ''),
                );
              }).toList(),
              validator: isReq ? (v) => (v == null || v.isEmpty) ? 'Please select an option' : null : null,
              onChanged: (v) => setState(() => _formData[name] = v),
            )
          else if (type == 'radio')
            Column(
              children: (field['options'] as List? ?? []).map((opt) {
                final o = opt as Map<String, dynamic>;
                final val = o['value']?.toString();
                final isSelected = _formData[name] == val;
                return InkWell(
                  onTap: () => setState(() => _formData[name] = val),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Icon(isSelected ? Icons.radio_button_checked : Icons.radio_button_off, size: 18, color: isSelected ? AppColors.primary : Colors.grey),
                        const SizedBox(width: 8),
                        Text(o['label']?.toString() ?? '', style: const TextStyle(fontSize: 13)),
                      ],
                    ),
                  ),
                );
              }).toList(),
            )
          else if (type == 'checkbox')
            Column(
              children: (field['options'] as List? ?? []).map((opt) {
                final o = opt as Map<String, dynamic>;
                final val = o['value']?.toString() ?? '';
                final currentList = (_formData[name] as List<String>?) ?? [];
                final isChecked = currentList.contains(val);
                return InkWell(
                  onTap: () {
                    setState(() {
                      if (isChecked) {
                        currentList.remove(val);
                      } else {
                        currentList.add(val);
                      }
                      _formData[name] = currentList;
                    });
                  },
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Icon(isChecked ? Icons.check_box : Icons.check_box_outline_blank, size: 18, color: isChecked ? AppColors.primary : Colors.grey),
                        const SizedBox(width: 8),
                        Text(o['label']?.toString() ?? '', style: const TextStyle(fontSize: 13)),
                      ],
                    ),
                  ),
                );
              }).toList(),
            )
          else if (type == 'date')
            InkWell(
              onTap: () async {
                final picked = await showDatePicker(
                  context: context,
                  initialDate: DateTime.now(),
                  firstDate: DateTime(1950),
                  lastDate: DateTime(2050),
                );
                if (picked != null) {
                  setState(() {
                    _formData[name] = '${picked.year}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
                  });
                }
              },
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFFCBD5E1)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.calendar_today_outlined, size: 18, color: Color(0xFF64748B)),
                    const SizedBox(width: 10),
                    Text(
                      _formData[name] ?? placeholder ?? 'Select Date',
                      style: TextStyle(fontSize: 13, color: _formData[name] != null ? const Color(0xFF0F172A) : const Color(0xFF94A3B8)),
                    ),
                  ],
                ),
              ),
            )
          else if (type == 'image')
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFCBD5E1), style: BorderStyle.solid),
                color: const Color(0xFFF8FAFC),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.camera_alt_outlined, size: 22, color: AppColors.primary),
                  const SizedBox(width: 10),
                  Text(placeholder ?? 'Capture Photo or Choose ID File', style: const TextStyle(fontSize: 13, color: AppColors.primary, fontWeight: FontWeight.w600)),
                ],
              ),
            )
          else
            TextFormField(
              decoration: InputDecoration(
                hintText: placeholder,
                helperText: helper,
                isDense: true,
              ),
              validator: isReq ? (v) => (v == null || v.trim().isEmpty) ? 'Required' : null : null,
              onChanged: (v) => _formData[name] = v,
            ),
        ],
      ),
    );
  }
}

/// Helper shadow class to avoid deprecation warnings
class BoxSideShadow extends BoxShadow {
  const BoxSideShadow({
    super.color,
    super.offset,
    super.blurRadius,
  });
}
