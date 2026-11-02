import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Report Revision & Tombstone Manager
 *
 * Provides transactional, atomic revision management for the Reports module.
 * Eliminates all full-table LCGateEvent scans during ETag evaluation by leveraging
 * indexed key-value atomic counters in AppSetting (O(K) lookup where K = selected gates).
 */

export interface ReportMetrics {
  totalOperations: number;
  totalDurationSeconds: number;
  avgDurationSeconds: number;
  extendedDelaysCount: number;
  currentlyOpenCount: number;
}

export interface OperationalEventData {
  id: number;
  gateId: number;
  status?: string | null;
  openedAt?: Date | null;
  closedAt?: Date | null;
  durationSeconds?: number | null;
  openedBy?: string | null;
  closedBy?: string | null;
  trainNumber?: string | null;
  remarks?: string | null;
}

/**
 * Worker: Executes atomic revision bump on REPORT_GATE_REV_{gateId}
 * within an existing Prisma transaction.
 * Acquires a transactionally exclusive PostgreSQL row lock on the revision row
 * and returns the newly incremented monotonic revision counter.
 */
export async function bumpReportRevisionInTx(
  tx: Prisma.TransactionClient,
  gateId: number
): Promise<bigint> {
  if (!gateId || isNaN(gateId)) return 0n;
  const key = `REPORT_GATE_REV_${gateId}`;
  const rows: any = await tx.$queryRawUnsafe(`
    INSERT INTO "AppSetting" ("key", "value")
    VALUES ('${key}', '1')
    ON CONFLICT ("key") DO UPDATE
    SET "value" = (CAST("AppSetting"."value" AS BIGINT) + 1)::TEXT
    RETURNING CAST("value" AS BIGINT) as rev;
  `);
  return rows && rows[0] && rows[0].rev != null ? BigInt(rows[0].rev) : 1n;
}

/**
 * Worker: Records an atomic mutation into LCGateEventChangeLog
 * inside the same transaction as the event mutation.
 * Serializes the revision counter via row lock and assigns it to gateRevision.
 */
export async function recordEventChangeInTx(
  tx: Prisma.TransactionClient,
  event: OperationalEventData,
  opType: 'INSERT' | 'UPDATE' | 'DELETE'
): Promise<bigint> {
  const revision = await bumpReportRevisionInTx(tx, event.gateId);

  await tx.lCGateEventChangeLog.create({
    data: {
      eventId: event.id,
      gateId: event.gateId,
      opType,
      gateRevision: revision,
      status: event.status ?? null,
      openedAt: event.openedAt ?? null,
      closedAt: event.closedAt ?? null,
      durationSeconds: event.durationSeconds ?? null,
      openedBy: event.openedBy ?? null,
      closedBy: event.closedBy ?? null,
      trainNumber: event.trainNumber ?? null,
      remarks: event.remarks ?? null,
    },
  });

  return revision;
}

/**
 * Helper: Retrieves the current revision map { [gateId: number]: string }
 * for a list of gates.
 */
export async function getLatestGateRevisions(
  gateIds: number[],
  client: any = prisma
): Promise<Record<string, string>> {
  if (gateIds.length === 0) return {};
  const keys = gateIds.map((id) => `REPORT_GATE_REV_${id}`);
  const settings: Array<{ key: string; value: string }> = await client.appSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const map: Record<string, string> = {};
  const found = new Map(settings.map((s) => [s.key, s.value]));
  for (const id of gateIds) {
    map[String(id)] = found.get(`REPORT_GATE_REV_${id}`) || '0';
  }
  return map;
}

/**
 * Owning Wrapper: Bumps revision in a standalone transaction.
 */
export async function bumpReportRevision(gateId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await bumpReportRevisionInTx(tx, gateId);
  }, {
    timeout: 15000,
    maxWait: 10000,
  });
}

/**
 * Worker: Atomically bumps revisions for multiple gates in a single transaction.
 */
export async function bumpMultipleReportRevisionsInTx(
  tx: Prisma.TransactionClient,
  gateIds: number[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(gateIds.filter((id) => id && !isNaN(id))));
  for (const gateId of uniqueIds) {
    await bumpReportRevisionInTx(tx, gateId);
  }
}

/**
 * Worker: Preserves an operational event in LCGateEventTombstone and LCGateEventChangeLog,
 * bumps the gate report revision, and deletes the event within an existing transaction.
 */
export async function deleteOperationalEventInTx(
  tx: Prisma.TransactionClient,
  eventId: number
): Promise<{ gateId: number; eventId: number } | null> {
  const event = await tx.lCGateEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      gateId: true,
      openedAt: true,
      closedAt: true,
      durationSeconds: true,
      status: true,
      openedBy: true,
      closedBy: true,
      trainNumber: true,
      remarks: true,
    },
  });

  if (!event) return null;

  // 1. Record Tombstone (for backward compatibility)
  await tx.lCGateEventTombstone.create({
    data: {
      eventId: event.id,
      gateId: event.gateId,
      openedAt: event.openedAt,
    },
  });

  // 2. Increment Gate Revision and Record in ChangeLog (atomic & serialized)
  await recordEventChangeInTx(tx, event, 'DELETE');

  // 3. Delete Record from LCGateEvent
  await tx.lCGateEvent.delete({
    where: { id: eventId },
  });

  return { gateId: event.gateId, eventId: event.id };
}

/**
 * Owning Wrapper: Deletes a single operational event transactionally.
 */
export async function deleteOperationalEvent(eventId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await deleteOperationalEventInTx(tx, eventId);
  }, {
    timeout: 15000,
    maxWait: 10000,
  });
}

/**
 * Worker: Bulk deletes operational events, recording tombstones and change-log entries
 * and bumping revisions for all affected gates in a single transaction.
 */
export async function deleteOperationalEventsInTx(
  tx: Prisma.TransactionClient,
  eventIds: number[]
): Promise<number> {
  if (eventIds.length === 0) return 0;

  const events = await tx.lCGateEvent.findMany({
    where: { id: { in: eventIds } },
  });

  if (events.length === 0) return 0;

  // 1. Bulk insert tombstones
  await tx.lCGateEventTombstone.createMany({
    data: events.map((e) => ({
      eventId: e.id,
      gateId: e.gateId,
      openedAt: e.openedAt,
    })),
  });

  // 2. Record changes in ChangeLog for each event
  for (const event of events) {
    await recordEventChangeInTx(tx, event, 'DELETE');
  }

  // 3. Delete the records
  const result = await tx.lCGateEvent.deleteMany({
    where: { id: { in: eventIds } },
  });

  return result.count;
}

/**
 * Owning Wrapper: Bulk deletes events in a standalone transaction.
 */
export async function deleteOperationalEvents(eventIds: number[]): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    return await deleteOperationalEventsInTx(tx, eventIds);
  }, {
    timeout: 15000,
    maxWait: 10000,
  });
}

/**
 * Evaluates a fast, deterministic composite ETag based on:
 * 1. Selected gate revisions (AppSetting REPORT_GATE_REV_{gateId})
 * 2. User assigned scope group revisions (DIRECTORY_SCOPE_REVISION_{sgId})
 * 3. Global directory revision (DIRECTORY_GLOBAL_REVISION)
 * 4. Canonical query parameters hash
 *
 * Runs in ~0.5ms - 1.2ms without scanning LCGateEvent rows.
 */
export async function generateReportETag(
  userId: number,
  gateIds: number[],
  userScopeGroupIds: number[] = [],
  canonicalParamsString: string,
  dbClient: any = prisma
): Promise<string> {
  const gateKeys = gateIds.map((id) => `REPORT_GATE_REV_${id}`);
  const scopeKeys = userScopeGroupIds.map((id) => `DIRECTORY_SCOPE_REVISION_${id}`);
  const allKeys = Array.from(new Set([...gateKeys, ...scopeKeys, 'DIRECTORY_GLOBAL_REVISION']));

  const client = (dbClient?.appSetting ? dbClient : prisma) as typeof prisma;
  const settings: Array<{ key: string; value: string }> = await client.appSetting.findMany({
    where: { key: { in: allKeys } },
    select: { key: true, value: true },
  });

  const settingMap = new Map<string, string>(settings.map((s) => [s.key, s.value]));

  // Sorted gate revisions
  const sortedGateRevs = [...gateIds]
    .sort((a, b) => a - b)
    .map((id) => `${id}:${settingMap.get(`REPORT_GATE_REV_${id}`) || '0'}`)
    .join(',');
  const gateRevHash = crypto.createHash('md5').update(sortedGateRevs).digest('hex').slice(0, 12);

  // Sorted scope revisions
  const sortedScopeRevs = [...userScopeGroupIds]
    .sort((a, b) => a - b)
    .map((id) => `${id}:${settingMap.get(`DIRECTORY_SCOPE_REVISION_${id}`) || '0'}`)
    .join(',');
  const globalRev = settingMap.get('DIRECTORY_GLOBAL_REVISION') || '1';
  const scopeRevHash = crypto
    .createHash('md5')
    .update(`${globalRev}|${sortedScopeRevs}`)
    .digest('hex')
    .slice(0, 12);

  // Query parameters hash
  const queryHash = crypto
    .createHash('sha256')
    .update(canonicalParamsString)
    .digest('hex')
    .slice(0, 12);

  return `W/"rep-u${userId}-g${gateRevHash}-s${scopeRevHash}-q${queryHash}"`;
}

/**
 * RFC 7232 Compliant ETag Match Evaluator
 * Supports weak comparison, comma-separated lists of ETags, and wildcard '*'.
 */
export function isETagMatch(ifNoneMatchHeader: string | undefined, currentETag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  const header = ifNoneMatchHeader.trim();
  if (header === '*') return true;

  // Clean current ETag (strip W/ and surrounding quotes)
  const cleanCurrent = currentETag.replace(/^W\//, '').replace(/^"|"$/g, '');

  const clientTags = header.split(',').map((tag) => tag.trim());
  return clientTags.some((tag) => {
    if (tag === '*') return true;
    const cleanClient = tag.replace(/^W\//, '').replace(/^"|"$/g, '');
    return cleanClient === cleanCurrent;
  });
}

interface CachedKPI {
  metrics: ReportMetrics;
  gateRevHash: string;
  cachedAt: number;
}

const kpiMemoCache = new Map<string, CachedKPI>();

/**
 * Calculates authoritative report KPI metrics across 100% of the dataset
 * for the given gates and criteria.
 * Uses revision-hash memoization to avoid redundant database scans when
 * gate operational data is unchanged.
 */
export async function calculateAuthoritativeMetrics(
  gateIds: number[],
  startDate?: string,
  endDate?: string,
  shiftFilter = 'ALL',
  statusFilter = 'ALL'
): Promise<ReportMetrics> {
  if (gateIds.length === 0) {
    return {
      totalOperations: 0,
      totalDurationSeconds: 0,
      avgDurationSeconds: 0,
      extendedDelaysCount: 0,
      currentlyOpenCount: 0,
    };
  }

  // 1. Check revision hash for selected gates
  const sortedGateIds = [...gateIds].sort((a, b) => a - b);
  const gateKeys = sortedGateIds.map((id) => `REPORT_GATE_REV_${id}`);
  const settings: Array<{ key: string; value: string }> = await prisma.appSetting.findMany({
    where: { key: { in: gateKeys } },
    select: { key: true, value: true },
  });
  const settingMap = new Map<string, string>(settings.map((s) => [s.key, s.value]));
  const revString = sortedGateIds.map((id) => `${id}:${settingMap.get(`REPORT_GATE_REV_${id}`) || '0'}`).join(',');
  const currentGateRevHash = crypto.createHash('md5').update(revString).digest('hex').slice(0, 10);

  const cacheKey = `${sortedGateIds.join(',')}|${startDate || ''}|${endDate || ''}|${shiftFilter}|${statusFilter}`;
  const existingCached = kpiMemoCache.get(cacheKey);

  if (existingCached && existingCached.gateRevHash === currentGateRevHash && Date.now() - existingCached.cachedAt < 60000) {
    return existingCached.metrics;
  }

  // 2. Cache Miss: Compute authoritative metrics
  const whereClause: Prisma.LCGateEventWhereInput = {
    gateId: { in: gateIds },
  };

  if (startDate || endDate) {
    whereClause.openedAt = {};
    if (startDate) whereClause.openedAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      whereClause.openedAt.lte = end;
    }
  }

  if (statusFilter && statusFilter !== 'ALL') {
    whereClause.status = statusFilter;
  }

  const events = await prisma.lCGateEvent.findMany({
    where: whereClause,
    select: {
      status: true,
      closedAt: true,
      durationSeconds: true,
      openedAt: true,
    },
  });

  let totalDurationSeconds = 0;
  let closedCount = 0;
  let extendedDelaysCount = 0;
  let currentlyOpenCount = 0;

  for (const ev of events) {
    // Shift filter check (IST)
    if (shiftFilter !== 'ALL') {
      const utcTime = new Date(ev.openedAt).getTime();
      const istHour = new Date(utcTime + 3600000 * 5.5).getUTCHours();
      if (shiftFilter === 'MORNING' && (istHour < 6 || istHour >= 14)) continue;
      if (shiftFilter === 'EVENING' && (istHour < 14 || istHour >= 22)) continue;
      if (shiftFilter === 'NIGHT' && istHour >= 6 && istHour < 22) continue;
    }

    if (ev.status === 'OPEN' || ev.closedAt == null) {
      currentlyOpenCount++;
    } else {
      closedCount++;
      const dur = ev.durationSeconds || 0;
      totalDurationSeconds += dur;
      if (dur > 900) {
        extendedDelaysCount++;
      }
    }
  }

  const totalOperations = currentlyOpenCount + closedCount;
  const avgDurationSeconds = closedCount > 0 ? Math.round(totalDurationSeconds / closedCount) : 0;

  const result: ReportMetrics = {
    totalOperations,
    totalDurationSeconds,
    avgDurationSeconds,
    extendedDelaysCount,
    currentlyOpenCount,
  };

  // Cache up to 200 recent query variations
  if (kpiMemoCache.size > 200) {
    const oldestKey = kpiMemoCache.keys().next().value;
    if (oldestKey) kpiMemoCache.delete(oldestKey);
  }
  kpiMemoCache.set(cacheKey, {
    metrics: result,
    gateRevHash: currentGateRevHash,
    cachedAt: Date.now(),
  });

  return result;
}
