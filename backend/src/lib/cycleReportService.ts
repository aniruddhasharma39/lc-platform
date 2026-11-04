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
    const scopeGroup: any = null;

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



// ============================================================================
// COUNT REPORT INTERFACES & ANALYTICS
// ============================================================================

export interface GateCountItem {
  gateId: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  zone: string | null;
  division: string | null;
  stationId: number | null;
  stationName: string | null;
  stationCode: string | null;
  openCount: number;
  closeCount: number;
  totalOperations: number;
}

export interface StationCountItem {
  stationId: number | null;
  stationName: string;
  stationCode: string;
  zone: string;
  division: string;
  gatesCount: number;
  openCount: number;
  closeCount: number;
  totalOperations: number;
  gates: GateCountItem[];
}

export interface DivisionCountItem {
  division: string;
  zone: string;
  stationCount: number;
  gatesCount: number;
  openCount: number;
  closeCount: number;
  totalOperations: number;
  stations: StationCountItem[];
}

export interface ZoneCountItem {
  zone: string;
  divisionCount: number;
  stationCount: number;
  gatesCount: number;
  openCount: number;
  closeCount: number;
  totalOperations: number;
  divisions: DivisionCountItem[];
}

export interface CountReportResponse {
  startDate: string;
  endDate: string;
  kpis: {
    totalOperations: number;
    totalOpenCount: number;
    totalCloseCount: number;
    reportingGatesCount: number;
    peakOperationGate: {
      lcNumber: string;
      operations: number;
      locationName: string;
    } | null;
  };
  gates: GateCountItem[];
  stations: StationCountItem[];
  divisions: DivisionCountItem[];
  zones: ZoneCountItem[];
}

export async function getCountReportAnalytics(options: {
  targetGateIds: number[];
  startDateStr: string;
  endDateStr: string;
}): Promise<CountReportResponse> {
  const { targetGateIds, startDateStr, endDateStr } = options;

  const gates = await prisma.lCGate.findMany({
    where: { id: { in: targetGateIds } },
    include: { station: true },
    orderBy: { lcNumber: 'asc' }
  });

  const { startUtc, endUtc } = getISTUtcDateBounds(startDateStr, endDateStr);

  const rawEvents = await prisma.lCGateEvent.findMany({
    where: {
      gateId: { in: targetGateIds },
      openedAt: { gte: startUtc, lte: endUtc }
    },
    select: {
      id: true,
      gateId: true,
      openedAt: true,
      closedAt: true,
      status: true
    }
  });

  const gateEventsMap = new Map<number, typeof rawEvents>();
  for (const g of gates) gateEventsMap.set(g.id, []);
  for (const ev of rawEvents) {
    if (gateEventsMap.has(ev.gateId)) {
      gateEventsMap.get(ev.gateId)!.push(ev);
    }
  }

  const gateItems: GateCountItem[] = [];
  let grandTotalOperations = 0;
  let grandOpenCount = 0;
  let grandCloseCount = 0;
  let peakGate: { lcNumber: string; operations: number; locationName: string } | null = null;

  for (const g of gates) {
    const evs = gateEventsMap.get(g.id) || [];
    const openCount = evs.length;
    const closeCount = evs.filter(e => e.closedAt !== null || e.status === 'CLOSED').length;
    const totalOps = openCount + closeCount;

    grandOpenCount += openCount;
    grandCloseCount += closeCount;
    grandTotalOperations += totalOps;

    if (!peakGate || totalOps > peakGate.operations) {
      peakGate = { lcNumber: g.lcNumber, operations: totalOps, locationName: g.name || g.locationName };
    }

    gateItems.push({
      gateId: g.id,
      lcNumber: g.lcNumber,
      name: g.name,
      locationName: g.name || g.locationName,
      zone: g.zone || 'Indian Railways',
      division: g.division || 'Division',
      stationId: g.stationId,
      stationName: g.station?.name || 'Unassigned Station',
      stationCode: g.station?.code || '—',
      openCount,
      closeCount,
      totalOperations: totalOps
    });
  }

  // Aggregate by Station
  const stationMap = new Map<string, StationCountItem>();
  for (const item of gateItems) {
    const sKey = item.stationId ? `ID_${item.stationId}` : `NAME_${item.stationName}`;
    if (!stationMap.has(sKey)) {
      stationMap.set(sKey, {
        stationId: item.stationId,
        stationName: item.stationName || 'Unassigned Station',
        stationCode: item.stationCode || '—',
        zone: item.zone || 'Indian Railways',
        division: item.division || 'Division',
        gatesCount: 0,
        openCount: 0,
        closeCount: 0,
        totalOperations: 0,
        gates: []
      });
    }
    const st = stationMap.get(sKey)!;
    st.gatesCount += 1;
    st.openCount += item.openCount;
    st.closeCount += item.closeCount;
    st.totalOperations += item.totalOperations;
    st.gates.push(item);
  }
  const stationItems = Array.from(stationMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  // Aggregate by Division
  const divisionMap = new Map<string, DivisionCountItem>();
  for (const st of stationItems) {
    const dKey = st.division;
    if (!divisionMap.has(dKey)) {
      divisionMap.set(dKey, {
        division: st.division,
        zone: st.zone,
        stationCount: 0,
        gatesCount: 0,
        openCount: 0,
        closeCount: 0,
        totalOperations: 0,
        stations: []
      });
    }
    const div = divisionMap.get(dKey)!;
    div.stationCount += 1;
    div.gatesCount += st.gatesCount;
    div.openCount += st.openCount;
    div.closeCount += st.closeCount;
    div.totalOperations += st.totalOperations;
    div.stations.push(st);
  }
  const divisionItems = Array.from(divisionMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  // Aggregate by Zone
  const zoneMap = new Map<string, ZoneCountItem>();
  for (const div of divisionItems) {
    const zKey = div.zone;
    if (!zoneMap.has(zKey)) {
      zoneMap.set(zKey, {
        zone: div.zone,
        divisionCount: 0,
        stationCount: 0,
        gatesCount: 0,
        openCount: 0,
        closeCount: 0,
        totalOperations: 0,
        divisions: []
      });
    }
    const zn = zoneMap.get(zKey)!;
    zn.divisionCount += 1;
    zn.stationCount += div.stationCount;
    zn.gatesCount += div.gatesCount;
    zn.openCount += div.openCount;
    zn.closeCount += div.closeCount;
    zn.totalOperations += div.totalOperations;
    zn.divisions.push(div);
  }
  const zoneItems = Array.from(zoneMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  return {
    startDate: startDateStr,
    endDate: endDateStr,
    kpis: {
      totalOperations: grandTotalOperations,
      totalOpenCount: grandOpenCount,
      totalCloseCount: grandCloseCount,
      reportingGatesCount: gates.length,
      peakOperationGate: peakGate
    },
    gates: gateItems,
    stations: stationItems,
    divisions: divisionItems,
    zones: zoneItems
  };
}

// ============================================================================
// DURATION REPORT INTERFACES & ANALYTICS
// ============================================================================

export interface GateDurationItem {
  gateId: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  zone: string | null;
  division: string | null;
  stationId: number | null;
  stationName: string | null;
  stationCode: string | null;
  totalCompletedCycles: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  avgClosedSeconds: number;
  avgClosedFormatted: string;
  extendedDelaysCount: number;
  dailyBreakdown: DailyCycleMetric[];
}

export interface DurationReportResponse {
  startDate: string;
  endDate: string;
  kpis: {
    totalOpenSeconds: number;
    totalOpenFormatted: string;
    avgOpenSeconds: number;
    avgOpenFormatted: string;
    totalClosedSeconds: number;
    totalClosedFormatted: string;
    avgClosedSeconds: number;
    avgClosedFormatted: string;
    totalCompletedCycles: number;
    totalExtendedDelays: number;
    reportingGatesCount: number;
  };
  gates: GateDurationItem[];
}

export async function getDurationReportAnalytics(options: {
  targetGateIds: number[];
  startDateStr: string;
  endDateStr: string;
}): Promise<DurationReportResponse> {
  const { targetGateIds, startDateStr, endDateStr } = options;

  const gates = await prisma.lCGate.findMany({
    where: { id: { in: targetGateIds } },
    include: { station: true },
    orderBy: { lcNumber: 'asc' }
  });

  const { startUtc, endUtc } = getISTUtcDateBounds(startDateStr, endDateStr);

  const rawEvents = await prisma.lCGateEvent.findMany({
    where: {
      gateId: { in: targetGateIds },
      openedAt: { gte: startUtc, lte: endUtc }
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

  const gateEventsMap = new Map<number, typeof rawEvents>();
  for (const g of gates) gateEventsMap.set(g.id, []);
  for (const ev of rawEvents) {
    if (gateEventsMap.has(ev.gateId)) {
      gateEventsMap.get(ev.gateId)!.push(ev);
    }
  }

  const gateDurationItems: GateDurationItem[] = [];
  let grandOpenSec = 0;
  let grandClosedSec = 0;
  let grandCycles = 0;
  let grandExtendedDelays = 0;
  const grandOpenDurations: number[] = [];

  const dateList = generateDateRangeList(startDateStr, endDateStr);
  const totalDays = Math.max(1, dateList.length);
  const secondsInPeriod = totalDays * 86400;

  for (const g of gates) {
    const gEvents = gateEventsMap.get(g.id) || [];
    const completed = gEvents.filter(ev => ev.closedAt && new Date(ev.closedAt).getTime() > new Date(ev.openedAt).getTime());

    let gateOpenSec = 0;
    let extendedDelays = 0;

    for (const ev of completed) {
      const dur = ev.durationSeconds && ev.durationSeconds > 0
        ? ev.durationSeconds
        : Math.max(1, Math.round((new Date(ev.closedAt!).getTime() - new Date(ev.openedAt).getTime()) / 1000));
      gateOpenSec += dur;
      grandOpenDurations.push(dur);
      if (dur > 900) { // Extended delay: > 15 minutes (900 seconds)
        extendedDelays += 1;
      }
    }

    const gateClosedSec = Math.max(0, secondsInPeriod - gateOpenSec);
    const avgOpen = completed.length > 0 ? Math.round(gateOpenSec / completed.length) : 0;
    const avgClosed = completed.length > 0 ? Math.round(gateClosedSec / completed.length) : 0;

    grandOpenSec += gateOpenSec;
    grandClosedSec += gateClosedSec;
    grandCycles += completed.length;
    grandExtendedDelays += extendedDelays;

    // Daily breakdown for this gate
    const dailyMap = new Map<string, typeof completed>();
    for (const d of dateList) dailyMap.set(d, []);
    for (const ev of completed) {
      const dStr = getISTDateString(new Date(ev.openedAt));
      if (dailyMap.has(dStr)) dailyMap.get(dStr)!.push(ev);
    }

    const dailyBreakdown: DailyCycleMetric[] = [];
    for (const dStr of dateList) {
      const dEvs = dailyMap.get(dStr) || [];
      let dOpenSec = 0;
      for (const e of dEvs) {
        const dDur = e.durationSeconds && e.durationSeconds > 0
          ? e.durationSeconds
          : Math.max(1, Math.round((new Date(e.closedAt!).getTime() - new Date(e.openedAt).getTime()) / 1000));
        dOpenSec += dDur;
      }
      const dClosedSec = Math.max(0, 86400 - dOpenSec);
      const dAvgOpen = dEvs.length > 0 ? Math.round(dOpenSec / dEvs.length) : 0;
      const dAvgClosed = dEvs.length > 0 ? Math.round(dClosedSec / dEvs.length) : 0;

      dailyBreakdown.push({
        dateStr: dStr,
        dateFormatted: formatISTDateDisplay(dStr),
        completedCycles: dEvs.length,
        avgClosingSeconds: dAvgClosed,
        avgClosingFormatted: formatDurationHuman(dAvgClosed),
        avgOpeningSeconds: dAvgOpen,
        avgOpeningFormatted: formatDurationHuman(dAvgOpen),
        totalClosedSeconds: dClosedSec,
        totalClosedFormatted: formatDurationHuman(dClosedSec),
        totalOpenSeconds: dOpenSec,
        totalOpenFormatted: formatDurationHuman(dOpenSec)
      });
    }

    gateDurationItems.push({
      gateId: g.id,
      lcNumber: g.lcNumber,
      name: g.name,
      locationName: g.name || g.locationName,
      zone: g.zone || 'Indian Railways',
      division: g.division || 'Division',
      stationId: g.stationId,
      stationName: g.station?.name || 'Unassigned Station',
      stationCode: g.station?.code || '—',
      totalCompletedCycles: completed.length,
      totalOpenSeconds: gateOpenSec,
      totalOpenFormatted: formatDurationHuman(gateOpenSec),
      avgOpenSeconds: avgOpen,
      avgOpenFormatted: formatDurationHuman(avgOpen),
      totalClosedSeconds: gateClosedSec,
      totalClosedFormatted: formatDurationHuman(gateClosedSec),
      avgClosedSeconds: avgClosed,
      avgClosedFormatted: formatDurationHuman(avgClosed),
      extendedDelaysCount: extendedDelays,
      dailyBreakdown
    });
  }

  const grandAvgOpen = grandOpenDurations.length > 0
    ? Math.round(grandOpenDurations.reduce((a, b) => a + b, 0) / grandOpenDurations.length)
    : 0;
  const grandAvgClosed = grandCycles > 0 ? Math.round(grandClosedSec / grandCycles) : 0;

  return {
    startDate: startDateStr,
    endDate: endDateStr,
    kpis: {
      totalOpenSeconds: grandOpenSec,
      totalOpenFormatted: formatDurationHuman(grandOpenSec),
      avgOpenSeconds: grandAvgOpen,
      avgOpenFormatted: formatDurationHuman(grandAvgOpen),
      totalClosedSeconds: grandClosedSec,
      totalClosedFormatted: formatDurationHuman(grandClosedSec),
      avgClosedSeconds: grandAvgClosed,
      avgClosedFormatted: formatDurationHuman(grandAvgClosed),
      totalCompletedCycles: grandCycles,
      totalExtendedDelays: grandExtendedDelays,
      reportingGatesCount: gates.length
    },
    gates: gateDurationItems
  };
}

// ============================================================================
// HOLISTIC REPORT INTERFACES & ANALYTICS (CONSOLIDATED MANAGEMENT VIEW)
// ============================================================================

export interface HolisticLCItem {
  gateId: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  stationName: string | null;
  stationCode: string | null;
  division: string | null;
  zone: string | null;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
}

export interface HolisticStationItem {
  stationId: number | null;
  stationName: string;
  stationCode: string;
  division: string;
  zone: string;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  gates: HolisticLCItem[];
}

export interface HolisticDivisionItem {
  division: string;
  zone: string;
  stationCount: number;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  stations: HolisticStationItem[];
}

export interface HolisticZoneItem {
  zone: string;
  divisionCount: number;
  stationCount: number;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  divisions: HolisticDivisionItem[];
}

export interface HolisticReportResponse {
  startDate: string;
  endDate: string;
  kpis: {
    totalZones: number;
    totalDivisions: number;
    totalStations: number;
    totalGates: number;
    totalOperations: number;
    totalOpenSeconds: number;
    totalOpenFormatted: string;
    avgOpenSeconds: number;
    avgOpenFormatted: string;
    totalClosedSeconds: number;
    totalClosedFormatted: string;
    totalExtendedDelays: number;
  };
  hierarchy: HolisticZoneItem[];
  flatStations: HolisticStationItem[];
  flatGates: HolisticLCItem[];
}

export async function getHolisticReportAnalytics(options: {
  targetGateIds: number[];
  startDateStr: string;
  endDateStr: string;
}): Promise<HolisticReportResponse> {
  const { targetGateIds, startDateStr, endDateStr } = options;

  // Compute both Count and Duration analytics
  const [countRes, durationRes] = await Promise.all([
    getCountReportAnalytics({ targetGateIds, startDateStr, endDateStr }),
    getDurationReportAnalytics({ targetGateIds, startDateStr, endDateStr })
  ]);

  const durationMap = new Map<number, GateDurationItem>();
  for (const dg of durationRes.gates) {
    durationMap.set(dg.gateId, dg);
  }

  // Combine into HolisticLCItem
  const flatGates: HolisticLCItem[] = countRes.gates.map(cg => {
    const dg = durationMap.get(cg.gateId);
    return {
      gateId: cg.gateId,
      lcNumber: cg.lcNumber,
      name: cg.name,
      locationName: cg.locationName,
      stationName: cg.stationName,
      stationCode: cg.stationCode,
      division: cg.division,
      zone: cg.zone,
      totalOperations: cg.totalOperations,
      openCount: cg.openCount,
      closeCount: cg.closeCount,
      totalOpenSeconds: dg?.totalOpenSeconds || 0,
      totalOpenFormatted: dg?.totalOpenFormatted || '0s',
      avgOpenSeconds: dg?.avgOpenSeconds || 0,
      avgOpenFormatted: dg?.avgOpenFormatted || '0s',
      totalClosedSeconds: dg?.totalClosedSeconds || 0,
      totalClosedFormatted: dg?.totalClosedFormatted || '0s',
      extendedDelaysCount: dg?.extendedDelaysCount || 0
    };
  });

  // Roll up into Stations
  const stationMap = new Map<string, HolisticStationItem>();
  for (const g of flatGates) {
    const sKey = g.stationName || 'Unassigned';
    if (!stationMap.has(sKey)) {
      stationMap.set(sKey, {
        stationId: null,
        stationName: g.stationName || 'Unassigned Station',
        stationCode: g.stationCode || '—',
        division: g.division || 'Division',
        zone: g.zone || 'Indian Railways',
        gatesCount: 0,
        totalOperations: 0,
        openCount: 0,
        closeCount: 0,
        totalOpenSeconds: 0,
        totalOpenFormatted: '0s',
        avgOpenSeconds: 0,
        avgOpenFormatted: '0s',
        totalClosedSeconds: 0,
        totalClosedFormatted: '0s',
        extendedDelaysCount: 0,
        gates: []
      });
    }
    const st = stationMap.get(sKey)!;
    st.gatesCount += 1;
    st.totalOperations += g.totalOperations;
    st.openCount += g.openCount;
    st.closeCount += g.closeCount;
    st.totalOpenSeconds += g.totalOpenSeconds;
    st.totalClosedSeconds += g.totalClosedSeconds;
    st.extendedDelaysCount += g.extendedDelaysCount;
    st.gates.push(g);
  }

  for (const st of stationMap.values()) {
    st.totalOpenFormatted = formatDurationHuman(st.totalOpenSeconds);
    st.totalClosedFormatted = formatDurationHuman(st.totalClosedSeconds);
    const avgSec = st.gates.length > 0 ? Math.round(st.totalOpenSeconds / Math.max(1, st.openCount)) : 0;
    st.avgOpenSeconds = avgSec;
    st.avgOpenFormatted = formatDurationHuman(avgSec);
  }
  const flatStations = Array.from(stationMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  // Roll up into Divisions
  const divisionMap = new Map<string, HolisticDivisionItem>();
  for (const st of flatStations) {
    const dKey = st.division;
    if (!divisionMap.has(dKey)) {
      divisionMap.set(dKey, {
        division: st.division,
        zone: st.zone,
        stationCount: 0,
        gatesCount: 0,
        totalOperations: 0,
        openCount: 0,
        closeCount: 0,
        totalOpenSeconds: 0,
        totalOpenFormatted: '0s',
        avgOpenSeconds: 0,
        avgOpenFormatted: '0s',
        totalClosedSeconds: 0,
        totalClosedFormatted: '0s',
        extendedDelaysCount: 0,
        stations: []
      });
    }
    const div = divisionMap.get(dKey)!;
    div.stationCount += 1;
    div.gatesCount += st.gatesCount;
    div.totalOperations += st.totalOperations;
    div.openCount += st.openCount;
    div.closeCount += st.closeCount;
    div.totalOpenSeconds += st.totalOpenSeconds;
    div.totalClosedSeconds += st.totalClosedSeconds;
    div.extendedDelaysCount += st.extendedDelaysCount;
    div.stations.push(st);
  }

  for (const div of divisionMap.values()) {
    div.totalOpenFormatted = formatDurationHuman(div.totalOpenSeconds);
    div.totalClosedFormatted = formatDurationHuman(div.totalClosedSeconds);
    const avgSec = div.gatesCount > 0 ? Math.round(div.totalOpenSeconds / Math.max(1, div.openCount)) : 0;
    div.avgOpenSeconds = avgSec;
    div.avgOpenFormatted = formatDurationHuman(avgSec);
  }
  const divisions = Array.from(divisionMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  // Roll up into Zones
  const zoneMap = new Map<string, HolisticZoneItem>();
  for (const div of divisions) {
    const zKey = div.zone;
    if (!zoneMap.has(zKey)) {
      zoneMap.set(zKey, {
        zone: div.zone,
        divisionCount: 0,
        stationCount: 0,
        gatesCount: 0,
        totalOperations: 0,
        openCount: 0,
        closeCount: 0,
        totalOpenSeconds: 0,
        totalOpenFormatted: '0s',
        avgOpenSeconds: 0,
        avgOpenFormatted: '0s',
        totalClosedSeconds: 0,
        totalClosedFormatted: '0s',
        extendedDelaysCount: 0,
        divisions: []
      });
    }
    const zn = zoneMap.get(zKey)!;
    zn.divisionCount += 1;
    zn.stationCount += div.stationCount;
    zn.gatesCount += div.gatesCount;
    zn.totalOperations += div.totalOperations;
    zn.openCount += div.openCount;
    zn.closeCount += div.closeCount;
    zn.totalOpenSeconds += div.totalOpenSeconds;
    zn.totalClosedSeconds += div.totalClosedSeconds;
    zn.extendedDelaysCount += div.extendedDelaysCount;
    zn.divisions.push(div);
  }

  for (const zn of zoneMap.values()) {
    zn.totalOpenFormatted = formatDurationHuman(zn.totalOpenSeconds);
    zn.totalClosedFormatted = formatDurationHuman(zn.totalClosedSeconds);
    const avgSec = zn.gatesCount > 0 ? Math.round(zn.totalOpenSeconds / Math.max(1, zn.openCount)) : 0;
    zn.avgOpenSeconds = avgSec;
    zn.avgOpenFormatted = formatDurationHuman(avgSec);
  }
  const hierarchy = Array.from(zoneMap.values()).sort((a, b) => b.totalOperations - a.totalOperations);

  return {
    startDate: startDateStr,
    endDate: endDateStr,
    kpis: {
      totalZones: hierarchy.length,
      totalDivisions: divisions.length,
      totalStations: flatStations.length,
      totalGates: flatGates.length,
      totalOperations: countRes.kpis.totalOperations,
      totalOpenSeconds: durationRes.kpis.totalOpenSeconds,
      totalOpenFormatted: durationRes.kpis.totalOpenFormatted,
      avgOpenSeconds: durationRes.kpis.avgOpenSeconds,
      avgOpenFormatted: durationRes.kpis.avgOpenFormatted,
      totalClosedSeconds: durationRes.kpis.totalClosedSeconds,
      totalClosedFormatted: durationRes.kpis.totalClosedFormatted,
      totalExtendedDelays: durationRes.kpis.totalExtendedDelays
    },
    hierarchy,
    flatStations,
    flatGates
  };
}

