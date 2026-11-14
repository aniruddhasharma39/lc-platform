import { prisma } from './prisma';
import { getExamCompliance } from '../routes/roster';

const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-2.0-flash'
];

export interface ExtractedShiftTiming {
  name: string;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  code: string;      // e.g. "06-14", "14-22", "22-06", "08-20"
}

export interface ExtractedStaffAssignment {
  rawName: string;
  designation?: string;
  employeeId?: string | null;
  schedule: Record<string, string>; // { "Sunday": "06-14", "Monday": "W/R", ... }
}

export interface ExtractedRosterJson {
  gate?: {
    lcNumber?: string;
    stationName?: string;
    stationCode?: string;
    division?: string;
  };
  week?: {
    startDate?: string;
    endDate?: string;
    rawDateText?: string;
  };
  shiftTimings?: ExtractedShiftTiming[];
  staffAssignments?: ExtractedStaffAssignment[];
  authorities?: {
    preparedByPwi?: string;
    countersignedByCpwi?: string;
  };
  notes?: string;
}

export interface ReconciledStaffRow {
  rawName: string;
  rawDesignation?: string;
  rawEmployeeId?: string | null;
  matchedUser: {
    id: number;
    fullName: string;
    employeeId: string;
    mobile: string;
    email: string;
    designation: string;
    role: string;
    pmeExpiryDate: string | null;
    rcExpiryDate: string | null;
    pmeStatus: 'VALID' | 'DUE_SOON' | 'EXPIRED' | 'NOT_SET';
    rcStatus: 'VALID' | 'DUE_SOON' | 'EXPIRED' | 'NOT_SET';
    stationName?: string;
  } | null;
  matchConfidence: number; // 0.0 to 1.0
  schedule: Record<string, string>; // Sunday -> Saturday codes
  dateAssignments: Array<{
    date: string;
    dayOfWeek: string;
    shiftCode: string;
    startTime: string;
    endTime: string;
    shiftName: string;
  }>;
}

export interface ReconciledRosterResult {
  success: boolean;
  modelUsed: string;
  gate: {
    id: number;
    lcNumber: string;
    locationName: string;
    stationId: number | null;
    stationName: string;
    division: string;
    matchedBy: 'EXACT' | 'FUZZY' | 'FALLBACK';
  };
  weekStartDate: string;
  weekEndDate: string;
  days: Array<{ dayOfWeek: string; date: string }>;
  shiftTimings: ExtractedShiftTiming[];
  staffRows: ReconciledStaffRow[];
  candidateGatemen: Array<{
    id: number;
    fullName: string;
    employeeId: string;
    designation: string;
    role: string;
    pmeStatus: string;
    rcStatus: string;
  }>;
  authorities: {
    preparedByPwi: string;
    countersignedByCpwi: string;
  };
  rawExtraction: ExtractedRosterJson;
  warnings: string[];
}

/**
 * Calculates string similarity between two names (0.0 to 1.0)
 */
function calculateNameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const cleanA = a.toLowerCase().replace(/^(shri|mr|gateman|gk|restkeeper|rk)\.?\s+/i, '').replace(/[^a-z0-9\s]/g, '').trim();
  const cleanB = b.toLowerCase().replace(/^(shri|mr|gateman|gk|restkeeper|rk)\.?\s+/i, '').replace(/[^a-z0-9\s]/g, '').trim();

  if (cleanA === cleanB) return 1.0;
  if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return 0.92;

  const tokensA = new Set(cleanA.split(/\s+/).filter(Boolean));
  const tokensB = new Set(cleanB.split(/\s+/).filter(Boolean));

  let intersection = 0;
  tokensA.forEach(t => {
    if (tokensB.has(t)) intersection++;
  });

  const union = new Set([...tokensA, ...tokensB]).size;
  const tokenScore = union > 0 ? intersection / union : 0;

  // Levenshtein distance ratio
  const maxLen = Math.max(cleanA.length, cleanB.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(cleanA, cleanB);
  const levScore = 1 - dist / maxLen;

  return Math.max(tokenScore, levScore);
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Standardize shift codes from raw OCR values
 */
function normalizeShiftCode(rawCode: string | undefined): string {
  if (!rawCode) return '-';
  const c = rawCode.trim().toUpperCase();

  if (c === 'W/R' || c === 'WR' || c === 'REST' || c === 'WEEKLY REST' || c === 'R') return 'W/R';
  if (c === 'N/R' || c === 'NR' || c === 'NIGHT REST') return 'N/R';
  if (c === '-' || c === 'OFF' || c === 'RELIEF' || c === 'NIL' || c === 'NA') return '-';

  // Normalize HH-HH e.g. "6-14" -> "06-14", "14-22" -> "14-22"
  const match = c.match(/(\d{1,2})[\s\-:to]+(\d{1,2})/i);
  if (match) {
    const startH = match[1].padStart(2, '0');
    const endH = match[2].padStart(2, '0');
    return `${startH}-${endH}`;
  }

  return rawCode.trim();
}

/**
 * Calls Gemini Vision API with an image buffer to extract weekly roster data
 */
export async function analyzeRosterChartWithGemini(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg',
  options: {
    division?: string;
    hintGateId?: number;
    hintStationId?: number;
    weekStartDate?: string;
  } = {}
): Promise<ReconciledRosterResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  const base64Data = imageBuffer.toString('base64');

  const promptText = `
You are an expert Indian Railways Level Crossing (LC) Gate Duty Roster digitization engine.
Analyze the provided weekly duty roster chart image (Official LC Gate Duty Roster prepared by PWI / JE P-Way and countersigned by CPWI / SSE P-Way).
Extract all details with extreme precision into a JSON object conforming exactly to the schema.

Guidelines:
1. "gate": Identify LC Gate Number (e.g. "LC-30", "LC-40", "LC-91", "Gate 91"), Station Name (e.g. "Kasu", "Nagothane", "Danapur"), Station Code (e.g. "KASU", "NGTN", "DNR"), and Railway Division.
2. "week": Identify the 7-day week date range if indicated (Start Date and End Date in YYYY-MM-DD format). If year is missing, assume 2026. If only day/month is visible, calculate 7 days starting from Sunday.
3. "shiftTimings": Identify shift definitions (e.g. Morning 06:00-14:00, Evening 14:00-22:00, Night 22:00-06:00; or 12hr shifts 07:00-19:00, 19:00-07:00 / 08:00-20:00, 20:00-08:00).
   For each shift, provide name, startTime (HH:mm), endTime (HH:mm), and code (e.g. "06-14", "14-22", "22-06", "07-19", "08-20").
4. "staffAssignments": For each staff member in the table rows:
   - "rawName": full name as written on the sheet
   - "designation": "Gateman", "Restkeeper", "Relief Gateman", etc.
   - "employeeId": token or employee ID if present, otherwise null
   - "schedule": an object containing keys: "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday".
     Value MUST be:
     - Shift code (e.g. "06-14", "14-22", "22-06", "07-19", "08-20", "19-24", "00-07")
     - "W/R" for Weekly Rest
     - "N/R" for Night Rest
     - "-" for Off / Not scheduled
5. "authorities":
   - "preparedByPwi": signature or name of PWI / JE P-Way if indicated
   - "countersignedByCpwi": signature or name of CPWI / SSE P-Way if indicated

Return ONLY raw JSON in this exact structure:
{
  "gate": {
    "lcNumber": "LC-30",
    "stationName": "Kasu",
    "stationCode": "KASU",
    "division": "Mumbai CST"
  },
  "week": {
    "startDate": "2026-11-15",
    "endDate": "2026-11-21",
    "rawDateText": "15/11/2026 to 21/11/2026"
  },
  "shiftTimings": [
    { "name": "Morning Shift", "startTime": "06:00", "endTime": "14:00", "code": "06-14" },
    { "name": "Evening Shift", "startTime": "14:00", "endTime": "22:00", "code": "14-22" },
    { "name": "Night Shift", "startTime": "22:00", "endTime": "06:00", "code": "22-06" }
  ],
  "staffAssignments": [
    {
      "rawName": "Garv Pancholi",
      "designation": "Restkeeper",
      "employeeId": "1234",
      "schedule": {
        "Sunday": "06-14",
        "Monday": "06-14",
        "Tuesday": "06-14",
        "Wednesday": "W/R",
        "Thursday": "14-22",
        "Friday": "14-22",
        "Saturday": "14-22"
      }
    }
  ],
  "authorities": {
    "preparedByPwi": "Signed",
    "countersignedByCpwi": "Signed"
  },
  "notes": ""
}
`;

  let lastError: any = null;
  let rawJson: ExtractedRosterJson | null = null;
  let activeModel = GEMINI_MODELS[0];

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: promptText },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json'
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[GeminiVision] Model ${model} returned HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        lastError = new Error(`Model ${model} failed with HTTP ${response.status}`);
        continue;
      }

      const resData: any = await response.json();
      const text = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn(`[GeminiVision] Model ${model} returned empty candidate text.`);
        continue;
      }

      // Parse JSON safely
      const cleanJsonStr = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      rawJson = JSON.parse(cleanJsonStr);
      activeModel = model;
      break;
    } catch (err) {
      console.warn(`[GeminiVision] Error invoking model ${model}:`, err);
      lastError = err;
    }
  }

  if (!rawJson) {
    throw new Error(`Failed to extract roster using Gemini Vision: ${lastError?.message || 'No candidate response'}`);
  }

  // Database Reconciliation Engine
  return await reconcileRosterExtraction(rawJson, activeModel, options);
}

/**
 * Reconciles Gemini's raw extracted roster JSON against PostgreSQL database
 */
export async function reconcileRosterExtraction(
  raw: ExtractedRosterJson,
  modelUsed: string,
  options: {
    division?: string;
    hintGateId?: number;
    hintStationId?: number;
    weekStartDate?: string;
  }
): Promise<ReconciledRosterResult> {
  const warnings: string[] = [];

  // 1. Resolve LC Gate
  let matchedGate: any = null;
  let gateMatchMethod: 'EXACT' | 'FUZZY' | 'FALLBACK' = 'FALLBACK';

  const rawGateLc = raw.gate?.lcNumber || '';
  const digitsMatch = rawGateLc.match(/\d+/);
  const gateNumber = digitsMatch ? digitsMatch[0] : '';

  // Priority A: Match by extracted lcNumber
  if (rawGateLc) {
    matchedGate = await prisma.lCGate.findFirst({
      where: {
        OR: [
          { lcNumber: { equals: rawGateLc, mode: 'insensitive' } },
          { lcNumber: { contains: gateNumber, mode: 'insensitive' } },
          { name: { contains: rawGateLc, mode: 'insensitive' } }
        ]
      },
      include: {
        station: { select: { id: true, name: true, code: true, division: true } }
      }
    });
    if (matchedGate) {
      gateMatchMethod = 'EXACT';
    }
  }

  // Priority B: Match by hintGateId if supplied and not yet matched
  if (!matchedGate && options.hintGateId) {
    matchedGate = await prisma.lCGate.findUnique({
      where: { id: options.hintGateId },
      include: {
        station: { select: { id: true, name: true, code: true, division: true } }
      }
    });
    if (matchedGate) gateMatchMethod = 'FALLBACK';
  }

  // Priority C: Match first gate in hintStationId
  if (!matchedGate && options.hintStationId) {
    matchedGate = await prisma.lCGate.findFirst({
      where: { stationId: options.hintStationId },
      include: {
        station: { select: { id: true, name: true, code: true, division: true } }
      }
    });
    if (matchedGate) gateMatchMethod = 'FALLBACK';
  }

  // Priority D: Fallback to any gate in division
  if (!matchedGate) {
    matchedGate = await prisma.lCGate.findFirst({
      where: options.division ? {
        OR: [
          { division: { equals: options.division, mode: 'insensitive' } },
          { station: { division: { equals: options.division, mode: 'insensitive' } } }
        ]
      } : {},
      include: {
        station: { select: { id: true, name: true, code: true, division: true } }
      }
    });
  }

  if (!matchedGate) {
    throw new Error('Could not identify or associate any LC Gate in the system.');
  }

  const effectiveDivision = matchedGate.division || matchedGate.station?.division || options.division || 'Central Railway';

  // 2. Resolve Week Dates (Sunday through Saturday)
  let startDate: Date;
  if (options.weekStartDate && /^\d{4}-\d{2}-\d{2}$/.test(options.weekStartDate)) {
    startDate = new Date(options.weekStartDate + 'T00:00:00Z');
  } else if (raw.week?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(raw.week.startDate)) {
    startDate = new Date(raw.week.startDate + 'T00:00:00Z');
  } else {
    // Current week's Sunday
    const now = new Date();
    const day = now.getUTCDay(); // 0 = Sunday
    startDate = new Date(now);
    startDate.setUTCDate(now.getUTCDate() - day);
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekDays = dayNames.map((name, idx) => {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + idx);
    return {
      dayOfWeek: name,
      date: d.toISOString().split('T')[0]
    };
  });

  const weekStartDateStr = weekDays[0].date;
  const weekEndDateStr = weekDays[6].date;

  // 3. Resolve Shift Timings
  let shiftTimings: ExtractedShiftTiming[] = [];
  if (Array.isArray(raw.shiftTimings) && raw.shiftTimings.length > 0) {
    shiftTimings = raw.shiftTimings.map(s => ({
      name: s.name || 'Shift',
      startTime: s.startTime || '06:00',
      endTime: s.endTime || '14:00',
      code: normalizeShiftCode(s.code || `${s.startTime?.slice(0, 2)}-${s.endTime?.slice(0, 2)}`)
    }));
  } else {
    // Default 3-shift 8hr
    shiftTimings = [
      { name: 'Morning Shift', startTime: '06:00', endTime: '14:00', code: '06-14' },
      { name: 'Evening Shift', startTime: '14:00', endTime: '22:00', code: '14-22' },
      { name: 'Night Shift', startTime: '22:00', endTime: '06:00', code: '22-06' }
    ];
  }

  // 4. Fetch Candidate Gatemen & Restkeepers in division/station
  const allCandidateUsers = await prisma.user.findMany({
    where: {
      status: 'APPROVED',
      OR: [
        { role: { name: { in: ['Gateman', 'Restkeeper'] } } },
        { designation: { contains: 'Gateman', mode: 'insensitive' } },
        { designation: { contains: 'Restkeeper', mode: 'insensitive' } }
      ],
      ...(effectiveDivision ? {
        OR: [
          { division: { equals: effectiveDivision, mode: 'insensitive' } },
          { station: { division: { equals: effectiveDivision, mode: 'insensitive' } } }
        ]
      } : {})
    },
    select: {
      id: true,
      fullName: true,
      employeeId: true,
      mobile: true,
      email: true,
      designation: true,
      pmeExpiryDate: true,
      rcExpiryDate: true,
      role: { select: { name: true } },
      station: { select: { id: true, name: true, code: true } }
    },
    orderBy: { fullName: 'asc' }
  });

  const candidateGatemenList = allCandidateUsers.map((u: any) => ({
    id: u.id,
    fullName: u.fullName,
    employeeId: u.employeeId,
    designation: u.designation || u.role?.name || 'Gateman',
    role: u.role?.name || 'Gateman',
    pmeStatus: getExamCompliance(u.pmeExpiryDate),
    rcStatus: getExamCompliance(u.rcExpiryDate)
  }));

  // 5. Match Staff Rows
  const staffRows: ReconciledStaffRow[] = [];
  const rawStaff = Array.isArray(raw.staffAssignments) ? raw.staffAssignments : [];
  const usedUserIds = new Set<number>();

  for (const item of rawStaff) {
    const rawName = item.rawName || 'Unknown Gateman';
    const rawEmpId = item.employeeId;

    let bestMatch: any = null;
    let bestScore = 0;

    for (const cand of allCandidateUsers) {
      if (usedUserIds.has(cand.id)) continue;

      let score = 0;
      // Exact employee ID match
      if (rawEmpId && cand.employeeId && cand.employeeId.toLowerCase() === rawEmpId.toLowerCase()) {
        score = 1.0;
      } else {
        score = calculateNameSimilarity(rawName, cand.fullName);
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = cand;
      }
    }

    let matchedUserObj: any = null;
    if (bestMatch && bestScore >= 0.50) {
      usedUserIds.add(bestMatch.id);
      matchedUserObj = {
        id: bestMatch.id,
        fullName: bestMatch.fullName,
        employeeId: bestMatch.employeeId,
        mobile: bestMatch.mobile,
        email: bestMatch.email,
        designation: bestMatch.designation || bestMatch.role?.name || 'Gateman',
        role: bestMatch.role?.name || 'Gateman',
        pmeExpiryDate: bestMatch.pmeExpiryDate ? bestMatch.pmeExpiryDate.toISOString().split('T')[0] : null,
        rcExpiryDate: bestMatch.rcExpiryDate ? bestMatch.rcExpiryDate.toISOString().split('T')[0] : null,
        pmeStatus: getExamCompliance(bestMatch.pmeExpiryDate),
        rcStatus: getExamCompliance(bestMatch.rcExpiryDate),
        stationName: bestMatch.station?.name
      };
    } else {
      warnings.push(`Staff member "${rawName}" could not be automatically matched to a registered user.`);
    }

    // Standardize daily schedule
    const normalizedSchedule: Record<string, string> = {};
    const dateAssignments: ReconciledStaffRow['dateAssignments'] = [];

    for (const wd of weekDays) {
      const rawCode = item.schedule?.[wd.dayOfWeek];
      const normCode = normalizeShiftCode(rawCode);
      normalizedSchedule[wd.dayOfWeek] = normCode;

      // Find timing matching code
      const timing = shiftTimings.find(st => st.code === normCode);
      const startTime = timing ? timing.startTime : '07:00';
      const endTime = timing ? timing.endTime : '19:00';
      const shiftName = timing ? timing.name : (normCode === 'W/R' ? 'Weekly Rest' : normCode === 'N/R' ? 'Night Rest' : 'Shift');

      dateAssignments.push({
        date: wd.date,
        dayOfWeek: wd.dayOfWeek,
        shiftCode: normCode,
        startTime,
        endTime,
        shiftName
      });
    }

    staffRows.push({
      rawName,
      rawDesignation: item.designation,
      rawEmployeeId: item.employeeId,
      matchedUser: matchedUserObj,
      matchConfidence: Math.round(bestScore * 100) / 100,
      schedule: normalizedSchedule,
      dateAssignments
    });
  }

  // If no staff extracted or table was empty, fallback with candidate gatemen assigned to this gate
  if (staffRows.length === 0) {
    warnings.push('No staff assignments were detected from the image. Populated default roster slots.');
    const gateUsers = await prisma.userGate.findMany({
      where: { gateId: matchedGate.id },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            employeeId: true,
            mobile: true,
            email: true,
            designation: true,
            pmeExpiryDate: true,
            rcExpiryDate: true,
            role: { select: { name: true } }
          }
        }
      },
      take: 3
    });

    for (const gu of gateUsers) {
      const u = gu.user;
      const defaultSchedule: Record<string, string> = {};
      const dateAssignments: ReconciledStaffRow['dateAssignments'] = [];
      for (const wd of weekDays) {
        defaultSchedule[wd.dayOfWeek] = '06-14';
        dateAssignments.push({
          date: wd.date,
          dayOfWeek: wd.dayOfWeek,
          shiftCode: '06-14',
          startTime: '06:00',
          endTime: '14:00',
          shiftName: 'Morning Shift'
        });
      }

      staffRows.push({
        rawName: u.fullName,
        rawDesignation: u.designation || undefined,
        rawEmployeeId: u.employeeId,
        matchedUser: {
          id: u.id,
          fullName: u.fullName,
          employeeId: u.employeeId,
          mobile: u.mobile,
          email: u.email,
          designation: u.designation || u.role?.name || 'Gateman',
          role: u.role?.name || 'Gateman',
          pmeExpiryDate: u.pmeExpiryDate ? u.pmeExpiryDate.toISOString().split('T')[0] : null,
          rcExpiryDate: u.rcExpiryDate ? u.rcExpiryDate.toISOString().split('T')[0] : null,
          pmeStatus: getExamCompliance(u.pmeExpiryDate),
          rcStatus: getExamCompliance(u.rcExpiryDate)
        },
        matchConfidence: 1.0,
        schedule: defaultSchedule,
        dateAssignments
      });
    }
  }

  return {
    success: true,
    modelUsed,
    gate: {
      id: matchedGate.id,
      lcNumber: matchedGate.lcNumber,
      locationName: matchedGate.locationName,
      stationId: matchedGate.stationId,
      stationName: matchedGate.station ? `${matchedGate.station.name} (${matchedGate.station.code})` : 'N/A',
      division: effectiveDivision,
      matchedBy: gateMatchMethod
    },
    weekStartDate: weekStartDateStr,
    weekEndDate: weekEndDateStr,
    days: weekDays,
    shiftTimings,
    staffRows,
    candidateGatemen: candidateGatemenList,
    authorities: {
      preparedByPwi: raw.authorities?.preparedByPwi || 'Not Detected',
      countersignedByCpwi: raw.authorities?.countersignedByCpwi || 'Not Detected'
    },
    rawExtraction: raw,
    warnings
  };
}
