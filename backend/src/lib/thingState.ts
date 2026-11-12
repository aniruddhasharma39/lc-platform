import { Prisma } from '@prisma/client';
import { bumpReportRevisionInTx } from './reportRevisionManager';

export const GATE_ONLINE_CUTOFF_MS = 65 * 60 * 1000; // 65-minute unified heartbeat window

export function getOnlineCutoffDate(nowMs: number = Date.now()): Date {
  return new Date(nowMs - GATE_ONLINE_CUTOFF_MS);
}

export type BarrierState = 'OPEN' | 'CLOSED' | null;
export type GateResolvedStatus = 'OPEN' | 'CLOSED' | 'NO_TELEMETRY' | 'UNCONFIGURED';
export type GateConnectivityStatus = 'ONLINE' | 'PARTIAL' | 'OFFLINE' | 'UNCONFIGURED';

/**
 * Single authoritative parser for physical barrier state from an AWS IoT payload.
 * Returns null when payload contains only connectivity/health heartbeats (e.g. ONLINE, HEALTHY)
 * or lacks physical boom/limit-switch state.
 */
export function parseBarrierStateFromPayload(payload: any): BarrierState {
  if (!payload || typeof payload !== 'object') return null;

  const rawStatus = payload.Status ?? payload.status ?? payload.gateStatus;
  if (rawStatus !== undefined && rawStatus !== null) {
    const s = String(rawStatus).trim().toUpperCase();
    if (s === 'CLOSED') return 'CLOSED';
    if (s === 'OPEN' || s === 'NOT_CLOSED') return 'OPEN';
  }

  if (payload.LimitSwitchClosed !== undefined && payload.LimitSwitchClosed !== null) {
    return Boolean(payload.LimitSwitchClosed) ? 'CLOSED' : 'OPEN';
  }

  if (payload.limitSwitchClosed !== undefined && payload.limitSwitchClosed !== null) {
    return Boolean(payload.limitSwitchClosed) ? 'CLOSED' : 'OPEN';
  }

  return null;
}

/**
 * Returns true strictly for genuine inbound AWS IoT operational /telemetry packets
 * that carry real physical barrier state (OPEN / CLOSED / NOT_CLOSED / LimitSwitchClosed).
 * Excludes /manifest, /health, /request commands, queued ping artifacts, and heartbeat-only payloads.
 */
export function isGenuineTelemetryPacket(rec: {
  topic?: string | null;
  status?: string | null;
  payload?: any;
}): boolean {
  const topic = String(rec.topic || '').toLowerCase();
  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
  const recStatus = String(rec.status || '').toUpperCase();
  if (!topic.includes('/telemetry')) return false;
  if (topic.includes('/health') || topic.includes('/request') || topic.includes('/manifest')) return false;
  if (recStatus === 'REQUESTED' || recStatus === 'MANIFEST' || recStatus === 'ACTIVE' || recStatus === 'HEALTHY' || recStatus === 'HEARTBEAT') {
    return false;
  }
  if (payload?.action === 'HEALTH_CHECK' || payload?.action === 'HEALTH_CHECK_RESPONSE') return false;
  return parseBarrierStateFromPayload(payload) !== null;
}

/**
 * Classifies any DeviceTelemetry / DeviceHealthCheck row deterministically for UI tabs and inspectors.
 */
export function classifyTelemetryPacketType(rec: {
  topic?: string | null;
  status?: string | null;
  payload?: any;
  isDedicatedHealthCheck?: boolean;
}): 'TELEMETRY' | 'MANIFEST' | 'HEALTH' | 'HEARTBEAT' {
  if (rec.isDedicatedHealthCheck) return 'HEALTH';
  const topic = String(rec.topic || '').toLowerCase();
  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
  if (
    (topic.includes('/health') && !topic.includes('/request')) ||
    payload?.action === 'HEALTH_CHECK_RESPONSE' ||
    payload?.healthstatus !== undefined
  ) {
    return 'HEALTH';
  }
  if (isManifestPacket(rec)) return 'MANIFEST';
  if (isGenuineTelemetryPacket(rec)) return 'TELEMETRY';
  return 'HEARTBEAT';
}

/**
 * Returns true if a DeviceTelemetry row is a manifest packet.
 */
export function isManifestPacket(rec: { topic?: string | null; payload?: any }): boolean {
  const topic = String(rec.topic || '').toLowerCase();
  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
  if (topic.includes('/manifest')) return true;
  if (topic.includes('/request') || topic.includes('/telemetry') || topic.includes('/health')) return false;
  return Boolean(
    payload &&
      (payload.thing !== undefined ||
        payload.Master !== undefined ||
        payload.master !== undefined ||
        payload.runtimeConfig !== undefined ||
        payload.manufacturing !== undefined ||
        Array.isArray(payload.sensors) ||
        Array.isArray(payload.components))
  );
}

/**
 * Normalizes a persisted barrierState column value strictly to 'OPEN' | 'CLOSED' | null.
 */
export function normalizeBarrierStateColumn(val?: string | null): BarrierState {
  if (!val) return null;
  const s = String(val).trim().toUpperCase();
  if (s === 'OPEN' || s === 'NOT_CLOSED') return 'OPEN';
  if (s === 'CLOSED') return 'CLOSED';
  return null;
}

/**
 * Evaluates live hardware online/offline status from DB lastSeenAt and lifecycle state.
 */
export function computeThingConnectivity(
  dev: {
    status?: string | null;
    connectivityStatus?: string | null;
    lastSeenAt?: Date | string | null;
  },
  nowMs: number = Date.now()
): { isOnline: boolean; connectivityStatus: 'ONLINE' | 'OFFLINE'; lastSeenAt: string | null } {
  const lifecycle = String(dev.status || 'ACTIVE').toUpperCase();
  const lastSeenMs = dev.lastSeenAt ? new Date(dev.lastSeenAt).getTime() : 0;
  const lastSeenIso = lastSeenMs > 0 ? new Date(lastSeenMs).toISOString() : null;

  if (lifecycle === 'DECOMMISSIONED' || lifecycle === 'INACTIVE') {
    return { isOnline: false, connectivityStatus: 'OFFLINE', lastSeenAt: lastSeenIso };
  }

  const isOnline = lastSeenMs > 0 && nowMs - lastSeenMs <= GATE_ONLINE_CUTOFF_MS;
  return {
    isOnline,
    connectivityStatus: isOnline ? 'ONLINE' : 'OFFLINE',
    lastSeenAt: lastSeenIso,
  };
}

/**
 * Re-attaches legacy `deviceRegistries` array alias onto MasterUnit objects loaded with 1-to-1 `deviceRegistry`
 * so existing UI consumers remain compatible while PostgreSQL enforces 1-to-1 via `@unique(masterId)`.
 */
export function hydrateGateMasters<T extends { masters?: any[]; deviceRegistries?: any[] }>(gate: T): T {
  if (!gate || !Array.isArray(gate.masters)) return gate;
  const gateRegs = Array.isArray(gate.deviceRegistries) ? gate.deviceRegistries : [];
  gate.masters = gate.masters.map((m: any) => {
    const reg = m.deviceRegistry || gateRegs.find((d: any) => d.masterId === m.id) || null;
    return {
      ...m,
      deviceRegistry: reg,
      deviceRegistries: reg ? [reg] : [],
    };
  });
  return gate;
}

/**
 * Resolves a gate's authoritative configuration status, barrier state, and connectivity strictly
 * from its Master-linked AWS IoT Thing records in PostgreSQL (zero fallback to LCGateEvent or 'CLOSED').
 */
export function resolveGateStateFromThings(
  gate: any,
  nowMs: number = Date.now()
): {
  isConfigured: boolean;
  hasMaster: boolean;
  hasHardware: boolean;
  status: GateResolvedStatus;
  isOnline: boolean;
  deviceStatus: GateConnectivityStatus;
  lastSeenAt: string | null;
  onlineMastersCount: number;
  hardwareMastersCount: number;
  linkedThings: any[];
} {
  const masters = Array.isArray(gate?.masters) ? gate.masters : [];
  const gateRegs = Array.isArray(gate?.deviceRegistries) ? gate.deviceRegistries : [];
  const seenThingIds = new Set<number>();
  const linkedThings: any[] = [];

  for (const m of masters) {
    const reg =
      m.deviceRegistry ||
      (Array.isArray(m.deviceRegistries) && m.deviceRegistries[0]) ||
      gateRegs.find((d: any) => d.masterId === m.id) ||
      null;
    if (reg && !seenThingIds.has(reg.id)) {
      seenThingIds.add(reg.id);
      linkedThings.push(reg);
    }
  }

  const hardwareMastersCount = linkedThings.length;
  const hasMaster = masters.length > 0;
  const hasHardware = hardwareMastersCount > 0;
  const isConfigured = hasMaster && hasHardware;

  if (!isConfigured) {
    return {
      isConfigured: false,
      hasMaster,
      hasHardware: false,
      status: 'UNCONFIGURED',
      isOnline: false,
      deviceStatus: 'UNCONFIGURED',
      lastSeenAt: null,
      onlineMastersCount: 0,
      hardwareMastersCount: 0,
      linkedThings: [],
    };
  }

  let onlineMastersCount = 0;
  let maxSeenMs = 0;
  const masterStates: BarrierState[] = [];

  for (const reg of linkedThings) {
    const conn = computeThingConnectivity(reg, nowMs);
    if (conn.isOnline) onlineMastersCount++;
    if (conn.lastSeenAt) {
      const ms = new Date(conn.lastSeenAt).getTime();
      if (ms > maxSeenMs) maxSeenMs = ms;
    }
    masterStates.push(normalizeBarrierStateColumn(reg.barrierState));
  }

  // Fail-safe barrier state rollup strictly from AWS IoT Thing barrierState
  let status: GateResolvedStatus = 'NO_TELEMETRY';
  if (masterStates.includes('OPEN')) {
    status = 'OPEN';
  } else if (masterStates.includes('CLOSED')) {
    status = 'CLOSED';
  }

  const isOnline = onlineMastersCount > 0;
  const deviceStatus: GateConnectivityStatus =
    onlineMastersCount === 0
      ? 'OFFLINE'
      : onlineMastersCount < hardwareMastersCount
        ? 'PARTIAL'
        : 'ONLINE';

  return {
    isConfigured: true,
    hasMaster: true,
    hasHardware: true,
    status,
    isOnline,
    deviceStatus,
    lastSeenAt: maxSeenMs > 0 ? new Date(maxSeenMs).toISOString() : null,
    onlineMastersCount,
    hardwareMastersCount,
    linkedThings,
  };
}

/**
 * Tombstones and removes operational LCGateEvent rows tied to a detached/deleted Master or Thing
 * so stale open events or cycles from an unassigned device never pollute the gate.
 */
export async function cleanupDetachedThingEventsInTx(
  tx: Prisma.TransactionClient,
  params: { gateId: number; masterId?: number | null; thingName?: string | null }
): Promise<number> {
  const { gateId, masterId, thingName } = params;
  const scopes: any[] = [];
  if (masterId) scopes.push({ masterId });
  if (thingName) scopes.push({ thingName });
  if (scopes.length === 0) return 0;

  const eventsToDelete = await tx.lCGateEvent.findMany({
    where: {
      gateId,
      OR: scopes,
    },
    select: {
      id: true,
      gateId: true,
      masterId: true,
      masterSerial: true,
      thingName: true,
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

  if (eventsToDelete.length === 0) return 0;

  const revision = await bumpReportRevisionInTx(tx, gateId);

  await tx.lCGateEventTombstone.createMany({
    data: eventsToDelete.map((e) => ({
      eventId: e.id,
      gateId: e.gateId,
      openedAt: e.openedAt,
      deletedAt: new Date(),
    })),
    skipDuplicates: true,
  });

  await tx.lCGateEventChangeLog.createMany({
    data: eventsToDelete.map((e) => ({
      eventId: e.id,
      gateId: e.gateId,
      masterId: e.masterId ?? null,
      masterSerial: e.masterSerial ?? null,
      thingName: e.thingName ?? null,
      opType: 'DELETE',
      gateRevision: revision,
      status: e.status ?? null,
      openedAt: e.openedAt ?? null,
      closedAt: e.closedAt ?? null,
      durationSeconds: e.durationSeconds ?? null,
      openedBy: e.openedBy ?? null,
      closedBy: e.closedBy ?? null,
      trainNumber: e.trainNumber ?? null,
      remarks: e.remarks ?? null,
    })),
    skipDuplicates: true,
  });

  await tx.lCGateEvent.deleteMany({
    where: { id: { in: eventsToDelete.map((e) => e.id) } },
  });

  return eventsToDelete.length;
}

/**
 * Normalizes raw status strings (converting firmware "NOT_CLOSED" to "OPEN").
 */
export function normalizeRawStatusValue<T>(val: T): T | 'OPEN' {
  if (typeof val === 'string' && val.trim().toUpperCase() === 'NOT_CLOSED') {
    return 'OPEN';
  }
  return val;
}

/**
 * Returns a display-safe clone of a telemetry/health payload with "NOT_CLOSED"
 * normalized to "OPEN" so Status fields and header BARRIER pills always agree.
 */
export function normalizeTelemetryPayloadForDisplay<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const cloned: Record<string, any> = { ...(payload as Record<string, any>) };
  for (const key of ['Status', 'status', 'gateStatus']) {
    if (cloned[key] !== undefined && cloned[key] !== null) {
      cloned[key] = normalizeRawStatusValue(cloned[key]);
    }
  }
  return cloned as T;
}

/**
 * Normalizes a telemetry or health record for API responses without mutating DB rows.
 */
export function normalizeTelemetryRecordForDisplay<
  T extends { status?: any; gateStatus?: any; payload?: any }
>(record: T): T & { resolvedBarrierState: BarrierState } {
  const normalizedPayload = normalizeTelemetryPayloadForDisplay(record.payload);
  return {
    ...record,
    status: normalizeRawStatusValue(record.status),
    ...(record.gateStatus !== undefined ? { gateStatus: normalizeRawStatusValue(record.gateStatus) } : {}),
    payload: normalizedPayload,
    resolvedBarrierState: parseBarrierStateFromPayload(normalizedPayload),
  };
}

/**
 * Resolves authoritative barrierState ('OPEN' | 'CLOSED' | null) for telemetry APIs
 * without waiting on the 3-second telemetryMonitor worker when a newer genuine
 * telemetry packet has already landed in DeviceTelemetry.
 * Does NOT advance device.lastTelemetryId so pollTelemetryTransitions still detects transitions.
 */
export function resolveAuthoritativeBarrierState(
  device: {
    barrierState?: string | null;
    lastTelemetryAt?: Date | string | null;
    lastTelemetryId?: number | null;
  },
  latestGenuineTele?: {
    id?: number | null;
    receivedAt?: Date | string | null;
    payload?: any;
  } | null
): BarrierState {
  const persisted = normalizeBarrierStateColumn(device?.barrierState);
  if (!latestGenuineTele) return persisted;

  const packetState = parseBarrierStateFromPayload(latestGenuineTele.payload);
  if (!packetState) return persisted;
  if (!persisted) return packetState;

  const packetMs = latestGenuineTele.receivedAt ? new Date(latestGenuineTele.receivedAt).getTime() : 0;
  const persistedMs = device?.lastTelemetryAt ? new Date(device.lastTelemetryAt).getTime() : 0;

  // Prefer packet when newer, or on equal timestamp with a strictly higher row id.
  if (packetMs > persistedMs) return packetState;
  if (
    packetMs === persistedMs &&
    latestGenuineTele.id &&
    (!device?.lastTelemetryId || latestGenuineTele.id > device.lastTelemetryId)
  ) {
    return packetState;
  }

  return persisted;
}
