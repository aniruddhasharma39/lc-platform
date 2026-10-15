import { prisma } from './prisma';

export interface UniquenessConflict {
  field: string;
  label: string;
  value: string;
  source: 'ACTIVE_USER' | 'PENDING_REQUEST';
  details?: string;
}

export interface UniquenessValidationResult {
  isValid: boolean;
  error?: string;
  conflicts: UniquenessConflict[];
}

/**
 * Validates that all fields marked as 'unique' (as well as fundamental primary identity
 * fields like Phone/Mobile, Email, and Employee ID) do not collide with any active user
 * or pending registration request.
 */
export async function validateRegistrationUniqueness(
  rawSchema: any,
  formData: Record<string, any>
): Promise<UniquenessValidationResult> {
  const conflicts: UniquenessConflict[] = [];

  // Parse schema if it's a string
  let schemaObj: any = rawSchema;
  if (typeof rawSchema === 'string') {
    try {
      schemaObj = JSON.parse(rawSchema);
    } catch {
      schemaObj = { fields: [] };
    }
  }

  // Recursively extract all fields
  const allFields: any[] = [];
  const walkFields = (fieldsList: any[]) => {
    for (const f of fieldsList || []) {
      if (f.type === 'section' && Array.isArray(f.children)) {
        walkFields(f.children);
      } else {
        allFields.push(f);
      }
    }
  };
  walkFields(Array.isArray(schemaObj) ? schemaObj : (schemaObj?.fields || []));

  // Identify which fields must be unique
  const uniqueFields: any[] = [];
  for (const f of allFields) {
    const isExplicitlyUnique = Boolean(f.unique);
    const isPhone = f.type === 'phone' || f.name === 'mobile' || f.name === 'phone' || (f.label && f.label.toLowerCase().includes('mobile'));
    const isEmail = f.type === 'email' || f.name === 'email' || (f.label && f.label.toLowerCase().includes('email'));
    const isEmpId = f.name === 'employeeId' || (f.label && (f.label.toLowerCase().includes('employee id') || f.label.toLowerCase().includes('emp id')));

    if (isExplicitlyUnique || isPhone || isEmail || isEmpId) {
      uniqueFields.push(f);
    }
  }

  // Also check if formData has mobile, email, or employeeId even if not in schema fields
  const standardKeys = [
    { name: 'mobile', label: 'Mobile Number', type: 'phone' },
    { name: 'email', label: 'Email Address', type: 'email' },
    { name: 'employeeId', label: 'Employee ID', type: 'text' }
  ];
  for (const std of standardKeys) {
    if (formData[std.name] && !uniqueFields.some(u => u.name === std.name)) {
      uniqueFields.push(std);
    }
  }

  // Pre-fetch all active users and pending requests for comparison
  const [activeUsers, pendingRequests] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        mobile: true,
        email: true,
        employeeId: true,
        metadata: true,
      }
    }),
    prisma.registrationRequest.findMany({
      where: { status: 'PENDING' },
      select: {
        id: true,
        data: true,
      }
    })
  ]);

  for (const f of uniqueFields) {
    // Determine submitted value for this field
    let val = formData[f.name];
    if (val === undefined && f.id) val = formData[f.id];
    if (val === undefined && f.label) val = formData[f.label];

    // Check common fallbacks
    if (val === undefined) {
      if (f.type === 'phone' || f.name === 'mobile' || f.name === 'phone') {
        val = formData.mobile || formData.phone || formData.contact;
      } else if (f.type === 'email' || f.name === 'email') {
        val = formData.email;
      } else if (f.name === 'employeeId') {
        val = formData.employeeId || formData.empId;
      }
    }

    if (val === undefined || val === null) continue;
    const cleanVal = String(val).trim();
    if (!cleanVal) continue;

    const fieldLabel = f.label || f.name;
    const isPhoneField = f.type === 'phone' || f.name === 'mobile' || f.name === 'phone' || fieldLabel.toLowerCase().includes('mobile') || fieldLabel.toLowerCase().includes('phone');
    const isEmailField = f.type === 'email' || f.name === 'email' || fieldLabel.toLowerCase().includes('email');
    const isEmpIdField = f.name === 'employeeId' || fieldLabel.toLowerCase().includes('employee id') || fieldLabel.toLowerCase().includes('emp id');

    let conflictFound = false;

    // 1. Check against active users
    for (const u of activeUsers) {
      // Direct column checks
      if (isPhoneField && u.mobile && u.mobile === cleanVal) {
        conflicts.push({
          field: f.name,
          label: fieldLabel,
          value: cleanVal,
          source: 'ACTIVE_USER',
          details: `Matches mobile of registered user ${u.fullName}`
        });
        conflictFound = true;
        break;
      }

      if (isEmailField && u.email && u.email.toLowerCase() === cleanVal.toLowerCase()) {
        conflicts.push({
          field: f.name,
          label: fieldLabel,
          value: cleanVal,
          source: 'ACTIVE_USER',
          details: `Matches email of registered user ${u.fullName}`
        });
        conflictFound = true;
        break;
      }

      if (isEmpIdField && u.employeeId && u.employeeId.toLowerCase() === cleanVal.toLowerCase()) {
        conflicts.push({
          field: f.name,
          label: fieldLabel,
          value: cleanVal,
          source: 'ACTIVE_USER',
          details: `Matches employee ID of registered user ${u.fullName}`
        });
        conflictFound = true;
        break;
      }

      // Metadata check for custom unique fields (e.g., Aadhar, PAN, etc.)
      if (u.metadata) {
        try {
          const meta = JSON.parse(u.metadata);
          for (const [metaKey, metaVal] of Object.entries(meta)) {
            if (metaVal === undefined || metaVal === null) continue;
            const cleanMetaVal = String(metaVal).trim();
            const keyMatches = metaKey.toLowerCase() === fieldLabel.toLowerCase() || 
                               metaKey.toLowerCase() === (f.name || '').toLowerCase();
            
            if (keyMatches && cleanMetaVal.toLowerCase() === cleanVal.toLowerCase()) {
              conflicts.push({
                field: f.name,
                label: fieldLabel,
                value: cleanVal,
                source: 'ACTIVE_USER',
                details: `Matches ${metaKey} of registered user ${u.fullName}`
              });
              conflictFound = true;
              break;
            }
          }
          if (conflictFound) break;
        } catch {}
      }
    }

    if (conflictFound) continue;

    // 2. Check against pending registration requests
    for (const req of pendingRequests) {
      try {
        const reqData = JSON.parse(req.data);
        let reqVal = reqData[f.name];
        if (reqVal === undefined && f.id) reqVal = reqData[f.id];
        if (reqVal === undefined && f.label) reqVal = reqData[f.label];

        if (reqVal === undefined) {
          if (isPhoneField) reqVal = reqData.mobile || reqData.phone || reqData.contact;
          else if (isEmailField) reqVal = reqData.email;
          else if (isEmpIdField) reqVal = reqData.employeeId || reqData.empId;
        }

        if (reqVal !== undefined && reqVal !== null) {
          const cleanReqVal = String(reqVal).trim();
          if (cleanReqVal && cleanReqVal.toLowerCase() === cleanVal.toLowerCase()) {
            conflicts.push({
              field: f.name,
              label: fieldLabel,
              value: cleanVal,
              source: 'PENDING_REQUEST',
              details: `Matches pending registration request #${req.id}`
            });
            break;
          }
        }
      } catch {}
    }
  }

  if (conflicts.length === 0) {
    return { isValid: true, conflicts: [] };
  }

  // Construct readable message
  let errorMsg = '';
  if (conflicts.length === 1) {
    const c = conflicts[0];
    if (c.source === 'ACTIVE_USER') {
      errorMsg = `A user with this ${c.label} ('${c.value}') already exists. Please log in or use a different ${c.label}.`;
    } else {
      errorMsg = `A registration request with this ${c.label} ('${c.value}') has already been submitted and is pending administrator approval.`;
    }
  } else {
    const items = conflicts.map(c => `${c.label} ('${c.value}')`).join(', ');
    errorMsg = `Registration not allowed: A user already exists with matching details (${items}). Each of these fields must be unique.`;
  }

  return {
    isValid: false,
    error: errorMsg,
    conflicts
  };
}
