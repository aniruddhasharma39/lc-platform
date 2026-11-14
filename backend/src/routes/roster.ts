import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { sendDutyRosterEmail } from '../lib/emailService';
import { DEFAULT_3_SHIFT_CONFIG } from './shifts';
import { isDeveloperUser } from '../lib/railwayHierarchy';
import { analyzeRosterChartWithGemini } from '../lib/geminiRosterService';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit for high-res duty roster photos
});

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

    // If still no stationId, check if the user has an assigned gate with a station
    if (!stationId) {
      const userGateWithStation = await prisma.userGate.findFirst({
        where: { userId: req.user.id, gate: { stationId: { not: null } } },
        include: { gate: { select: { stationId: true } } }
      });
      if (userGateWithStation?.gate?.stationId) {
        stationId = userGateWithStation.gate.stationId;
      }
    }

    // Default date to today in YYYY-MM-DD
    let dateStr = req.query.date as string;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const now = new Date();
      dateStr = now.toISOString().split('T')[0];
    }

    // Scoping for division
    let stationWhere: any = {};
    if (req.user.division && !isDeveloperUser(req.user)) {
      stationWhere.division = { equals: req.user.division, mode: 'insensitive' };
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
      // 1. Try first station in viewer's division that HAS active LC gates
      station = await prisma.station.findFirst({
        where: {
          ...stationWhere,
          gates: { some: {} }
        },
        select: { id: true, code: true, name: true, division: true, zone: true },
        orderBy: { name: 'asc' }
      });

      // 2. Fallback to any station in viewer's division
      if (!station) {
        station = await prisma.station.findFirst({
          where: stationWhere,
          select: { id: true, code: true, name: true, division: true, zone: true },
          orderBy: { name: 'asc' }
        });
      }

      // 3. Fallback to any station system-wide that HAS active LC gates
      if (!station) {
        station = await prisma.station.findFirst({
          where: { gates: { some: {} } },
          select: { id: true, code: true, name: true, division: true, zone: true },
          orderBy: { name: 'asc' }
        });
      }

      if (station) stationId = station.id;
    }

    // Fetch all stations in user's jurisdiction for switcher dropdown (stations with gates first)
    const stations = await prisma.station.findMany({
      where: stationWhere,
      select: {
        id: true,
        code: true,
        name: true,
        division: true,
        zone: true,
        _count: { select: { gates: true } }
      },
      orderBy: [
        { gates: { _count: 'desc' } },
        { name: 'asc' }
      ]
    });

    // Fetch LC gates: for PWI / CPWI / Supervisor, restrict to their station or division
    let gateWhere: any = {};
    if (stationId) {
      gateWhere = { stationId };
    } else if (req.user.division && !isDeveloperUser(req.user)) {
      gateWhere = {
        OR: [
          { division: { equals: req.user.division, mode: 'insensitive' } },
          { station: { division: { equals: req.user.division, mode: 'insensitive' } } }
        ]
      };
    } else if (!isRosterAuthor(req.user) && stationId) {
      gateWhere = { stationId };
    }

    const gates = await prisma.lCGate.findMany({
      where: gateWhere,
      select: { id: true, lcNumber: true, locationName: true, stationId: true },
      orderBy: { lcNumber: 'asc' }
    });

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

    // Fetch active Gatemen and Restkeepers for duty allocation (scoped to supervisor's division)
    const gatemenConditions: any[] = [
      { status: 'APPROVED' },
      {
        OR: [
          { role: { name: 'Gateman' } },
          { role: { name: 'Restkeeper' } },
          { designation: { contains: 'Gateman', mode: 'insensitive' } },
          { designation: { contains: 'Restkeeper', mode: 'insensitive' } },
        ]
      }
    ];

    if (req.user.division && !isDeveloperUser(req.user)) {
      gatemenConditions.push({
        OR: [
          { division: { equals: req.user.division, mode: 'insensitive' } },
          { station: { division: { equals: req.user.division, mode: 'insensitive' } } }
        ]
      });
    }

    const gatemenUsers = await prisma.user.findMany({
      where: { AND: gatemenConditions },
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
      stations,
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
  mode: z.enum(['PERMANENT', 'SPECIFIC_WEEK', 'RESET']).optional().default('SPECIFIC_WEEK'),
  assignments: z.array(z.object({
    gatemanId: z.number().int().optional(),
    gatemanUserId: z.number().int().optional(),
    dayOfWeek: z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shiftCode: z.string().optional(), // "07-19", "19-24", "00-07", "W/R", "N/R", "-"
    startTime: z.string().default('07:00').optional(),
    endTime: z.string().default('19:00').optional(),
    shiftName: z.string().optional(),
    isSplitShift: z.boolean().optional().default(false),
    secondaryStart: z.string().optional().nullable(),
    secondaryEnd: z.string().optional().nullable(),
  })).optional().default([]),
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

    // Fetch active shift configuration for this gate or its station
    let shiftConfig: any = null;
    const dbConfig = await prisma.gateShiftConfig.findFirst({
      where: {
        OR: [
          { gateId },
          ...(gate.stationId ? [{ stationId: gate.stationId, gateId: null }] : [])
        ]
      },
      orderBy: [
        { gateId: 'desc' },
        { updatedAt: 'desc' }
      ]
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

    if (!shiftConfig) {
      shiftConfig = {
        id: null,
        name: DEFAULT_3_SHIFT_CONFIG.name,
        shifts: DEFAULT_3_SHIFT_CONFIG.shifts,
        isDefault: true
      };
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

    // Fetch assigned Gatemen and Restkeepers for this gate (exclude supervisors, PWI, station masters)
    const assignedUserGates = await prisma.userGate.findMany({
      where: {
        gateId,
        user: {
          status: 'APPROVED',
          OR: [
            { role: { name: { in: ['Gateman', 'Restkeeper'] } } },
            { designation: { contains: 'Gateman', mode: 'insensitive' } },
            { designation: { contains: 'Restkeeper', mode: 'insensitive' } },
          ],
        },
      },
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

    // If fewer than 3 staff members assigned, fetch additional available Gatemen/Restkeepers from station or division
    if (staffList.length < 3 && gate.stationId) {
      const additionalStaff = await prisma.user.findMany({
        where: {
          stationId: gate.stationId,
          status: 'APPROVED',
          OR: [
            { role: { name: { in: ['Gateman', 'Restkeeper'] } } },
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
        take: 3 - staffList.length,
      });
      staffList = [...staffList, ...additionalStaff];
    }

    const gateDivision = gate.division || gate.station?.division || req.user.division;

    if (staffList.length < 3 && gateDivision) {
      const additionalStaff = await prisma.user.findMany({
        where: {
          status: 'APPROVED',
          OR: [
            { division: { equals: gateDivision, mode: 'insensitive' } },
            { station: { division: { equals: gateDivision, mode: 'insensitive' } } },
          ],
          AND: [
            {
              OR: [
                { role: { name: { in: ['Gateman', 'Restkeeper'] } } },
                { designation: { contains: 'Gateman', mode: 'insensitive' } },
                { designation: { contains: 'Restkeeper', mode: 'insensitive' } },
              ],
            },
            { id: { notIn: staffList.map(s => s.id) } },
          ],
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
        take: 3 - staffList.length,
      });
      staffList = [...staffList, ...additionalStaff];
    }

    // 1. Fetch specific date overrides for this week
    const specificEntries = await prisma.gateDutyRoster.findMany({
      where: {
        gateId,
        date: { in: weekDates },
        isPermanent: false,
      },
      include: {
        gateman: { select: { id: true, fullName: true, employeeId: true } },
        createdBy: { select: { id: true, fullName: true, designation: true } },
      },
    });

    // 2. Fetch permanent master cycle entries for this gate (repeats across all 52 weeks)
    const permanentEntries = await prisma.gateDutyRoster.findMany({
      where: {
        gateId,
        isPermanent: true,
      },
      include: {
        gateman: { select: { id: true, fullName: true, employeeId: true } },
        createdBy: { select: { id: true, fullName: true, designation: true } },
      },
    });

    // 3. Build staff 7-day matrix dynamically (2-tier fallback: Specific override takes precedence, else Permanent Master Cycle)
    const matrix = staffList.map(staff => {
      const schedule: Record<string, any> = {};

      for (const wd of weekDays) {
        // Priority 1: Check for date-specific override
        const overrideEntry = specificEntries.find(e => e.gatemanUserId === staff.id && e.date === wd.date);
        if (overrideEntry) {
          schedule[wd.dayOfWeek] = {
            id: overrideEntry.id,
            date: overrideEntry.date,
            shiftCode: overrideEntry.shiftCode || (overrideEntry.startTime && overrideEntry.endTime ? `${overrideEntry.startTime.slice(0, 2)}-${overrideEntry.endTime.slice(0, 2)}` : '07-19'),
            shiftName: overrideEntry.shiftName,
            startTime: overrideEntry.startTime,
            endTime: overrideEntry.endTime,
            isSplitShift: overrideEntry.isSplitShift,
            secondaryStart: overrideEntry.secondaryStart,
            secondaryEnd: overrideEntry.secondaryEnd,
            isOverride: true,
            source: 'SPECIFIC_OVERRIDE',
          };
          continue;
        }

        // Priority 2: Check for permanent standing master cycle
        const permEntry = permanentEntries.find(e => e.gatemanUserId === staff.id && e.dayOfWeek === wd.dayOfWeek);
        if (permEntry) {
          schedule[wd.dayOfWeek] = {
            id: permEntry.id,
            date: wd.date,
            shiftCode: permEntry.shiftCode || (permEntry.startTime && permEntry.endTime ? `${permEntry.startTime.slice(0, 2)}-${permEntry.endTime.slice(0, 2)}` : '07-19'),
            shiftName: permEntry.shiftName,
            startTime: permEntry.startTime,
            endTime: permEntry.endTime,
            isSplitShift: permEntry.isSplitShift,
            secondaryStart: permEntry.secondaryStart,
            secondaryEnd: permEntry.secondaryEnd,
            isOverride: false,
            source: 'PERMANENT_CYCLE',
          };
          continue;
        }

        // Priority 3: Not assigned
        schedule[wd.dayOfWeek] = {
          id: null,
          date: wd.date,
          shiftCode: '-',
          shiftName: 'Off / Not Assigned',
          startTime: '07:00',
          endTime: '19:00',
          isSplitShift: false,
          isOverride: false,
          source: 'UNASSIGNED',
        };
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
    const lastEntry = specificEntries[0] || permanentEntries[0];
    const preparedByName = lastEntry?.createdBy
      ? `${lastEntry.createdBy.fullName} (${lastEntry.createdBy.designation || 'PWI'})`
      : 'वरिष्ठ/कनिष्ठ सेक्शन इंजीनियर (SSE/JE P.WAY INCHARGE)';

    return res.json({
      success: true,
      gate: {
        id: gate.id,
        lcNumber: gate.lcNumber,
        locationName: gate.locationName,
        stationId: gate.stationId,
        stationName: gate.station ? `${gate.station.name} (${gate.station.code})` : 'N/A',
        division: gate.station?.division || 'Central Railway',
      },
      station: gate.station,
      shiftConfig,
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
      hasPermanentRoster: permanentEntries.length > 0,
      overridesCount: specificEntries.length,
      hasOverridesThisWeek: specificEntries.length > 0,
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
    const mode = data.mode || 'SPECIFIC_WEEK';

    // Collect week dates for cleanup/reset operations
    const startDate = new Date(data.weekStartDate + 'T00:00:00Z');
    const weekDates = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = new Date(startDate);
      d.setUTCDate(startDate.getUTCDate() + i);
      return d.toISOString().split('T')[0];
    });

    // -------------------------------------------------------------
    // MODE: RESET (Revert specific week back to Permanent Master Cycle)
    // -------------------------------------------------------------
    if (mode === 'RESET') {
      const deleted = await prisma.gateDutyRoster.deleteMany({
        where: {
          gateId: data.gateId,
          date: { in: weekDates },
          isPermanent: false,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'RESET_WEEKLY_ROSTER',
          details: `Reset week ${data.weekStartDate} for LC Gate ${gate.lcNumber} to Permanent Master Roster (removed ${deleted.count} overrides) by ${req.user.role}`,
        },
      });

      return res.json({
        success: true,
        mode: 'RESET',
        message: `Week ${data.weekStartDate} has been reset to follow the Permanent Master Roster cycle.`,
        clearedCount: deleted.count,
      });
    }

    const results = [];

    // -------------------------------------------------------------
    // MODE: PERMANENT (Sets 52-week recurring Master Cycle)
    // -------------------------------------------------------------
    if (mode === 'PERMANENT') {
      // Clear old permanent entries for this gate so new master cycle cleanly replaces it
      await prisma.gateDutyRoster.deleteMany({
        where: {
          gateId: data.gateId,
          isPermanent: true,
        },
      });

      for (const item of data.assignments) {
        if (item.shiftCode === '-') continue;

        const targetUserId = item.gatemanId ?? item.gatemanUserId ?? 0;
        if (!targetUserId) continue;

        const permShiftName = `${item.dayOfWeek}_${targetUserId}`;

        const permEntry = await prisma.gateDutyRoster.create({
          data: {
            gateId: data.gateId,
            stationId,
            date: 'PERMANENT',
            shiftName: permShiftName,
            startTime: item.startTime || '07:00',
            endTime: item.endTime || '19:00',
            gatemanUserId: targetUserId,
            createdById: req.user.id,
            weekStartDate: 'PERMANENT',
            dayOfWeek: item.dayOfWeek,
            shiftCode: item.shiftCode,
            isPermanent: true,
            isSplitShift: item.isSplitShift || false,
            secondaryStart: item.secondaryStart || null,
            secondaryEnd: item.secondaryEnd || null,
          },
        });

        results.push(permEntry);
      }

      // Purge any old overrides for this week so current week immediately shows the new permanent baseline
      await prisma.gateDutyRoster.deleteMany({
        where: {
          gateId: data.gateId,
          date: { in: weekDates },
          isPermanent: false,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'PUBLISH_PERMANENT_ROSTER',
          details: `Published Permanent Master Roster for LC Gate ${gate.lcNumber} (7-day cycle, ${results.length} shifts, all 52 weeks) by ${req.user.role}`,
        },
      });

      return res.json({
        success: true,
        mode: 'PERMANENT',
        message: `Permanent Master Duty Roster for LC Gate ${gate.lcNumber} published. This 7-day cycle will repeat automatically across all 52 weeks of the year.`,
        gateNumber: gate.lcNumber,
        assignedCount: results.length,
      });
    }

    // -------------------------------------------------------------
    // MODE: SPECIFIC_WEEK (Creates temporary overrides for this week only)
    // -------------------------------------------------------------
    // First clear existing specific overrides for this week to avoid duplicate or orphaned shift entries
    await prisma.gateDutyRoster.deleteMany({
      where: {
        gateId: data.gateId,
        date: { in: weekDates },
        isPermanent: false,
      },
    });

    for (const item of data.assignments) {
      if (item.shiftCode === '-') continue;

      const targetUserId = item.gatemanId ?? item.gatemanUserId ?? 0;
      if (!targetUserId) continue;

      const resolvedShiftName = item.shiftName ||
        (item.shiftCode === '07-19' ? 'Day Shift (07:00 - 19:00)' :
         item.shiftCode === '19-24' ? 'Evening Shift (19:00 - 24:00)' :
         item.shiftCode === '00-07' ? 'Night Shift (00:00 - 07:00)' :
         item.shiftCode === 'W/R' ? 'Weekly Rest (W/R)' :
         item.shiftCode === 'N/R' ? 'Night Rest (N/R)' : `Shift ${item.shiftCode}`);

      const entry = await prisma.gateDutyRoster.create({
        data: {
          gateId: data.gateId,
          stationId,
          date: item.date || weekDates[0],
          shiftName: resolvedShiftName,
          startTime: item.startTime || '07:00',
          endTime: item.endTime || '19:00',
          gatemanUserId: targetUserId,
          createdById: req.user.id,
          weekStartDate: data.weekStartDate,
          dayOfWeek: item.dayOfWeek,
          shiftCode: item.shiftCode,
          isPermanent: false,
          isSplitShift: item.isSplitShift || false,
          secondaryStart: item.secondaryStart || null,
          secondaryEnd: item.secondaryEnd || null,
        },
      });

      results.push(entry);
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'PUBLISH_SPECIFIC_WEEK_ROSTER',
        details: `Published specific week overrides for LC Gate ${gate.lcNumber} (Week: ${data.weekStartDate}, ${results.length} assignments) by ${req.user.role}`,
      },
    });

    return res.json({
      success: true,
      mode: 'SPECIFIC_WEEK',
      message: `Specific week duty roster for LC Gate ${gate.lcNumber} published. Other weeks remain on their standard cycle.`,
      gateNumber: gate.lcNumber,
      weekStartDate: data.weekStartDate,
      assignedCount: results.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/roster/scan-chart
 * Multimodal OCR endpoint using Google Gemini Vision API to extract weekly duty roster charts
 * from camera photos or scanned documents prepared by PWI and countersigned by CPWI.
 */
router.post('/scan-chart', upload.single('image'), async (req: any, res, next) => {
  try {
    if (!isRosterAuthor(req.user)) {
      return res.status(403).json({
        error: 'Forbidden: Roster charts can only be prepared by PWI primarily or CPWI.',
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        error: 'No image file uploaded. Please provide a clear photo of the roster chart in the "image" field.',
      });
    }

    const hintGateId = req.body.gateId ? parseInt(req.body.gateId, 10) : undefined;
    const hintStationId = req.body.stationId ? parseInt(req.body.stationId, 10) : undefined;
    const weekStartDate = req.body.weekStartDate as string | undefined;

    const result = await analyzeRosterChartWithGemini(
      req.file.buffer,
      req.file.mimetype || 'image/jpeg',
      {
        division: req.user.division,
        hintGateId,
        hintStationId,
        weekStartDate,
      }
    );

    return res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('[RosterScan] Error processing chart:', error);
    return res.status(500).json({
      error: error.message || 'Failed to process duty roster chart image with Gemini Vision.',
    });
  }
});

export default router;
