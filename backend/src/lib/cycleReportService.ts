import { prisma } from './prisma';
import {
  formatISTDateDisplay,
  getISTDateString,
  getISTUtcDateBounds,
} from './timeUtils';

export { formatISTDateDisplay, getISTDateString, getISTUtcDateBounds };

/**
 * Resolve a railway jurisdiction label (Station · Division, Division, or Zone)
 * for reports so gates without legacy ScopeGroup clusters never display "Unassigned".
 */
export function resolveGateHierarchyLabel(gate?: {
  station?: { name?: string | null; code?: string | null } | null;
  division?: string | null;
  zone?: string | null;
  scopeGroups?: Array<{ scopeGroup?: { name?: string | null } | null }> | null;
} | null): string {
  if (!gate) return '-';
  const stationName = gate.station?.name?.trim();
  const division = gate.division?.trim();
  const zone = gate.zone?.trim();

  if (stationName && division) {
    const divLabel = division.toLowerCase().includes('division') ? division : `${division} Division`;
    return `${stationName} · ${divLabel}`;
  }
  if (stationName) return stationName;
  if (division) return division.toLowerCase().includes('division') ? division : `${division} Division`;
  if (zone) return zone;
  const legacyGroup = gate.scopeGroups?.[0]?.scopeGroup?.name?.trim();
  return legacyGroup || 'Indian Railways';
}

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
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  avgClosedSeconds: number;
  avgClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  /** @deprecated Legacy alias of avgOpenSeconds (kept un-inverted for older UI clients) */
  avgOpeningSeconds: number;
  /** @deprecated Legacy alias of avgOpenFormatted */
  avgOpeningFormatted: string;
  /** @deprecated Legacy alias of avgClosedSeconds */
  avgClosingSeconds: number;
  /** @deprecated Legacy alias of avgClosedFormatted */
  avgClosingFormatted: string;
}

export interface GateCycleKPIs {
  totalCycles: number;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  avgClosedSeconds: number;
  avgClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  /** @deprecated Legacy alias of avgOpenSeconds */
  avgOpeningSeconds: number;
  /** @deprecated Legacy alias of avgOpenFormatted */
  avgOpeningFormatted: string;
  /** @deprecated Legacy alias of avgClosedSeconds */
  avgClosingSeconds: number;
  /** @deprecated Legacy alias of avgClosedFormatted */
  avgClosingFormatted: string;
}

export interface GateCycleReport {
  gate: GateMetadata;
  kpis: GateCycleKPIs;
  dailyBreakdown: DailyCycleMetric[];
}

export interface OverallCycleSummary {
  totalCycles: number;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  avgClosedSeconds: number;
  avgClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  reportingGatesCount: number;
  /** @deprecated Legacy alias of avgOpenSeconds */
  avgOpeningSeconds: number;
  /** @deprecated Legacy alias of avgOpenFormatted */
  avgOpeningFormatted: string;
  /** @deprecated Legacy alias of avgClosedSeconds */
  avgClosingSeconds: number;
  /** @deprecated Legacy alias of avgClosedFormatted */
  avgClosingFormatted: string;
}

export interface FullCycleAnalyticsResponse {
  startDate: string;
  endDate: string;
  overall: OverallCycleSummary;
  gateReports: GateCycleReport[];
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

function getEventDurationSeconds(ev: {
  openedAt: Date;
  closedAt: Date | null;
  durationSeconds: number | null;
}): number {
  return ev.durationSeconds && ev.durationSeconds > 0
    ? ev.durationSeconds
    : Math.max(1, Math.round((new Date(ev.closedAt!).getTime() - new Date(ev.openedAt).getTime()) / 1000));
}

function summarizeCycleOpenAndClosedIntervals(
  sortedEvents: Array<{
    openedAt: Date;
    closedAt: Date | null;
    durationSeconds: number | null;
  }>
): { totalOpenSeconds: number; closedIntervals: number[] } {
  let totalOpenSeconds = 0;
  const closedIntervals: number[] = [];

  for (let i = 0; i < sortedEvents.length; i++) {
    const cur = sortedEvents[i];
    totalOpenSeconds += getEventDurationSeconds(cur);

    if (i < sortedEvents.length - 1) {
      const next = sortedEvents[i + 1];
      const closedInterval = Math.round(
        (new Date(next.openedAt).getTime() - new Date(cur.closedAt!).getTime()) / 1000
      );
      if (closedInterval >= 0) {
        closedIntervals.push(closedInterval);
      }
    }
  }

  return { totalOpenSeconds, closedIntervals };
}

function calculateGateCycleAnalyticsInternal(
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
): { report: GateCycleReport; allClosedIntervals: number[] } {
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

  // 3. Compute open cycle durations (openedAt -> closedAt) & inter-cycle closed intervals (closedAt -> next openedAt)
  const { totalOpenSeconds, closedIntervals } = summarizeCycleOpenAndClosedIntervals(deduplicated);

  const totalCycles = deduplicated.length;
  const avgOpenSeconds = totalCycles > 0 ? Math.round(totalOpenSeconds / totalCycles) : 0;
  const avgOpenFormatted = totalCycles > 0 ? formatDurationHuman(avgOpenSeconds) : '—';
  const avgClosedSeconds = closedIntervals.length > 0
    ? Math.round(closedIntervals.reduce((a, b) => a + b, 0) / closedIntervals.length)
    : 0;
  const avgClosedFormatted = closedIntervals.length > 0 ? formatDurationHuman(avgClosedSeconds) : '—';

  const dateList = generateDateRangeList(startDateStr, endDateStr);
  const totalDays = Math.max(1, dateList.length);
  const totalPeriodSeconds = totalDays * 86400;
  const totalClosedSeconds = Math.max(0, totalPeriodSeconds - totalOpenSeconds);

  const kpis: GateCycleKPIs = {
    totalCycles,
    avgOpenSeconds,
    avgOpenFormatted,
    avgClosedSeconds,
    avgClosedFormatted,
    totalOpenSeconds,
    totalOpenFormatted: formatDurationHuman(totalOpenSeconds),
    totalClosedSeconds,
    totalClosedFormatted: formatDurationHuman(totalClosedSeconds),
    avgOpeningSeconds: avgOpenSeconds,
    avgOpeningFormatted: avgOpenFormatted,
    avgClosingSeconds: avgClosedSeconds,
    avgClosingFormatted: avgClosedFormatted
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

    const { totalOpenSeconds: dayOpenSec, closedIntervals: dayClosedIntervals } =
      summarizeCycleOpenAndClosedIntervals(dayEvents);

    const dayAvgOpen = count > 0 ? Math.round(dayOpenSec / count) : 0;
    const dayAvgOpenFormatted = count > 0 ? formatDurationHuman(dayAvgOpen) : '—';
    const dayAvgClosed = dayClosedIntervals.length > 0
      ? Math.round(dayClosedIntervals.reduce((a, b) => a + b, 0) / dayClosedIntervals.length)
      : 0;
    const dayAvgClosedFormatted = dayClosedIntervals.length > 0 ? formatDurationHuman(dayAvgClosed) : '—';

    const dayClosedSec = Math.max(0, 86400 - dayOpenSec);

    dailyBreakdown.push({
      dateStr,
      dateFormatted: formatISTDateDisplay(dateStr),
      completedCycles: count,
      avgOpenSeconds: dayAvgOpen,
      avgOpenFormatted: dayAvgOpenFormatted,
      avgClosedSeconds: dayAvgClosed,
      avgClosedFormatted: dayAvgClosedFormatted,
      totalOpenSeconds: dayOpenSec,
      totalOpenFormatted: count > 0 ? formatDurationHuman(dayOpenSec) : '0s',
      totalClosedSeconds: dayClosedSec,
      totalClosedFormatted: formatDurationHuman(dayClosedSec),
      avgOpeningSeconds: dayAvgOpen,
      avgOpeningFormatted: dayAvgOpenFormatted,
      avgClosingSeconds: dayAvgClosed,
      avgClosingFormatted: dayAvgClosedFormatted
    });
  }

  return {
    report: {
      gate,
      kpis,
      dailyBreakdown
    },
    allClosedIntervals: closedIntervals
  };
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
  return calculateGateCycleAnalyticsInternal(gate, rawEvents, startDateStr, endDateStr).report;
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
        avgOpenSeconds: 0,
        avgOpenFormatted: '—',
        avgClosedSeconds: 0,
        avgClosedFormatted: '—',
        totalOpenSeconds: 0,
        totalOpenFormatted: '0s',
        totalClosedSeconds: 0,
        totalClosedFormatted: '0s',
        reportingGatesCount: 0,
        avgOpeningSeconds: 0,
        avgOpeningFormatted: '—',
        avgClosingSeconds: 0,
        avgClosingFormatted: '—'
      },
      gateReports: []
    };
  }

  // 1. Fetch gate details
  const gates = await prisma.lCGate.findMany({
    where: { id: { in: targetGateIds } },
    include: { station: { select: { name: true, code: true } } },
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
  let overallTotalOpenSeconds = 0;
  const overallClosedIntervals: number[] = [];

  for (const g of gates) {
    const gateMeta: GateMetadata = {
      id: g.id,
      lcNumber: g.lcNumber,
      name: g.name,
      locationName: g.locationName,
      zone: g.zone,
      division: g.division,
      scopeGroupName: resolveGateHierarchyLabel(g)
    };

    const gEvents = eventsByGate.get(g.id) || [];
    const { report: rep, allClosedIntervals } = calculateGateCycleAnalyticsInternal(
      gateMeta,
      gEvents,
      startDateStr,
      endDateStr
    );
    gateReports.push(rep);

    overallTotalCycles += rep.kpis.totalCycles;
    overallTotalOpenSeconds += rep.kpis.totalOpenSeconds;
    if (allClosedIntervals.length > 0) {
      overallClosedIntervals.push(...allClosedIntervals);
    }
  }

  const dateList = generateDateRangeList(startDateStr, endDateStr);
  const totalDays = Math.max(1, dateList.length);
  const totalGates = gates.length;
  const totalPeriodSeconds = totalDays * 86400 * totalGates;
  const overallTotalClosedSeconds = Math.max(0, totalPeriodSeconds - overallTotalOpenSeconds);

  const overallAvgOpenSec = overallTotalCycles > 0
    ? Math.round(overallTotalOpenSeconds / overallTotalCycles)
    : 0;
  const overallAvgOpenFormatted = overallTotalCycles > 0 ? formatDurationHuman(overallAvgOpenSec) : '—';

  const overallAvgClosedSec = overallClosedIntervals.length > 0
    ? Math.round(overallClosedIntervals.reduce((a, b) => a + b, 0) / overallClosedIntervals.length)
    : 0;
  const overallAvgClosedFormatted = overallClosedIntervals.length > 0
    ? formatDurationHuman(overallAvgClosedSec)
    : '—';

  const overall: OverallCycleSummary = {
    totalCycles: overallTotalCycles,
    avgOpenSeconds: overallAvgOpenSec,
    avgOpenFormatted: overallAvgOpenFormatted,
    avgClosedSeconds: overallAvgClosedSec,
    avgClosedFormatted: overallAvgClosedFormatted,
    totalOpenSeconds: overallTotalOpenSeconds,
    totalOpenFormatted: formatDurationHuman(overallTotalOpenSeconds),
    totalClosedSeconds: overallTotalClosedSeconds,
    totalClosedFormatted: formatDurationHuman(overallTotalClosedSeconds),
    reportingGatesCount: totalGates,
    avgOpeningSeconds: overallAvgOpenSec,
    avgOpeningFormatted: overallAvgOpenFormatted,
    avgClosingSeconds: overallAvgClosedSec,
    avgClosingFormatted: overallAvgClosedFormatted
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

export function buildStationBucketKey(item: {
  stationId?: number | null;
  stationName?: string | null;
  zone?: string | null;
  division?: string | null;
}): string {
  if (item.stationId) {
    return `ID_${item.stationId}`;
  }
  const zoneKey = (item.zone || 'Indian Railways').trim();
  const divKey = (item.division || 'Division').trim();
  const cleanName = (item.stationName || '').trim();
  if (!cleanName || cleanName === 'Unassigned Station' || cleanName === 'Unassigned') {
    return `UNASSIGNED_${zoneKey}_${divKey}`;
  }
  return `NAME_${zoneKey}_${divKey}_${cleanName}`;
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
    // Count 1 cycle per LCGateEvent (OPEN -> CLOSED) instead of openCount + closeCount
    // so Count & Holistic reports match Home todayCycles and Event Log totalOperations 1:1.
    const totalOps = evs.length;

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
    const sKey = buildStationBucketKey(item);
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
      const dur = getEventDurationSeconds(ev);
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
        dOpenSec += getEventDurationSeconds(e);
      }
      const dClosedSec = Math.max(0, 86400 - dOpenSec);
      const dAvgOpen = dEvs.length > 0 ? Math.round(dOpenSec / dEvs.length) : 0;
      const dAvgClosed = dEvs.length > 0 ? Math.round(dClosedSec / dEvs.length) : 0;
      const dAvgOpenFmt = formatDurationHuman(dAvgOpen);
      const dAvgClosedFmt = formatDurationHuman(dAvgClosed);

      dailyBreakdown.push({
        dateStr: dStr,
        dateFormatted: formatISTDateDisplay(dStr),
        completedCycles: dEvs.length,
        avgOpenSeconds: dAvgOpen,
        avgOpenFormatted: dAvgOpenFmt,
        avgClosedSeconds: dAvgClosed,
        avgClosedFormatted: dAvgClosedFmt,
        totalOpenSeconds: dOpenSec,
        totalOpenFormatted: formatDurationHuman(dOpenSec),
        totalClosedSeconds: dClosedSec,
        totalClosedFormatted: formatDurationHuman(dClosedSec),
        avgOpeningSeconds: dAvgOpen,
        avgOpeningFormatted: dAvgOpenFmt,
        avgClosingSeconds: dAvgClosed,
        avgClosingFormatted: dAvgClosedFmt
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
  stationId?: number | null;
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
      stationId: cg.stationId,
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
    const sKey = buildStationBucketKey({
      stationId: g.stationId ?? null,
      stationName: g.stationName,
      zone: g.zone || 'Indian Railways',
      division: g.division || 'Division',
    });
    if (!stationMap.has(sKey)) {
      stationMap.set(sKey, {
        stationId: g.stationId ?? null,
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

