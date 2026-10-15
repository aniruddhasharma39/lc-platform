import { prisma } from './prisma';

export interface ExtractedRegistrationFields {
  email?: string;
  mobile?: string;
  employeeId?: string;
  fullName?: string;
  department?: string;
}

export function extractRegistrationUserFields(
  formData: Record<string, any>,
  formSchemaStr?: string | null
): ExtractedRegistrationFields {
  let schema: any = null;
  if (formSchemaStr) {
    try {
      schema = typeof formSchemaStr === 'string' ? JSON.parse(formSchemaStr) : formSchemaStr;
    } catch (_) {}
  }

  const allFields: any[] = [];
  const walk = (fields: any[]) => {
    if (!fields || !Array.isArray(fields)) return;
    for (const f of fields) {
      if (f.type === 'section' && f.children) walk(f.children);
      else allFields.push(f);
    }
  };
  if (schema?.fields) walk(schema.fields);
  else if (Array.isArray(schema)) walk(schema);

  const extract = (typeOrFieldKeywords: string[], labelKeywords: string[]): string | undefined => {
    // 1. Direct key match in formData (normalized alphanumeric)
    const normKeys = Object.keys(formData).map(k => ({
      orig: k,
      norm: k.toLowerCase().replace(/[^a-z0-9]/g, '')
    }));

    for (const kw of typeOrFieldKeywords) {
      const normKw = kw.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matched = normKeys.find(k => k.norm === normKw);
      if (matched && formData[matched.orig] !== undefined && formData[matched.orig] !== null) {
        const val = String(formData[matched.orig]).trim();
        if (val.length > 0) return val;
      }
    }

    // 2. Schema field type match
    for (const f of allFields) {
      if (typeOrFieldKeywords.includes(f.type) && formData[f.name] !== undefined && formData[f.name] !== null) {
        const val = String(formData[f.name]).trim();
        if (val.length > 0) return val;
      }
    }

    // 3. Schema field label keyword match
    for (const f of allFields) {
      const normLabel = (f.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const lKw of labelKeywords) {
        const normLkw = lKw.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normLabel.includes(normLkw)) {
          if (formData[f.name] !== undefined && formData[f.name] !== null) {
            const val = String(formData[f.name]).trim();
            if (val.length > 0) return val;
          }
        }
      }
    }

    // 4. Substring key match as fallback
    for (const kw of typeOrFieldKeywords) {
      const normKw = kw.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matched = normKeys.find(k => k.norm.includes(normKw));
      if (matched && formData[matched.orig] !== undefined && formData[matched.orig] !== null) {
        const val = String(formData[matched.orig]).trim();
        if (val.length > 0) return val;
      }
    }

    return undefined;
  };

  const email = extract(
    ['email', 'emailaddress', 'useremail'],
    ['email']
  );

  const rawMobile = extract(
    ['mobile', 'mobilenumber', 'phone', 'phonenumber', 'contact', 'contactnumber'],
    ['mobile', 'phone', 'contact']
  );
  const mobile = rawMobile ? rawMobile.replace(/\D/g, '').slice(-10) : undefined;

  const employeeId = extract(
    ['employeeid', 'empid', 'badgenumber', 'badge', 'employee_id', 'emp_id'],
    ['employee', 'badge', 'emp id']
  );

  const fullName = extract(
    ['fullname', 'name', 'applicantname', 'username'],
    ['name', 'applicant']
  );

  const department = extract(
    ['department', 'dept', 'section', 'division'],
    ['department', 'dept', 'section', 'division']
  );

  return { email, mobile, employeeId, fullName, department };
}

export interface CheckUniquenessResult {
  hasConflict: boolean;
  conflictType?: 'email' | 'mobile' | 'employeeId';
  conflictSource?: 'active_user' | 'pending_request';
  errorMessage?: string;
}

export async function checkRegistrationUniqueness(
  fields: ExtractedRegistrationFields,
  excludeRequestId?: number,
  schemaStr?: string | null
): Promise<CheckUniquenessResult> {
  const { email, mobile, employeeId } = fields;

  // 1. Check existing active/approved Users in database
  if (email && email.trim().length > 0) {
    const existingByEmail = await prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } }
    });
    if (existingByEmail) {
      return {
        hasConflict: true,
        conflictType: 'email',
        conflictSource: 'active_user',
        errorMessage: `A user with email address "${email.trim()}" is already registered. Please login or use a different email.`
      };
    }
  }

  if (mobile && mobile.trim().length > 0) {
    const cleanMobile = mobile.replace(/\D/g, '').slice(-10);
    const existingByMobile = await prisma.user.findFirst({
      where: { mobile: cleanMobile }
    });
    if (existingByMobile) {
      return {
        hasConflict: true,
        conflictType: 'mobile',
        conflictSource: 'active_user',
        errorMessage: `A user with mobile number "${cleanMobile}" is already registered. Please login or use a different number.`
      };
    }
  }

  if (employeeId && employeeId.trim().length > 0) {
    const cleanEmpId = employeeId.trim();
    const existingByEmpId = await prisma.user.findFirst({
      where: { employeeId: { equals: cleanEmpId, mode: 'insensitive' } }
    });
    if (existingByEmpId) {
      return {
        hasConflict: true,
        conflictType: 'employeeId',
        conflictSource: 'active_user',
        errorMessage: `A user with Employee ID "${cleanEmpId}" is already registered. Please verify your Employee ID or contact support.`
      };
    }
  }

  // 2. Check pending registration requests
  const pendingRequests = await prisma.registrationRequest.findMany({
    where: {
      status: 'PENDING',
      ...(excludeRequestId ? { id: { not: excludeRequestId } } : {})
    },
    include: { form: true }
  });

  for (const pr of pendingRequests) {
    if (!pr.data) continue;
    try {
      const pData = JSON.parse(pr.data);
      const prSchema = pr.form?.schema || schemaStr;
      const pFields = extractRegistrationUserFields(pData, prSchema);

      if (email && pFields.email && pFields.email.trim().toLowerCase() === email.trim().toLowerCase()) {
        return {
          hasConflict: true,
          conflictType: 'email',
          conflictSource: 'pending_request',
          errorMessage: `A registration request with email address "${email.trim()}" is already submitted and pending administrator approval.`
        };
      }

      if (mobile && pFields.mobile) {
        const cleanExistingMobile = pFields.mobile.replace(/\D/g, '').slice(-10);
        const cleanMobile = mobile.replace(/\D/g, '').slice(-10);
        if (cleanExistingMobile === cleanMobile) {
          return {
            hasConflict: true,
            conflictType: 'mobile',
            conflictSource: 'pending_request',
            errorMessage: `A registration request with mobile number "${cleanMobile}" is already submitted and pending administrator approval.`
          };
        }
      }

      if (employeeId && pFields.employeeId && pFields.employeeId.trim().toLowerCase() === employeeId.trim().toLowerCase()) {
        return {
          hasConflict: true,
          conflictType: 'employeeId',
          conflictSource: 'pending_request',
          errorMessage: `A registration request with Employee ID "${employeeId.trim()}" is already submitted and pending administrator approval.`
        };
      }
    } catch (_) {}
  }

  return { hasConflict: false };
}
