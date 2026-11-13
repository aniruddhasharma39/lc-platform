import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { sendDutyRosterEmail } from '../lib/emailService';
import { DEFAULT_3_SHIFT_CONFIG } from './shifts';

const router = Router();
router.use(authenticate);

export function getExamCompliance(expiryDate: Date | null): 'VALID' | 'DUE_SOON' | 'EXPIRED' | 'NOT_SET' {
  if (!expiryDate) return 'NOT_SET';
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'EXPIRED';
  if (diffDays <= 30) return 'DUE_SOON';
  return 'VALID';
}

/**
 * Validates whether the logged in user is authorized to create/edit duty rosters.
 * Primary: PWI (Permanent Way Inspector / JE P-Way)
 * Secondary: CPWI (Chief PWI / SSE P-Way Incharge)
 * System: Developer / Admin
 */
export function isRosterAuthor(user: any): boolean {
  if (!user) return false;
  const role = (user.role || '').toUpperCase();
  const desig = (user.designation || '').toUpperCase();
  return (
    role === 'PWI' ||
    role === 'CPWI' ||
    role === 'DEVELOPER' ||
    role === 'ADMIN' ||
    desig.includes('PWI') ||
    desig.includes('PERMANENT WAY') ||
    desig.includes('SSE/P.WAY') ||
    desig.includes('JE/P.WAY')
  );
}

const publishRosterSchema = z.object({
  stationId: z.number().int(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  assignments: z.array(z.object({
    gateId: z.number().int(),
    shiftName: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    gatemanId: z.number().int(),
  })).min(1, 'At least one shift assignment is required'),
});

/**
 * GET /api/v1/roster
 * Fetches duty roster chart data for a station and date,
 * including gates, shift template, existing allocations, and eligible gatemen.
 */
router.get('/', async (req: any, res, next) => {
  try {
    let stationId = req.query.stationId ? parseInt(req.query.stationId, 10) : undefined;
    if (!stationId && req.user.stationId) {
      stationId = req.user.stationId;
    }

    // Default date to today in YYYY-MM-DD
    let dateStr = req.query.date as string;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const now = new Date();
      dateStr = now.toISOString().split('T')[0];
    }

    // Fetch station
    let station = null;
    if (stationId) {
      station = await prisma.station.findUnique({
        where: { id: stationId },
        select: { id: true, code: true, name: true, division: true, zone: true }
      });
    }

    if (!station) {
      // Find first available station if viewer has no assigned station
      station = await prisma.station.findFirst({
        select: { id: true, code: true, name: true, division: true, zone: true }
      });
      if (station) stationId = station.id;
    }

    // Fetch LC gates under this station
    const gates = stationId
      ? await prisma.lCGate.findMany({
          where: { stationId },
          select: { id: true, lcNumber: true, locationName: true, stationId: true },
          orderBy: { lcNumber: 'asc' }
        })
      : [];

    const gateIds = gates.map(g => g.id);

    // Fetch active shift configuration for station
    let shiftConfig = null;
    if (stationId) {
      const dbConfig = await prisma.gateShiftConfig.findFirst({
        where: { stationId, gateId: null },
        orderBy: { updatedAt: 'desc' }
      });
      if (dbConfig) {
        try {
          shiftConfig = {
            id: dbConfig.id,
            name: dbConfig.name,
            shifts: JSON.parse(dbConfig.shiftsJson),
            isDefault: false
          };
        } catch (_) {}
      }
    }
    if (!shiftConfig) {
      shiftConfig = {
        id: null,
        name: DEFAULT_3_SHIFT_CONFIG.name,
        shifts: DEFAULT_3_SHIFT_CONFIG.shifts,
        isDefault: true
      };
    }

    // Fetch existing roster allocations for these gates on target date
    const rosterEntries = gateIds.length > 0
      ? await prisma.gateDutyRoster.findMany({
          where: {
            gateId: { in: gateIds },
            date: dateStr
          },
          include: {
            gate: {
              select: { id: true, lcNumber: true, locationName: true }
            },
            gateman: {
              select: {
                id: true,
                fullName: true,
                mobile: true,
                email: true,
                pmeExpiryDate: true,
                rcExpiryDate: true
              }
            },
            createdBy: {
              select: { id: true, fullName: true, designation: true }
            }
          },
          orderBy: [{ gateId: 'asc' }, { startTime: 'asc' }]
        })
      : [];

    // Fetch active Gatemen for duty allocation (scoped to station or department)
    const gatemenUsers = await prisma.user.findMany({
      where: {
        status: 'APPROVED',
        OR: [
          { role: { name: 'Gateman' } },
          { designation: { contains: 'Gateman', mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        fullName: true,
        mobile: true,
        email: true,
        stationId: true,
        pmeDate: true,
        pmeExpiryDate: true,
        pmeCertificateNo: true,
        rcDate: true,
        rcExpiryDate: true,
        rcInstitute: true,
        assignedGates: {
          select: { gateId: true }
        }
      },
      orderBy: { fullName: 'asc' }
    });

    const enrichedGatemen = gatemenUsers.map(gm => {
      const pmeStatus = getExamCompliance(gm.pmeExpiryDate);
      const rcStatus = getExamCompliance(gm.rcExpiryDate);
      return {
        ...gm,
        pmeStatus,
        rcStatus,
        isCompliant: pmeStatus === 'VALID' && rcStatus === 'VALID'
      };
    });

    res.json({
      station,
      date: dateStr,
      shiftConfig,
      gates: gates.map(g => ({
        ...g,
        displayName: `Gate ${g.lcNumber}${g.locationName ? ` (${g.locationName})` : ''}`
      })),
      roster: rosterEntries.map(r => ({
        id: r.id,
        gateId: r.gateId,
        gateNumber: r.gate.lcNumber,
        gateLocation: r.gate.locationName,
        shiftName: r.shiftName,
        startTime: r.startTime,
        endTime: r.endTime,
        gatemanId: r.gatemanUserId,
        gatemanName: r.gateman.fullName,
        gatemanMobile: r.gateman.mobile,
        gatemanEmail: r.gateman.email,
        assignedBy: r.createdBy?.fullName,
        assignedAt: r.createdAt,
        notifiedAt: r.notifiedAt,
        pmeStatus: getExamCompliance(r.gateman.pmeExpiryDate),
        rcStatus: getExamCompliance(r.gateman.rcExpiryDate)
      })),
      gatemen: enrichedGatemen
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/roster/publish
 * Publishes duty roster allocations for a station/date, saves to database,
 * and sends email notifications to assigned Gatemen.
 */
router.post('/publish', async (req: any, res, next) => {
  try {
    if (!isRosterAuthor(req.user)) {
      return res.status(403).json({
        error: 'Forbidden: Roster charts can only be prepared by PWI primarily or CPWI.',
      });
    }

    const data = publishRosterSchema.parse(req.body);

    const results = [];
    const gatemenNotificationMap = new Map<number, Array<{
      gateNumber: string;
      locationName?: string;
      shiftName: string;
      startTime: string;
      endTime: string;
    }>>();

    // Fetch gate details for email notifications
    const gateIds = Array.from(new Set(data.assignments.map(a => a.gateId)));
    const gates = await prisma.lCGate.findMany({
      where: { id: { in: gateIds } },
      select: { id: true, lcNumber: true, locationName: true, station: { select: { name: true, code: true } } }
    });
    const gateMap = new Map(gates.map(g => [g.id, g]));

    // Fetch station details
    const station = await prisma.station.findUnique({
      where: { id: data.stationId },
      select: { name: true, code: true }
    });
    const stationName = station ? `${station.name} (${station.code})` : 'Railway Station';

    for (const item of data.assignments) {
      const rosterEntry = await prisma.gateDutyRoster.upsert({
        where: {
          gateId_date_shiftName: {
            gateId: item.gateId,
            date: data.date,
            shiftName: item.shiftName,
          }
        },
        update: {
          startTime: item.startTime,
          endTime: item.endTime,
          gatemanUserId: item.gatemanId,
          createdById: req.user.id,
          stationId: data.stationId,
        },
        create: {
          gateId: item.gateId,
          stationId: data.stationId,
          date: data.date,
          shiftName: item.shiftName,
          startTime: item.startTime,
          endTime: item.endTime,
          gatemanUserId: item.gatemanId,
          createdById: req.user.id,
        }
      });
      results.push(rosterEntry);

      // Group by gateman for email notification
      const gateObj = gateMap.get(item.gateId);
      if (gateObj) {
        if (!gatemenNotificationMap.has(item.gatemanId)) {
          gatemenNotificationMap.set(item.gatemanId, []);
        }
        gatemenNotificationMap.get(item.gatemanId)!.push({
          gateNumber: `LC-${gateObj.lcNumber}`,
          locationName: gateObj.locationName || undefined,
          shiftName: item.shiftName,
          startTime: item.startTime,
          endTime: item.endTime
        });
      }
    }

    // Dispatch emails to assigned gatemen asynchronously
    const supervisorName = req.user.fullName || 'Station Supervisor';
    (async () => {
      for (const [gatemanId, shifts] of gatemenNotificationMap.entries()) {
        try {
          const gateman = await prisma.user.findUnique({
            where: { id: gatemanId },
            select: { fullName: true, email: true, pmeExpiryDate: true, rcExpiryDate: true }
          });

          if (gateman && gateman.email && gateman.email.includes('@') && !gateman.email.includes('@example.com')) {
            for (const s of shifts) {
              await sendDutyRosterEmail({
                toEmail: gateman.email,
                recipientName: gateman.fullName || 'Gateman',
                gateNumber: s.gateNumber,
                stationName,
                date: data.date,
                shiftName: s.shiftName,
                startTime: s.startTime,
                endTime: s.endTime,
                restkeeperName: supervisorName,
                pmeStatusText: getExamCompliance(gateman.pmeExpiryDate),
                rcStatusText: getExamCompliance(gateman.rcExpiryDate),
              });
            }
          }
        } catch (emailErr: any) {
          console.warn(`[ROSTER EMAIL ERROR] Failed to send roster notification to user ${gatemanId}:`, emailErr?.message || emailErr);
        }
      }
    })();

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'PUBLISH_DUTY_ROSTER',
        details: `Published duty roster for station ${data.stationId} on ${data.date} with ${data.assignments.length} assignments.`
      }
    });

    res.json({
      success: true,
      message: `Duty roster published successfully for ${data.date}.`,
      count: results.length,
      roster: results
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/roster/my-shifts
 * Allows Gatemen to view their assigned upcoming shifts.
 */
router.get('/my-shifts', async (req: any, res, next) => {
  try {
    const userId = req.user.id;
    const todayStr = new Date().toISOString().split('T')[0];

    const shifts = await prisma.gateDutyRoster.findMany({
      where: {
        gatemanUserId: userId,
        date: { gte: todayStr }
      },
      include: {
        gate: {
          select: { id: true, lcNumber: true, locationName: true, station: { select: { name: true, code: true } } }
        },
        createdBy: {
          select: { fullName: true, designation: true }
        }
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 20
    });

    res.json({
      shifts: shifts.map(s => ({
        id: s.id,
        date: s.date,
        shiftName: s.shiftName,
        startTime: s.startTime,
        endTime: s.endTime,
        gateId: s.gateId,
        gateNumber: `LC-${s.gate.lcNumber}`,
        locationName: s.gate.locationName,
        stationName: s.gate.station?.name || 'Assigned Station',
        assignedBy: s.createdBy?.fullName || 'PWI / CPWI',
      }))
    });
  } catch (error) {
    next(error);
  }
});

// =========================================================================
// WEEKLY ROSTER ENGINE (Mirroring Official LC-91 Indian Railways Chart)
// =========================================================================

const publishWeeklySchema = z.object({
  gateId: z.number().int(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStartDate must be YYYY-MM-DD'),
  assignments: z.array(z.object({
    gatemanId: z.number().int(),
    dayOfWeek: z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftCode: z.string().min(1), // "07-19", "19-24", "00-07", "W/R", "N/R", "-"
    startTime: z.string().default('07:00'),
    endTime: z.string().default('19:00'),
    shiftName: z.string().optional(),
    isSplitShift: z.boolean().optional().default(false),
    secondaryStart: z.string().optional().nullable(),
    secondaryEnd: z.string().optional().nullable(),
  })).min(1, 'At least one shift assignment is required'),
});

/**
 * GET /api/v1/roster/weekly
 * Fetches the 7-day Weekly Duty Roster Matrix for an LC Gate.
 * Returns staff rows with 7-day schedule chips (07-19, 19-24, 00-07, W/R, N/R, -)
 * and PWI / CPWI endorsement metadata.
 */
router.get('/weekly', async (req: any, res, next) => {
  try {
    const gateId = req.query.gateId ? parseInt(req.query.gateId as string, 10) : undefined;
    if (!gateId) {
      return res.status(400).json({ error: 'gateId query parameter is required (e.g. ?gateId=91)' });
    }

    const gate = await prisma.lCGate.findUnique({
      where: { id: gateId },
      include: {
        station: { select: { id: true, name: true, code: true, division: true, zone: true } },
      },
    });

    if (!gate) {
      return res.status(404).json({ error: 'LC Gate not found' });
    }

    // Determine week dates (Sunday through Saturday)
    let weekStartDateStr = req.query.weekStartDate as string;
    let startDate: Date;
    if (weekStartDateStr && /^\d{4}-\d{2}-\d{2}$/.test(weekStartDateStr)) {
      startDate = new Date(weekStartDateStr + 'T00:00:00Z');
    } else {
      const now = new Date();
      const day = now.getUTCDay(); // 0 = Sunday
      startDate = new Date(now);
      startDate.setUTCDate(now.getUTCDate() - day);
      weekStartDateStr = startDate.toISOString().split('T')[0];
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekDays = dayNames.map((name, idx) => {
      const d = new Date(startDate);
      d.setUTCDate(startDate.getUTCDate() + idx);
      return {
        dayOfWeek: name,
        date: d.toISOString().split('T')[0],
      };
    });

    const weekDates = weekDays.map(w => w.date);

    // Fetch assigned Gatemen and Restkeepers for this gate
    const assignedUserGates = await prisma.userGate.findMany({
      where: { gateId },
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
            role: { select: { name: true } },
          },
        },
      },
      orderBy: { user: { fullName: 'asc' } },
    });

    let staffList = assignedUserGates.map(ug => ug.user);

    // If fewer than 3 staff members assigned, fetch additional available Gatemen/Restkeepers from station
    if (staffList.length < 3 && gate.stationId) {
      const additionalStaff = await prisma.user.findMany({
        where: {
          stationId: gate.stationId,
          status: 'APPROVED',
          OR: [
            { role: { name: 'Gateman' } },
            { role: { name: 'Restkeeper' } },
            { designation: { contains: 'Gateman', mode: 'insensitive' } },
            { designation: { contains: 'Restkeeper', mode: 'insensitive' } },
          ],
          id: { notIn: staffList.map(s => s.id) },
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
        },
        take: 5,
      });
      staffList = [...staffList, ...additionalStaff];
    }

    // Fetch existing roster allocations across the 7 days for this gate
    const existingEntries = await prisma.gateDutyRoster.findMany({
      where: {
        gateId,
        date: { in: weekDates },
      },
      include: {
        gateman: { select: { id: true, fullName: true, employeeId: true } },
        createdBy: { select: { id: true, fullName: true, designation: true } },
      },
    });

    // Build staff 7-day matrix
    const matrix = staffList.map(staff => {
      const schedule: Record<string, any> = {};

      for (const wd of weekDays) {
        const entry = existingEntries.find(e => e.gatemanUserId === staff.id && e.date === wd.date);
        if (entry) {
          schedule[wd.dayOfWeek] = {
            id: entry.id,
            date: entry.date,
            shiftCode: entry.shiftCode || (entry.startTime && entry.endTime ? `${entry.startTime.slice(0, 2)}-${entry.endTime.slice(0, 2)}` : '07-19'),
            shiftName: entry.shiftName,
            startTime: entry.startTime,
            endTime: entry.endTime,
            isSplitShift: entry.isSplitShift,
            secondaryStart: entry.secondaryStart,
            secondaryEnd: entry.secondaryEnd,
          };
        } else {
          schedule[wd.dayOfWeek] = {
            id: null,
            date: wd.date,
            shiftCode: '-',
            shiftName: 'Off / Not Assigned',
            startTime: '07:00',
            endTime: '19:00',
            isSplitShift: false,
          };
        }
      }

      return {
        userId: staff.id,
        fullName: staff.fullName,
        employeeId: staff.employeeId,
        designation: staff.designation || staff.role?.name || 'Gateman',
        isRestkeeper: staff.role?.name === 'Restkeeper' || (staff.designation || '').toLowerCase().includes('restkeeper'),
        pmeStatus: getExamCompliance(staff.pmeExpiryDate),
        rcStatus: getExamCompliance(staff.rcExpiryDate),
        schedule,
      };
    });

    // Endorsement sign-off metadata
    const lastEntry = existingEntries[0];
    const preparedByName = lastEntry?.createdBy
      ? `${lastEntry.createdBy.fullName} (${lastEntry.createdBy.designation || 'PWI'})`
      : 'वरिष्ठ/कनिष्ठ सेक्शन इंजीनियर (SSE/JE P.WAY INCHARGE)';

    return res.json({
      success: true,
      gate: {
        id: gate.id,
        lcNumber: gate.lcNumber,
        locationName: gate.locationName,
        stationName: gate.station ? `${gate.station.name} (${gate.station.code})` : 'N/A',
        division: gate.station?.division || 'Central Railway',
      },
      weekStartDate: weekStartDateStr,
      weekEndDate: weekDates[6],
      days: weekDays,
      matrix,
      signOff: {
        preparedByTitle: 'वरिष्ठ सेक्शन इंजीनियर (रेलवे - ट्रैक), प्रभार (SSE/P.WAY INCHARGE)',
        preparedByName,
        approvedByTitle: 'सहायक मंडल इंजीनियर (Assistant Divisional Engineer / CPWI)',
        approvedByName: 'ADEN / CPWI Section Incharge',
      },
      canEdit: isRosterAuthor(req.user),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/roster/publish-weekly
 * Publishes/updates 7-day Weekly Gate Duty Roster for an LC Gate.
 * Enforces strict PWI (Primary) & CPWI (Secondary/Section) authoring permission.
 */
router.post('/publish-weekly', async (req: any, res, next) => {
  try {
    if (!isRosterAuthor(req.user)) {
      return res.status(403).json({
        error: 'Forbidden: Weekly roster charts can only be prepared by PWI primarily or CPWI.',
      });
    }

    const data = publishWeeklySchema.parse(req.body);

    const gate = await prisma.lCGate.findUnique({
      where: { id: data.gateId },
      include: { station: true },
    });

    if (!gate) {
      return res.status(404).json({ error: 'LC Gate not found' });
    }

    const stationId = gate.stationId || 1;
    const results = [];

    for (const item of data.assignments) {
      if (item.shiftCode === '-') continue; // Skip unassigned days

      const resolvedShiftName = item.shiftName ||
        (item.shiftCode === '07-19' ? 'Day Shift (07:00 - 19:00)' :
         item.shiftCode === '19-24' ? 'Evening Shift (19:00 - 24:00)' :
         item.shiftCode === '00-07' ? 'Night Shift (00:00 - 07:00)' :
         item.shiftCode === 'W/R' ? 'Weekly Rest (W/R)' :
         item.shiftCode === 'N/R' ? 'Night Rest (N/R)' : `Shift ${item.shiftCode}`);

      const entry = await prisma.gateDutyRoster.upsert({
        where: {
          gateId_date_shiftName: {
            gateId: data.gateId,
            date: item.date,
            shiftName: resolvedShiftName,
          },
        },
        update: {
          startTime: item.startTime,
          endTime: item.endTime,
          gatemanUserId: item.gatemanId,
          createdById: req.user.id,
          stationId,
          weekStartDate: data.weekStartDate,
          dayOfWeek: item.dayOfWeek,
          shiftCode: item.shiftCode,
          isSplitShift: item.isSplitShift || false,
          secondaryStart: item.secondaryStart || null,
          secondaryEnd: item.secondaryEnd || null,
        },
        create: {
          gateId: data.gateId,
          stationId,
          date: item.date,
          shiftName: resolvedShiftName,
          startTime: item.startTime,
          endTime: item.endTime,
          gatemanUserId: item.gatemanId,
          createdById: req.user.id,
          weekStartDate: data.weekStartDate,
          dayOfWeek: item.dayOfWeek,
          shiftCode: item.shiftCode,
          isSplitShift: item.isSplitShift || false,
          secondaryStart: item.secondaryStart || null,
          secondaryEnd: item.secondaryEnd || null,
        },
      });

      results.push(entry);
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'PUBLISH_WEEKLY_ROSTER',
        details: `Published weekly roster for LC Gate ${gate.lcNumber} (Week: ${data.weekStartDate}) with ${results.length} assignments by ${req.user.role}`,
      },
    });

    return res.json({
      success: true,
      message: `Weekly duty roster for LC Gate ${gate.lcNumber} published successfully.`,
      gateNumber: gate.lcNumber,
      weekStartDate: data.weekStartDate,
      assignedCount: results.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
