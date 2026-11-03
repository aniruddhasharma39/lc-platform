import { prisma } from './prisma';

export interface GateMetadata {
  id: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  zone: string | null;
  division: string | null;
  scopeGroupName?: string | null;
}

export interface DailyCycleMetric {
  dateStr: string; // 'YYYY-MM-DD'
  dateFormatted: string; // '01 October 2026'
  completedCycles: number;
  avgClosingSeconds: number;
  avgClosingFormatted: string;
  avgOpeningSeconds: number;
  avgOpeningFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
}

export interface GateCycleKPIs {
  totalCycles: number;
  avgClosingSeconds: number;
  avgClosingFormatted: string;
  avgOpeningSeconds: number;
  avgOpeningFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
}

export interface GateCycleReport {
  gate: GateMetadata;
  kpis: GateCycleKPIs;
  dailyBreakdown: DailyCycleMetric[];
}

export interface OverallCycleSummary {
  totalCycles: number;
  avgClosingSeconds: number;
  avgClosingFormatted: string;
  avgOpeningSeconds: number;
  avgOpeningFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  reportingGatesCount: number;
}

export interface FullCycleAnalyticsResponse {
  startDate: string;
  endDate: string;
  overall: OverallCycleSummary;
  gateReports: GateCycleReport[];
}

/**
 * Convert Date to YYYY-MM-DD string in Indian Standard Time (IST)
 */
export function getISTDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

/**
 * Format date nicely in IST: e.g. "01 October 2026"
 */
export function formatISTDateDisplay(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }).format(dateObj);
  } catch {
    return dateStr;
  }
}

/**
 * Format duration in seconds to human readable string: e.g. "2h 15m 30s", "5m 20s", "45s"
 */
export function formatDurationHuman(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Generate all calendar date strings (YYYY-MM-DD) between start and end inclusive
 */
export function generateDateRangeList(startDateStr: string, endDateStr: string): string[] {
  const dates: string[] = [];
  const [sY, sM, sD] = startDateStr.split('-').map(Number);
  const [eY, eM, eD] = endDateStr.split('-').map(Number);

  const cur = new Date(Date.UTC(sY, sM - 1, sD, 12, 0, 0));
  const end = new Date(Date.UTC(eY, eM - 1, eD, 12, 0, 0));

  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return dates;
}

/**
 * Compute UTC date boundaries for an IST date range
 */
export function getISTUtcDateBounds(startDateStr: string, endDateStr: string): { startUtc: Date; endUtc: Date } {
  const [sY, sM, sD] = startDateStr.split('-').map(Number);
  const [eY, eM, eD] = endDateStr.split('-').map(Number);

  // IST is UTC + 5:30.
  // 00:00:00.000 IST is previous day 18:30:00.000 UTC
  const startUtc = new Date(Date.UTC(sY, sM - 1, sD, 0, 0, 0, 0) - (5.5 * 3600000));
  // 23:59:59.999 IST is current day 18:29:59.999 UTC
  const endUtc = new Date(Date.UTC(eY, eM - 1, eD, 23, 59, 59, 999) - (5.5 * 3600000));

  return { startUtc, endUtc };
}

/**
 * Core cycle analytics calculator for a single gate
 */
export function calculateGateCycleAnalytics(
  gate: GateMetadata,
  rawEvents: Array<{
    id: number;
    gateId: number;
    openedAt: Date;
    closedAt: Date | null;
    durationSeconds: number | null;
    status: string;
  }>,
  startDateStr: string,
  endDateStr: string
): GateCycleReport {
  // 1. Filter only valid, completed cycles:
  // Must have status !== 'OPEN', closedAt !== null, openedAt !== null, and closedAt > openedAt
  const completedEvents = rawEvents
    .filter(ev => {
      if (ev.status === 'OPEN' || !ev.closedAt || !ev.openedAt) return false;
      return new Date(ev.closedAt).getTime() > new Date(ev.openedAt).getTime();
    })
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());

  // 2. Deduplicate near-identical events if any
  const deduplicated: typeof completedEvents = [];
  for (const ev of completedEvents) {
    const last = deduplicated[deduplicated.length - 1];
    if (last) {
      const timeDiff = Math.abs(new Date(ev.openedAt).getTime() - new Date(last.openedAt).getTime());
      if (timeDiff < 1000 && ev.durationSeconds === last.durationSeconds) {
        continue; // duplicate transition record
      }
    }
    deduplicated.push(ev);
  }

  // 3. Compute closing durations & opening intervals
  let totalClosedSeconds = 0;
  const openingIntervals: number[] = [];

  for (let i = 0; i < deduplicated.length; i++) {
    const cur = deduplicated[i];
    const dur = cur.durationSeconds && cur.durationSeconds > 0
      ? cur.durationSeconds
      : Math.max(1, Math.round((new Date(cur.closedAt!).getTime() - new Date(cur.openedAt).getTime()) / 1000));
    totalClosedSeconds += dur;

    if (i < deduplicated.length - 1) {
      const next = deduplicated[i + 1];
      const openInterval = Math.round((new Date(next.openedAt).getTime() - new Date(cur.closedAt!).getTime()) / 1000);
      if (openInterval >= 0) {
        openingIntervals.push(openInterval);
      }
    }
  }

  const totalCycles = deduplicated.length;
  const avgClosingSeconds = totalCycles > 0 ? Math.round(totalClosedSeconds / totalCycles) : 0;
  const avgOpeningSeconds = openingIntervals.length > 0
    ? Math.round(openingIntervals.reduce((a, b) => a + b, 0) / openingIntervals.length)
    : 0;

  const dateList = generateDateRangeList(startDateStr, endDateStr);
  const totalDays = Math.max(1, dateList.length);
  const totalPeriodSeconds = totalDays * 86400;
  const totalOpenSeconds = Math.max(0, totalPeriodSeconds - totalClosedSeconds);

  const kpis: GateCycleKPIs = {
    totalCycles,
    avgClosingSeconds,
    avgClosingFormatted: totalCycles > 0 ? formatDurationHuman(avgClosingSeconds) : '—',
    avgOpeningSeconds,
    avgOpeningFormatted: openingIntervals.length > 0 ? formatDurationHuman(avgOpeningSeconds) : '—',
    totalClosedSeconds,
    totalClosedFormatted: formatDurationHuman(totalClosedSeconds),
    totalOpenSeconds,
    totalOpenFormatted: formatDurationHuman(totalOpenSeconds)
  };

  // 4. Daily aggregation
  const dailyMap = new Map<string, typeof deduplicated>();
  for (const date of dateList) {
    dailyMap.set(date, []);
  }

  for (const ev of deduplicated) {
    const dStr = getISTDateString(new Date(ev.openedAt));
    if (dailyMap.has(dStr)) {
      dailyMap.get(dStr)!.push(ev);
    }
  }

  const dailyBreakdown: DailyCycleMetric[] = [];

  for (const dateStr of dateList) {
    const dayEvents = dailyMap.get(dateStr) || [];
    const count = dayEvents.length;

    let dayClosedSec = 0;
    const dayOpenIntervals: number[] = [];

    for (let i = 0; i < dayEvents.length; i++) {
      const e = dayEvents[i];
      const dur = e.durationSeconds && e.durationSeconds > 0
        ? e.durationSeconds
        : Math.max(1, Math.round((new Date(e.closedAt!).getTime() - new Date(e.openedAt).getTime()) / 1000));
      dayClosedSec += dur;

      if (i < dayEvents.length - 1) {
        const nextE = dayEvents[i + 1];
        const openInt = Math.round((new Date(nextE.openedAt).getTime() - new Date(e.closedAt!).getTime()) / 1000);
        if (openInt >= 0) {
          dayOpenIntervals.push(openInt);
        }
      }
    }

    const dayAvgClose = count > 0 ? Math.round(dayClosedSec / count) : 0;
    const dayAvgOpen = dayOpenIntervals.length > 0
      ? Math.round(dayOpenIntervals.reduce((a, b) => a + b, 0) / dayOpenIntervals.length)
      : 0;

    const dayOpenSec = Math.max(0, 86400 - dayClosedSec);

    dailyBreakdown.push({
      dateStr,
      dateFormatted: formatISTDateDisplay(dateStr),
      completedCycles: count,
      avgClosingSeconds: dayAvgClose,
      avgClosingFormatted: count > 0 ? formatDurationHuman(dayAvgClose) : '—',
      avgOpeningSeconds: dayAvgOpen,
      avgOpeningFormatted: dayOpenIntervals.length > 0 ? formatDurationHuman(dayAvgOpen) : '—',
      totalClosedSeconds: dayClosedSec,
      totalClosedFormatted: count > 0 ? formatDurationHuman(dayClosedSec) : '0s',
      totalOpenSeconds: dayOpenSec,
      totalOpenFormatted: formatDurationHuman(dayOpenSec)
    });
  }

  return {
    gate,
    kpis,
    dailyBreakdown
  };
}

/**
 * Fetch and compute full cycle analytics across multiple target gates
 */
export async function getFullCycleAnalytics(params: {
  targetGateIds: number[];
  targetScopeGroupIds: number[];
  startDateStr: string;
  endDateStr: string;
}): Promise<FullCycleAnalyticsResponse> {
  const { targetGateIds, startDateStr, endDateStr } = params;

  if (targetGateIds.length === 0) {
    return {
      startDate: startDateStr,
      endDate: endDateStr,
      overall: {
        totalCycles: 0,
        avgClosingSeconds: 0,
        avgClosingFormatted: '—',
        avgOpeningSeconds: 0,
        avgOpeningFormatted: '—',
        totalClosedSeconds: 0,
        totalClosedFormatted: '0s',
        totalOpenSeconds: 0,
        totalOpenFormatted: '0s',
        reportingGatesCount: 0
      },
      gateReports: []
    };
  }

  // 1. Fetch gate details
  const gates = await prisma.lCGate.findMany({
    where: { id: { in: targetGateIds } },
    include: {
      scopeGroups: {
        include: { scopeGroup: { select: { id: true, name: true, color: true } } }
      }
    },
    orderBy: { lcNumber: 'asc' }
  });

  const { startUtc, endUtc } = getISTUtcDateBounds(startDateStr, endDateStr);

  // 2. Fetch events across these gates in date window
  const rawEvents = await prisma.lCGateEvent.findMany({
    where: {
      gateId: { in: targetGateIds },
      openedAt: {
        gte: startUtc,
        lte: endUtc
      }
    },
    select: {
      id: true,
      gateId: true,
      openedAt: true,
      closedAt: true,
      durationSeconds: true,
      status: true
    },
    orderBy: { openedAt: 'asc' }
  });

  // Group events by gateId
  const eventsByGate = new Map<number, typeof rawEvents>();
  for (const g of gates) {
    eventsByGate.set(g.id, []);
  }
  for (const ev of rawEvents) {
    if (eventsByGate.has(ev.gateId)) {
      eventsByGate.get(ev.gateId)!.push(ev);
    }
  }

  // 3. Compute per-gate cycle reports
  const gateReports: GateCycleReport[] = [];
  let overallTotalCycles = 0;
  let overallTotalClosedSeconds = 0;
  const overallOpeningIntervals: number[] = [];

  for (const g of gates) {
    const scopeGroup = g.scopeGroups.find(sg => params.targetScopeGroupIds.includes(sg.scopeGroup.id))?.scopeGroup
      || g.scopeGroups[0]?.scopeGroup
      || null;

    const gateMeta: GateMetadata = {
      id: g.id,
      lcNumber: g.lcNumber,
      name: g.name,
      locationName: g.locationName,
      zone: g.zone,
      division: g.division,
      scopeGroupName: scopeGroup?.name || 'Unassigned'
    };

    const gEvents = eventsByGate.get(g.id) || [];
    const rep = calculateGateCycleAnalytics(gateMeta, gEvents, startDateStr, endDateStr);
    gateReports.push(rep);

    overallTotalCycles += rep.kpis.totalCycles;
    overallTotalClosedSeconds += rep.kpis.totalClosedSeconds;
    if (rep.kpis.avgOpeningSeconds > 0 && rep.dailyBreakdown.length > 0) {
      // Collect valid intervals from daily breakdown
      for (const d of rep.dailyBreakdown) {
        if (d.avgOpeningSeconds > 0) {
          overallOpeningIntervals.push(d.avgOpeningSeconds);
        }
      }
    }
  }

  const dateList = generateDateRangeList(startDateStr, endDateStr);
  const totalDays = Math.max(1, dateList.length);
  const totalGates = gates.length;
  const totalPeriodSeconds = totalDays * 86400 * totalGates;
  const overallTotalOpenSeconds = Math.max(0, totalPeriodSeconds - overallTotalClosedSeconds);

  const overallAvgClosingSec = overallTotalCycles > 0
    ? Math.round(overallTotalClosedSeconds / overallTotalCycles)
    : 0;

  const overallAvgOpeningSec = overallOpeningIntervals.length > 0
    ? Math.round(overallOpeningIntervals.reduce((a, b) => a + b, 0) / overallOpeningIntervals.length)
    : 0;

  const overall: OverallCycleSummary = {
    totalCycles: overallTotalCycles,
    avgClosingSeconds: overallAvgClosingSec,
    avgClosingFormatted: overallTotalCycles > 0 ? formatDurationHuman(overallAvgClosingSec) : '—',
    avgOpeningSeconds: overallAvgOpeningSec,
    avgOpeningFormatted: overallOpeningIntervals.length > 0 ? formatDurationHuman(overallAvgOpeningSec) : '—',
    totalClosedSeconds: overallTotalClosedSeconds,
    totalClosedFormatted: formatDurationHuman(overallTotalClosedSeconds),
    totalOpenSeconds: overallTotalOpenSeconds,
    totalOpenFormatted: formatDurationHuman(overallTotalOpenSeconds),
    reportingGatesCount: totalGates
  };

  return {
    startDate: startDateStr,
    endDate: endDateStr,
    overall,
    gateReports
  };
}

