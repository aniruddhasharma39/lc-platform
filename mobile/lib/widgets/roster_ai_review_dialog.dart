import 'dart:io';
import 'package:flutter/material.dart';
import '../main.dart';

class RosterAiReviewDialog extends StatefulWidget {
  final File? imageFile;
  final Map<String, dynamic> scanResult;
  final Function(Map<String, dynamic> reconciledData, bool publishNow) onApply;

  const RosterAiReviewDialog({
    super.key,
    required this.imageFile,
    required this.scanResult,
    required this.onApply,
  });

  @override
  State<RosterAiReviewDialog> createState() => _RosterAiReviewDialogState();
}

class _RosterAiReviewDialogState extends State<RosterAiReviewDialog> {
  bool _showImagePreview = false;
  late Map<String, dynamic> _gate;
  late String _weekStartDate;
  late String _weekEndDate;
  late List<dynamic> _shiftTimings;
  late List<Map<String, dynamic>> _staffRows;
  late List<dynamic> _candidateGatemen;

  final List<String> _daysOfWeek = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'
  ];

  @override
  void initState() {
    super.initState();
    _gate = Map<String, dynamic>.from(widget.scanResult['gate'] ?? {});
    _weekStartDate = widget.scanResult['weekStartDate'] ?? '';
    _weekEndDate = widget.scanResult['weekEndDate'] ?? '';
    _shiftTimings = List<dynamic>.from(widget.scanResult['shiftTimings'] ?? []);
    _candidateGatemen = List<dynamic>.from(widget.scanResult['candidateGatemen'] ?? []);

    final rawRows = (widget.scanResult['staffRows'] as List?) ?? [];
    _staffRows = rawRows.map((r) {
      final copy = Map<String, dynamic>.from(r as Map);
      copy['schedule'] = Map<String, String>.from((r['schedule'] as Map?) ?? {});
      if (r['matchedUser'] != null) {
        copy['matchedUser'] = Map<String, dynamic>.from(r['matchedUser'] as Map);
      }
      return copy;
    }).toList();
  }

  Map<String, Color> _getShiftColors(String code) {
    if (code == 'W/R') {
      return {'text': const Color(0xFFB45309), 'bg': const Color(0xFFFEF3C7)};
    } else if (code == 'N/R') {
      return {'text': const Color(0xFFC2410C), 'bg': const Color(0xFFFFEDD5)};
    } else if (code == '-') {
      return {'text': const Color(0xFF64748B), 'bg': const Color(0xFFF1F5F9)};
    }

    if (code.startsWith('06') || code.startsWith('07') || code.startsWith('08')) {
      return {'text': const Color(0xFF15803D), 'bg': const Color(0xFFDCFCE7)}; // Green (Day/Morning)
    } else if (code.startsWith('14') || code.startsWith('12') || code.startsWith('16')) {
      return {'text': const Color(0xFFB45309), 'bg': const Color(0xFFFEF3C7)}; // Amber (Evening)
    } else if (code.startsWith('22') || code.startsWith('20') || code.startsWith('00')) {
      return {'text': const Color(0xFF4338CA), 'bg': const Color(0xFFEEF2FF)}; // Indigo (Night)
    }

    return {'text': const Color(0xFF0369A1), 'bg': const Color(0xFFE0F2FE)}; // Blue fallback
  }

  void _showCodePicker(int rowIndex, String day) {
    final currentCode = _staffRows[rowIndex]['schedule'][day] ?? '-';

    final options = <Map<String, String>>[];
    for (final st in _shiftTimings) {
      final code = (st['code'] ?? '').toString();
      final name = (st['name'] ?? 'Shift').toString();
      final start = (st['startTime'] ?? '').toString();
      final end = (st['endTime'] ?? '').toString();
      options.add({
        'code': code,
        'label': '$name ($start - $end)',
        'type': 'SHIFT',
      });
    }

    // Always ensure standard options exist
    if (!options.any((o) => o['code'] == '06-14')) {
      options.add({'code': '06-14', 'label': 'Morning Shift (06:00 - 14:00)', 'type': 'SHIFT'});
    }
    if (!options.any((o) => o['code'] == '14-22')) {
      options.add({'code': '14-22', 'label': 'Evening Shift (14:00 - 22:00)', 'type': 'SHIFT'});
    }
    if (!options.any((o) => o['code'] == '22-06')) {
      options.add({'code': '22-06', 'label': 'Night Shift (22:00 - 06:00)', 'type': 'SHIFT'});
    }

    options.add({'code': 'W/R', 'label': 'Weekly Rest (W/R)', 'type': 'REST'});
    options.add({'code': 'N/R', 'label': 'Night Rest (N/R)', 'type': 'REST'});
    options.add({'code': '-', 'label': 'Off / Not Assigned (-)', 'type': 'OFF'});

    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Select Shift for $day',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: Color(0xFF0F172A)),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: () => Navigator.pop(ctx),
                      visualDensity: VisualDensity.compact,
                    ),
                  ],
                ),
                const Divider(),
                ...options.map((opt) {
                  final isSelected = opt['code'] == currentCode;
                  final colors = _getShiftColors(opt['code']!);
                  return ListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 0),
                    leading: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: colors['bg'],
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: colors['text']!.withValues(alpha: 0.4)),
                      ),
                      child: Text(
                        opt['code']!,
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: colors['text']),
                      ),
                    ),
                    title: Text(
                      opt['label']!,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                        color: isSelected ? AppColors.primary : const Color(0xFF1E293B),
                      ),
                    ),
                    trailing: isSelected ? const Icon(Icons.check_circle, color: AppColors.primary, size: 20) : null,
                    onTap: () {
                      setState(() {
                        _staffRows[rowIndex]['schedule'][day] = opt['code']!;
                      });
                      Navigator.pop(ctx);
                    },
                  );
                }),
              ],
            ),
          ),
        );
      },
    );
  }

  void _onReassignUser(int rowIndex, int newUserId) {
    final cand = _candidateGatemen.firstWhere((c) => c['id'] == newUserId, orElse: () => null);
    if (cand != null) {
      setState(() {
        _staffRows[rowIndex]['matchedUser'] = {
          'id': cand['id'],
          'fullName': cand['fullName'],
          'employeeId': cand['employeeId'],
          'designation': cand['designation'],
          'role': cand['role'],
          'pmeStatus': cand['pmeStatus'],
          'rcStatus': cand['rcStatus'],
        };
        _staffRows[rowIndex]['matchConfidence'] = 1.0;
      });
    }
  }

  void _handleApply({required bool publishNow}) {
    final reconciledResult = {
      ...widget.scanResult,
      'gate': _gate,
      'weekStartDate': _weekStartDate,
      'weekEndDate': _weekEndDate,
      'staffRows': _staffRows,
    };
    widget.onApply(reconciledResult, publishNow);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final lcNumber = _gate['lcNumber'] ?? 'LC Gate';
    final location = _gate['locationName'] ?? '';
    final stationName = _gate['stationName'] ?? '';

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 20),
      backgroundColor: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.88,
          maxWidth: 600,
        ),
        child: Column(
          children: [
            // 1. Dialog Header
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: const BoxDecoration(
                color: Color(0xFF0F172A),
                borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
              ),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: const Color(0xFF10B981).withValues(alpha: 0.2),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.auto_awesome, color: Color(0xFF10B981), size: 20),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Text(
                              'AI Roster Review',
                              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFF10B981),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: const Text('Gemini 3.5 Flash', style: TextStyle(color: Colors.white, fontSize: 9.5, fontWeight: FontWeight.w800)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Verified from PWI / CPWI Physical Chart',
                          style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 11.5),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, color: Colors.white70, size: 22),
                    onPressed: () => Navigator.of(context).pop(),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
            ),

            // 2. Scrollable Body
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Matched Gate & Week Info Card
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: const Color(0xFFE2E8F0)),
                      ),
                      child: Column(
                        children: [
                          Row(
                            children: [
                              const Icon(Icons.location_on_rounded, size: 18, color: AppColors.primary),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  '$lcNumber - ${location.isNotEmpty ? location : stationName}',
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5, color: Color(0xFF0F172A)),
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFDCFCE7),
                                  borderRadius: BorderRadius.circular(4),
                                  border: Border.all(color: const Color(0xFF86EFAC)),
                                ),
                                child: const Text('Matched Gate', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF15803D))),
                              ),
                            ],
                          ),
                          const Divider(height: 14),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  const Icon(Icons.calendar_today_outlined, size: 14, color: Color(0xFF64748B)),
                                  const SizedBox(width: 5),
                                  Text(
                                    'Week: $_weekStartDate to $_weekEndDate',
                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF334155)),
                                  ),
                                ],
                              ),
                              if (widget.imageFile != null)
                                InkWell(
                                  onTap: () => setState(() => _showImagePreview = !_showImagePreview),
                                  child: Row(
                                    children: [
                                      Icon(_showImagePreview ? Icons.visibility_off_outlined : Icons.visibility_outlined, size: 14, color: AppColors.primary),
                                      const SizedBox(width: 4),
                                      Text(
                                        _showImagePreview ? 'Hide Photo' : 'View Photo',
                                        style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.primary),
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),

                    // Expandable Photo Preview
                    if (_showImagePreview && widget.imageFile != null) ...[
                      const SizedBox(height: 10),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Container(
                          constraints: const BoxConstraints(maxHeight: 220),
                          width: double.infinity,
                          decoration: BoxDecoration(
                            border: Border.all(color: const Color(0xFFCBD5E1)),
                          ),
                          child: Image.file(
                            widget.imageFile!,
                            fit: BoxFit.contain,
                          ),
                        ),
                      ),
                    ],

                    const SizedBox(height: 14),

                    // Detected Shift Timings Bar
                    if (_shiftTimings.isNotEmpty) ...[
                      const Text(
                        'Detected Shift Timings:',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF475569)),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: _shiftTimings.map((st) {
                          final code = st['code'] ?? '';
                          final name = st['name'] ?? '';
                          final start = st['startTime'] ?? '';
                          final end = st['endTime'] ?? '';
                          final colors = _getShiftColors(code);
                          return Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: colors['bg'],
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: colors['text']!.withValues(alpha: 0.3)),
                            ),
                            child: Text(
                              '$name ($start-$end) [$code]',
                              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: colors['text']),
                            ),
                          );
                        }).toList(),
                      ),
                      const SizedBox(height: 14),
                    ],

                    // Staff Reconciliation Cards
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'Staff Assignments (${_staffRows.length}):',
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF0F172A)),
                        ),
                        const Text(
                          'Tap any day chip to edit shift',
                          style: TextStyle(fontSize: 10.5, color: Color(0xFF64748B), fontStyle: FontStyle.italic),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),

                    ..._staffRows.asMap().entries.map((entry) {
                      final rowIndex = entry.key;
                      final row = entry.value;
                      final rawName = row['rawName'] ?? 'Gateman';
                      final rawDesig = row['rawDesignation'] ?? '';
                      final matchedUser = row['matchedUser'];
                      final confidence = (row['matchConfidence'] ?? 0.0) as num;
                      final isHighConfidence = confidence >= 0.85;

                      final schedule = (row['schedule'] as Map<String, String>?) ?? {};

                      return Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: isHighConfidence ? const Color(0xFFE2E8F0) : const Color(0xFFFDE68A), width: isHighConfidence ? 1 : 1.5),
                          boxShadow: [
                            BoxShadow(color: Colors.black.withValues(alpha: 0.03), blurRadius: 4, offset: const Offset(0, 2)),
                          ],
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            // Staff Card Header
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                              decoration: BoxDecoration(
                                color: isHighConfidence ? const Color(0xFFF8FAFC) : const Color(0xFFFFFBEB),
                                borderRadius: const BorderRadius.vertical(top: Radius.circular(9)),
                              ),
                              child: Row(
                                children: [
                                  CircleAvatar(
                                    radius: 13,
                                    backgroundColor: isHighConfidence ? const Color(0xFF0284C7) : const Color(0xFFD97706),
                                    child: Text(
                                      rawName.isNotEmpty ? rawName[0].toUpperCase() : 'G',
                                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'Sheet: $rawName ${rawDesig.isNotEmpty ? "($rawDesig)" : ""}',
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Color(0xFF0F172A)),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ],
                                    ),
                                  ),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: isHighConfidence ? const Color(0xFFDCFCE7) : const Color(0xFFFEF3C7),
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      isHighConfidence ? '${(confidence * 100).toInt()}% Match' : 'Review Match',
                                      style: TextStyle(
                                        fontSize: 9.5,
                                        fontWeight: FontWeight.bold,
                                        color: isHighConfidence ? const Color(0xFF15803D) : const Color(0xFFB45309),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),

                            // Mapped User Selector
                            Padding(
                              padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
                              child: Row(
                                children: [
                                  const Text('Assign to: ', style: TextStyle(fontSize: 11.5, color: Color(0xFF64748B))),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: DropdownButton<int>(
                                      value: matchedUser?['id'] as int?,
                                      isDense: true,
                                      isExpanded: true,
                                      underline: const SizedBox(),
                                      hint: const Text('Select active Gateman', style: TextStyle(fontSize: 12, color: Colors.red)),
                                      items: _candidateGatemen.map<DropdownMenuItem<int>>((c) {
                                        final name = c['fullName'] ?? 'Unknown';
                                        final empId = c['employeeId'] ?? '';
                                        final desig = c['designation'] ?? 'Gateman';
                                        return DropdownMenuItem<int>(
                                          value: c['id'] as int,
                                          child: Text(
                                            '$name ($desig${empId.isNotEmpty ? " • $empId" : ""})',
                                            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF0F172A)),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        );
                                      }).toList(),
                                      onChanged: (val) {
                                        if (val != null) _onReassignUser(rowIndex, val);
                                      },
                                    ),
                                  ),
                                ],
                              ),
                            ),

                            // Daily Shift Chips (Sunday to Saturday)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(8, 4, 8, 10),
                              child: SingleChildScrollView(
                                scrollDirection: Axis.horizontal,
                                child: Row(
                                  children: _daysOfWeek.map((day) {
                                    final code = schedule[day] ?? '-';
                                    final colors = _getShiftColors(code);
                                    final dayAbbr = day.substring(0, 3);

                                    return Padding(
                                      padding: const EdgeInsets.symmetric(horizontal: 3),
                                      child: InkWell(
                                        onTap: () => _showCodePicker(rowIndex, day),
                                        borderRadius: BorderRadius.circular(6),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
                                          decoration: BoxDecoration(
                                            color: colors['bg'],
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: colors['text']!.withValues(alpha: 0.35)),
                                          ),
                                          child: Column(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Text(
                                                dayAbbr,
                                                style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.bold, color: Color(0xFF475569)),
                                              ),
                                              const SizedBox(height: 2),
                                              Text(
                                                code,
                                                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: colors['text']),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    );
                                  }).toList(),
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),

            // 3. Dialog Actions Footer
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: const Color(0xFFF8FAFC),
                borderRadius: const BorderRadius.vertical(bottom: Radius.circular(16)),
                border: Border(top: BorderSide(color: Colors.grey.shade200)),
              ),
              child: Row(
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    style: TextButton.styleFrom(foregroundColor: const Color(0xFF64748B)),
                    child: const Text('Discard', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  ),
                  const Spacer(),
                  OutlinedButton.icon(
                    onPressed: () => _handleApply(publishNow: false),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.primary,
                      side: const BorderSide(color: AppColors.primary),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    icon: const Icon(Icons.table_chart_outlined, size: 16),
                    label: const Text('Apply to Chart', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton.icon(
                    onPressed: () => _handleApply(publishNow: true),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF10B981),
                      foregroundColor: Colors.white,
                      elevation: 0,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    ),
                    icon: const Icon(Icons.send_rounded, size: 16),
                    label: const Text('Apply & Publish', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12.5)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
