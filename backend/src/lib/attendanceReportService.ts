import { prisma } from './prisma';
import { formatISTDateDisplay, getISTDateString } from './timeUtils';

export interface AttendanceReportFilter {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  stationId?: number;
  gateId?: number;
  userId?: number;
  designation?: string;
  search?: string;
  statusFilter?: string; // 'ALL' | 'PRESENT' | 'LATE' | 'COMPLETED' | 'ON_DUTY'
  severity?: string;
  type?: string;
  shiftCode?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface AttendanceSessionRecord {
  id: string;
  date: string;
  dateFormatted: string;
  user: {
    id: number;
    fullName: string;
    employeeId: string;
    designation: string;
    mobile: string;
    isRestkeeper: boolean;
  };
  gate: {
    id: number;
    lcNumber: string;
    locationName: string;
    stationName: string;
    division: string;
    zone: string;
  };
  shift: {
    name: string;
    code: string;
    scheduledStart: string;
    scheduledEnd: string;
    isSplitShift: boolean;
  };
  checkIn: {
    timestamp: Date | null;
    timeFormatted: string;
    status: string;
    minutesLate: number;
    faceConfidence: number | null;
    geofenceDistanceMeters: number | null;
    isGeofenceVerified: boolean;
    selfieUrl: string | null;
  } | null;
  checkOut: {
    timestamp: Date | null;
    timeFormatted: string;
    status: string;
    faceConfidence: number | null;
    geofenceDistanceMeters: number | null;
    selfieUrl: string | null;
  } | null;
  totalDurationMinutes: number | null;
  totalDurationFormatted: string;
  dutyStatus: 'COMPLETED' | 'ON_DUTY' | 'LATE' | 'MISSED' | 'CHECK_OUT_ONLY';
}

export interface AttendanceReportResult {
  startDateStr: string;
  endDateStr: string;
  metrics: {
    totalSessions: number;
    completedSessions: number;
    currentlyOnDuty: number;
    lateSessions: number;
    onTimePercentage: number;
    totalDutyHoursFormatted: string;
    reportingGatesCount: number;
    reportingStaffCount: number;
  };
  records: AttendanceSessionRecord[];
}

export interface AttendanceExceptionRecord {
  id: string;
  date: string;
  dateFormatted: string;
  exceptionType: 'LATE_ARRIVAL' | 'UNSTAFFED_GATE' | 'EARLY_DEPARTURE' | 'GEOFENCE_BREACH';
  severity: 'LOW' | 'MODERATE' | 'CRITICAL';
  severityLabel: string;
  user: {
    id: number;
    fullName: string;
    employeeId: string;
    designation: string;
    mobile: string;
  } | null;
  gate: {
    id: number;
    lcNumber: string;
    locationName: string;
    stationName: string;
    division: string;
  };
  shift: {
    name: string;
    code: string;
    scheduledStart: string;
    scheduledEnd: string;
  };
  delayMinutes: number;
  delayFormatted: string;
  actualPunchTime: string | null;
  description: string;
  correctiveAction: string;
}

export interface AttendanceExceptionReportResult {
  startDateStr: string;
  endDateStr: string;
  metrics: {
    totalExceptions: number;
    lateArrivalsCount: number;
    unstaffedGateCount: number;
    earlyDeparturesCount: number;
    geofenceBreachCount: number;
    totalDelayMinutes: number;
    totalDelayHoursFormatted: string;
    safetyComplianceScore: number;
  };
  exceptions: AttendanceExceptionRecord[];
}

/**
 * Format minutes into readable human duration: e.g. "12h 15m" or "45m"
 */
function formatMinutesHuman(minutes: number): string {
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Scope enforcement helper for Indian Railways hierarchy
 */
export function buildHierarchyWhereClause(requestingUser: any, baseWhere: any = {}) {
  const roleName = typeof requestingUser?.role === 'string'
    ? requestingUser.role
    : (requestingUser?.role?.name || '');
  const role = roleName.toLowerCase();
  const desig = (requestingUser?.designation || '').toLowerCase();

  // 1. Gateman / Restkeeper: Self Only
  if (role === 'gateman' || role === 'restkeeper' || desig.includes('gateman') || desig.includes('restkeeper')) {
    baseWhere.userId = requestingUser.id;
    return baseWhere;
  }

  // 2. Station Master: Assigned Station Only
  if (role.includes('station master') || desig.includes('station master') || role === 'sm') {
    if (requestingUser.stationId) {
      baseWhere.stationId = requestingUser.stationId;
    }
    return baseWhere;
  }

  // 3. PWI / SSE (P.WAY): Section Jurisdiction (Multiple Stations)
  if (role.includes('pwi') || desig.includes('pwi') || desig.includes('sse/p.way') || desig.includes('je/p.way')) {
    if (requestingUser.stationId) {
      baseWhere.stationId = requestingUser.stationId;
    }
    return baseWhere;
  }

  // 4. CPWI, ADEN, DEN, Sr.DEN, DRM, Developer, Admin: Unrestricted / Full Divisional Scope
  return baseWhere;
}

/**
 * Fetches the Master Shift Attendance Report: pairs check-in & check-out logs into duty sessions
 */
export async function getAttendanceReportData(
  filter: AttendanceReportFilter,
  requestingUser: any
): Promise<AttendanceReportResult> {
  const startDateStr = filter.startDate || getISTDateString(new Date());
  const endDateStr = filter.endDate || startDateStr;

  // Build query where clause
  const where: any = {
    date: {
      gte: startDateStr,
      lte: endDateStr,
    },
  };

  buildHierarchyWhereClause(requestingUser, where);

  if (filter.stationId) where.stationId = filter.stationId;
  if (filter.gateId) where.gateId = filter.gateId;
  if (filter.userId) where.userId = filter.userId;

  // Fetch all attendance punches in the window
  const punches = await prisma.shiftAttendance.findMany({
    where,
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          employeeId: true,
          designation: true,
          mobile: true,
          role: { select: { name: true } },
        },
      },
      gate: {
        include: {
          station: { select: { id: true, name: true, code: true, division: true, zone: true } },
        },
      },
      roster: {
        select: {
          id: true,
          shiftName: true,
          shiftCode: true,
          startTime: true,
          endTime: true,
          isSplitShift: true,
        },
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Group punches by (gateId, userId, date, shiftName)
  const sessionMap = new Map<string, { checkIn: any; checkOut: any }>();

  for (const punch of punches) {
    const shiftKey = punch.shiftName || 'General';
    const key = `${punch.gateId}_${punch.userId}_${punch.date}_${shiftKey}`;

    if (!sessionMap.has(key)) {
      sessionMap.set(key, { checkIn: null, checkOut: null });
    }

    const session = sessionMap.get(key)!;
    if (punch.type === 'CHECK_IN') {
      if (!session.checkIn || punch.timestamp < session.checkIn.timestamp) {
        session.checkIn = punch;
      }
    } else if (punch.type === 'CHECK_OUT') {
      if (!session.checkOut || punch.timestamp > session.checkOut.timestamp) {
        session.checkOut = punch;
      }
    }
  }

  const records: AttendanceSessionRecord[] = [];
  let totalDutyMinutes = 0;
  let lateCount = 0;
  let completedCount = 0;
  let onDutyCount = 0;

  const reportingGateIds = new Set<number>();
  const reportingUserIds = new Set<number>();

  for (const [key, session] of sessionMap.entries()) {
    const primary = session.checkIn || session.checkOut;
    if (!primary) continue;

    reportingGateIds.add(primary.gateId);
    reportingUserIds.add(primary.userId);

    const checkIn = session.checkIn;
    const checkOut = session.checkOut;

    let durationMins: number | null = null;
    let dutyStatus: AttendanceSessionRecord['dutyStatus'] = 'ON_DUTY';

    if (checkIn && checkOut) {
      const diffMs = checkOut.timestamp.getTime() - checkIn.timestamp.getTime();
      durationMins = Math.max(0, Math.round(diffMs / (1000 * 60)));
      totalDutyMinutes += durationMins;
      dutyStatus = checkIn.minutesLate > 0 ? 'LATE' : 'COMPLETED';
      completedCount++;
    } else if (checkIn && !checkOut) {
      dutyStatus = checkIn.minutesLate > 0 ? 'LATE' : 'ON_DUTY';
      onDutyCount++;
    } else if (!checkIn && checkOut) {
      dutyStatus = 'CHECK_OUT_ONLY';
    }

    if (checkIn && checkIn.minutesLate > 0) {
      lateCount++;
    }

    const isRestkeeper =
      primary.user?.role?.name === 'Restkeeper' ||
      (primary.user?.designation || '').toLowerCase().includes('restkeeper');

    const scheduledStart = primary.roster?.startTime || '07:00';
    const scheduledEnd = primary.roster?.endTime || '19:00';
    const shiftCode = primary.roster?.shiftCode || `${scheduledStart.slice(0, 2)}-${scheduledEnd.slice(0, 2)}`;

    // Time formatters in IST
    const checkInTimeStr = checkIn
      ? checkIn.timestamp.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      : '-';

    const checkOutTimeStr = checkOut
      ? checkOut.timestamp.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      : (dutyStatus === 'ON_DUTY' ? 'Still On Duty' : '-');

    records.push({
      id: key,
      date: primary.date,
      dateFormatted: formatISTDateDisplay(primary.date),
      user: {
        id: primary.user.id,
        fullName: primary.user.fullName,
        employeeId: primary.user.employeeId,
        designation: primary.user.designation || (isRestkeeper ? 'Restkeeper' : 'Gateman'),
        mobile: primary.user.mobile,
        isRestkeeper,
      },
      gate: {
        id: primary.gate.id,
        lcNumber: primary.gate.lcNumber,
        locationName: primary.gate.locationName,
        stationName: primary.gate.station?.name || 'N/A',
        division: primary.gate.station?.division || 'Central Railway',
        zone: primary.gate.station?.zone || 'Central Railway',
      },
      shift: {
        name: primary.shiftName,
        code: shiftCode,
        scheduledStart,
        scheduledEnd,
        isSplitShift: primary.roster?.isSplitShift || false,
      },
      checkIn: checkIn ? {
        timestamp: checkIn.timestamp,
        timeFormatted: checkInTimeStr,
        status: checkIn.status,
        minutesLate: checkIn.minutesLate || 0,
        faceConfidence: checkIn.faceConfidence,
        geofenceDistanceMeters: checkIn.geofenceDistanceMeters,
        isGeofenceVerified: checkIn.isGeofenceVerified,
        selfieUrl: checkIn.selfieUrl,
      } : null,
      checkOut: checkOut ? {
        timestamp: checkOut.timestamp,
        timeFormatted: checkOutTimeStr,
        status: checkOut.status,
        faceConfidence: checkOut.faceConfidence,
        geofenceDistanceMeters: checkOut.geofenceDistanceMeters,
        selfieUrl: checkOut.selfieUrl,
      } : null,
      totalDurationMinutes: durationMins,
      totalDurationFormatted: durationMins !== null ? formatMinutesHuman(durationMins) : 'In Progress',
      dutyStatus,
    });
  }

  // Filter by search query if provided
  let filteredRecords = records;
  if (filter.search && filter.search.trim().length > 0) {
    const q = filter.search.trim().toLowerCase();
    filteredRecords = records.filter(r =>
      r.user.fullName.toLowerCase().includes(q) ||
      r.user.employeeId.toLowerCase().includes(q) ||
      r.gate.lcNumber.toLowerCase().includes(q) ||
      r.gate.locationName.toLowerCase().includes(q)
    );
  }

  // Filter by status if provided
  if (filter.statusFilter && filter.statusFilter !== 'ALL') {
    filteredRecords = filteredRecords.filter(r => r.dutyStatus === filter.statusFilter);
  }

  const totalSessions = records.length;
  const onTimePercentage = totalSessions > 0 ? Math.round(((totalSessions - lateCount) / totalSessions) * 1000) / 10 : 100;

  return {
    startDateStr,
    endDateStr,
    metrics: {
      totalSessions,
      completedSessions: completedCount,
      currentlyOnDuty: onDutyCount,
      lateSessions: lateCount,
      onTimePercentage,
      totalDutyHoursFormatted: formatMinutesHuman(totalDutyMinutes),
      reportingGatesCount: reportingGateIds.size,
      reportingStaffCount: reportingUserIds.size,
    },
    records: filteredRecords,
  };
}

/**
 * Fetches the Attendance Exception Report: isolates delays, unstaffed gates, early exits, geofence breaches
 */
export async function getAttendanceExceptionReportData(
  filter: AttendanceReportFilter,
  requestingUser: any
): Promise<AttendanceExceptionReportResult> {
  const masterData = await getAttendanceReportData(filter, requestingUser);
  const exceptions: AttendanceExceptionRecord[] = [];

  let lateArrivalsCount = 0;
  let unstaffedGateCount = 0;
  let earlyDeparturesCount = 0;
  let geofenceBreachCount = 0;
  let totalDelayMinutes = 0;

  // 1. Identify Late Arrivals & Geofence Breaches from attendance sessions
  for (const session of masterData.records) {
    if (session.checkIn && session.checkIn.minutesLate > 0) {
      const delay = session.checkIn.minutesLate;
      totalDelayMinutes += delay;
      lateArrivalsCount++;

      const severity: AttendanceExceptionRecord['severity'] =
        delay > 30 ? 'CRITICAL' : delay > 15 ? 'MODERATE' : 'LOW';

      exceptions.push({
        id: `late_${session.id}`,
        date: session.date,
        dateFormatted: session.dateFormatted,
        exceptionType: 'LATE_ARRIVAL',
        severity,
        severityLabel: severity === 'CRITICAL' ? 'Critical Delay (>30m)' : severity === 'MODERATE' ? 'Moderate Delay' : 'Minor Delay',
        user: session.user,
        gate: session.gate,
        shift: session.shift,
        delayMinutes: delay,
        delayFormatted: `${delay} mins late`,
        actualPunchTime: session.checkIn.timeFormatted,
        description: `${session.user.fullName} (${session.user.designation}) reported ${delay} minutes late past scheduled start ${session.shift.scheduledStart}.`,
        correctiveAction: delay > 30 ? 'PWI explanation required under Indian Railways safety protocols.' : 'Recorded in duty muster.',
      });
    }

    // Geofence Exception: punched outside 150m perimeter or manual fallback
    if (session.checkIn && (!session.checkIn.isGeofenceVerified || (session.checkIn.geofenceDistanceMeters && session.checkIn.geofenceDistanceMeters > 150))) {
      geofenceBreachCount++;
      const dist = session.checkIn.geofenceDistanceMeters ? `${session.checkIn.geofenceDistanceMeters}m` : 'Unknown';
      exceptions.push({
        id: `geofence_${session.id}`,
        date: session.date,
        dateFormatted: session.dateFormatted,
        exceptionType: 'GEOFENCE_BREACH',
        severity: 'MODERATE',
        severityLabel: 'Geofence Perimeter Breach',
        user: session.user,
        gate: session.gate,
        shift: session.shift,
        delayMinutes: 0,
        delayFormatted: `Punch distance: ${dist}`,
        actualPunchTime: session.checkIn.timeFormatted,
        description: `Biometric attendance verified outside 150m perimeter (${dist} from gate cabin). Manual fallback or boundary deviation.`,
        correctiveAction: 'Supervisor GPS audit recommended.',
      });
    }
  }

  // 2. Identify Unstaffed Gates (Scheduled Roster without any Check-In)
  const rosterWhere: any = {
    date: {
      gte: masterData.startDateStr,
      lte: masterData.endDateStr,
    },
    isPermanent: false,
    shiftCode: { not: '-' },
  };

  buildHierarchyWhereClause(requestingUser, rosterWhere);
  if (filter.stationId) rosterWhere.stationId = filter.stationId;
  if (filter.gateId) rosterWhere.gateId = filter.gateId;

  const scheduledRosters = await prisma.gateDutyRoster.findMany({
    where: rosterWhere,
    include: {
      gateman: {
        select: {
          id: true,
          fullName: true,
          employeeId: true,
          designation: true,
          mobile: true,
        },
      },
      gate: {
        include: {
          station: { select: { id: true, name: true, code: true, division: true } },
        },
      },
    },
  });

  for (const roster of scheduledRosters) {
    // Check if an actual check-in punch occurred for this gate and user on this date
    const key = `${roster.gateId}_${roster.gatemanUserId}_${roster.date}_${roster.shiftName}`;
    const matchedSession = masterData.records.find(r => r.gate.id === roster.gateId && r.user.id === roster.gatemanUserId && r.date === roster.date);

    if (!matchedSession || !matchedSession.checkIn) {
      unstaffedGateCount++;
      exceptions.push({
        id: `unstaffed_${roster.id}_${roster.date}`,
        date: roster.date,
        dateFormatted: formatISTDateDisplay(roster.date),
        exceptionType: 'UNSTAFFED_GATE',
        severity: 'CRITICAL',
        severityLabel: 'CRITICAL: Gate Unstaffed',
        user: roster.gateman ? {
          id: roster.gateman.id,
          fullName: roster.gateman.fullName,
          employeeId: roster.gateman.employeeId,
          designation: roster.gateman.designation || 'Gateman',
          mobile: roster.gateman.mobile,
        } : null,
        gate: {
          id: roster.gate.id,
          lcNumber: roster.gate.lcNumber,
          locationName: roster.gate.locationName,
          stationName: roster.gate.station?.name || 'N/A',
          division: roster.gate.station?.division || 'Central Railway',
        },
        shift: {
          name: roster.shiftName,
          code: roster.shiftCode || '07-19',
          scheduledStart: roster.startTime,
          scheduledEnd: roster.endTime,
        },
        delayMinutes: 0,
        delayFormatted: 'No punch recorded',
        actualPunchTime: null,
        description: `Scheduled staff (${roster.gateman?.fullName || 'Unassigned'}) did not report for shift ${roster.shiftName} (${roster.startTime} - ${roster.endTime}). Gate was unstaffed!`,
        correctiveAction: 'CRITICAL SAFETY HAZARD: Immediate station master & PWI investigation required.',
      });
    }
  }

  // Sort exceptions: CRITICAL first, then MODERATE, then LOW; then by date descending
  exceptions.sort((a, b) => {
    const sevWeight = { CRITICAL: 3, MODERATE: 2, LOW: 1 };
    if (sevWeight[b.severity] !== sevWeight[a.severity]) {
      return sevWeight[b.severity] - sevWeight[a.severity];
    }
    return b.date.localeCompare(a.date);
  });

  const totalExceptions = exceptions.length;
  const totalScheduled = scheduledRosters.length || masterData.metrics.totalSessions;
  const complianceScore = totalScheduled > 0
    ? Math.max(0, Math.round(((totalScheduled - unstaffedGateCount - (lateArrivalsCount * 0.5)) / totalScheduled) * 1000) / 10)
    : 100;

  return {
    startDateStr: masterData.startDateStr,
    endDateStr: masterData.endDateStr,
    metrics: {
      totalExceptions,
      lateArrivalsCount,
      unstaffedGateCount,
      earlyDeparturesCount,
      geofenceBreachCount,
      totalDelayMinutes,
      totalDelayHoursFormatted: formatMinutesHuman(totalDelayMinutes),
      safetyComplianceScore: complianceScore,
    },
    exceptions,
  };
}

