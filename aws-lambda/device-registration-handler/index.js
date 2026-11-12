/**
 * AWS Lambda Function: LC-Platform Device Registry & Telemetry Handler
 *
 * Triggered by AWS IoT Core Rules / Lifecycle Events / Fleet Provisioning / EventBridge:
 * - '$aws/events/thing/+/created'
 * - '$aws/events/thing/+/deleted'
 * - 'lc/devices/+/manifest'
 * - 'lc-gate/+/#' (telemetry & health)
 */

const { Pool } = require('pg');

let pool;

function getDbPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is missing');
    }

    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
    });

    pool.on('error', (err) => {
      console.error('[DB POOL ERROR]', err);
    });
  }
  return pool;
}

function safeJson(val, defaultVal = null) {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return defaultVal;
  }
}

const GATE_ONLINE_CUTOFF_MS = 65 * 60 * 1000;
const MIN_VALID_EPOCH_MS = Date.UTC(2020, 0, 1, 0, 0, 0, 0);

/**
 * Resolves a valid monotonic wall-clock Date from IoT event/payload timestamps,
 * ignoring firmware uptime counters (< 2020-01-01) or far-future corrupt values.
 */
function resolveEventTimestamp(event, raw) {
  const candidates = [
    raw?.timestamp,
    raw?.receivedAt,
    raw?.ts,
    event?.timestamp,
  ];
  const maxAllowedMs = Date.now() + 24 * 60 * 60 * 1000;

  for (const val of candidates) {
    if (val === undefined || val === null || val === '') continue;
    let ms = NaN;
    if (typeof val === 'number' && Number.isFinite(val)) {
      ms = val >= 1e9 && val < 1e11 ? val * 1000 : val;
    } else if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        ms = num >= 1e9 && num < 1e11 ? num * 1000 : num;
      } else {
        ms = Date.parse(trimmed);
      }
    }
    if (Number.isFinite(ms) && ms >= MIN_VALID_EPOCH_MS && ms <= maxAllowedMs) {
      return new Date(ms);
    }
  }
  return new Date();
}

async function bumpDirectoryRevisionInTx(client) {
  await client.query(`
    INSERT INTO "AppSetting" ("key", "value")
    VALUES ('DIRECTORY_GLOBAL_REVISION', '1')
    ON CONFLICT ("key") DO UPDATE
    SET "value" = (CAST("AppSetting"."value" AS BIGINT) + 1)::TEXT;
  `);
}

function toStrictBoolean(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return val !== 0;
  }
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function toFiniteFloat(val) {
  if (val === undefined || val === null || val === '' || typeof val === 'boolean') return null;
  const s = typeof val === 'string' ? val.trim() : val;
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toFiniteInt(val) {
  if (val === undefined || val === null || val === '' || typeof val === 'boolean') return null;
  const s = String(val).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parses DD-MM-YYYY (strict calendar validation, no overflow), ISO strings, or epoch milliseconds into an ISO timestamp string.
 */
function parseFlexibleDate(rawDate) {
  if (rawDate === undefined || rawDate === null || rawDate === '') return null;
  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) {
    const d = new Date(rawDate);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const str = String(rawDate).trim();
  const dmyMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const monthNum = parseInt(dmyMatch[2], 10);
    const month = monthNum - 1;
    const year = parseInt(dmyMatch[3], 10);
    if (monthNum < 1 || monthNum > 12 || day < 1 || day > 31) {
      return null;
    }
    const d = new Date(Date.UTC(year, month, day));
    if (
      !isNaN(d.getTime()) &&
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month &&
      d.getUTCDate() === day
    ) {
      return d.toISOString();
    }
    return null;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Authoritative physical barrier state parser aligned with backend/src/lib/thingState.ts.
 * Returns 'OPEN' | 'CLOSED' | null.
 */
function parseBarrierStateFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const rawStatus = payload.Status !== undefined
    ? payload.Status
    : (payload.status !== undefined ? payload.status : payload.gateStatus);
  if (rawStatus !== undefined && rawStatus !== null) {
    const s = String(rawStatus).trim().toUpperCase();
    if (s === 'CLOSED') return 'CLOSED';
    if (s === 'OPEN' || s === 'NOT_CLOSED') return 'OPEN';
  }

  if (payload.LimitSwitchClosed !== undefined && payload.LimitSwitchClosed !== null) {
    return payload.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
  }
  if (payload.limitSwitchClosed !== undefined && payload.limitSwitchClosed !== null) {
    return payload.limitSwitchClosed ? 'CLOSED' : 'OPEN';
  }

  return null;
}

/**
 * Extracts firmware manifest structures ({ thing: { Master: { S.No., Slave: { Sensors: ... } } } }).
 */
function extractManifestHardware(raw, resolvedSerial) {
  const thingObj = raw.thing || raw.Thing || {};
  const masterObj = thingObj.Master || thingObj.master || raw.Master || raw.master || {};
  const slaveObj = masterObj.Slave || masterObj.slave || raw.Slave || raw.slave || raw.slaves || raw.Slaves || null;

  let parsedSlaves = [];
  let normalizedSensors = [];

  if (Array.isArray(slaveObj)) {
    parsedSlaves = slaveObj;
  } else if (typeof slaveObj === 'object' && slaveObj !== null) {
    const sensorsObj = slaveObj.Sensors || slaveObj.sensors;
    const rawSensorList = (sensorsObj && (sensorsObj.SensorName || sensorsObj.sensorName)) || sensorsObj || [];
    const sensorArr = Array.isArray(rawSensorList) ? rawSensorList : [rawSensorList];
    normalizedSensors = sensorArr
      .filter((s) => s !== undefined && s !== null && String(s).trim() !== '')
      .map((s) => (typeof s === 'string' ? { name: s } : s));

    if (normalizedSensors.length > 0 && resolvedSerial) {
      parsedSlaves = [{
        slaveId: `${resolvedSerial}-S1`,
        name: slaveObj.name || 'Slave Sensors',
        connection: 'WIRED',
        sensors: normalizedSensors,
      }];
    }
  }

  return {
    masterObj,
    deviceName: masterObj.Device_Name || masterObj.deviceName || raw.deviceName || null,
    description: masterObj.Desc || masterObj.description || raw.description || null,
    masterVersion: masterObj.version ? String(masterObj.version) : null,
    masterMfg: masterObj.Mfg || masterObj.mfg || null,
    parsedSlaves,
    normalizedSensors,
  };
}

/**
 * Classifies an incoming event so lifecycle, health, manifest, and telemetry packets route cleanly.
 */
function classifyIoTEvent(event, raw) {
  const topicStr = String(event.topic || raw?.topic || '');
  const topicLower = topicStr.toLowerCase();
  const op = String(raw?.operation || event?.operation || '').toUpperCase();
  const rawEvtType = String(raw?.eventType || '').toUpperCase();
  const evtType = String(event?.eventType || '').toUpperCase();

  const isDeletionEvent =
    op === 'DELETED' ||
    evtType === 'DELETED' ||
    evtType === 'THING_DELETED' ||
    evtType === 'THINGDELETED' ||
    rawEvtType === 'DELETED' ||
    rawEvtType === 'THING_DELETED' ||
    rawEvtType === 'THINGDELETED' ||
    topicLower.endsWith('/deleted') ||
    event?.detail?.eventName === 'DeleteThing' ||
    raw?.detail?.eventName === 'DeleteThing';

  const isHealthRequestEcho =
    topicLower.includes('/health/request') ||
    (raw?.action === 'HEALTH_CHECK' && raw?.action !== 'HEALTH_CHECK_RESPONSE');

  const isHealthReport =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    ((topicLower.includes('/health') && !topicLower.includes('/request')) ||
      raw?.action === 'HEALTH_CHECK_RESPONSE' ||
      (raw?.healthstatus !== undefined && raw?.action !== 'HEALTH_CHECK'));

  const isLifecycleCreated =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    (op === 'CREATED' ||
      rawEvtType === 'THING_CREATED' ||
      evtType === 'THING_CREATED' ||
      topicLower.endsWith('/created') ||
      Boolean(raw?.detail && (raw.detail.eventName === 'CreateThing' || raw.detail.eventName === 'RegisterThing')));

  const isLifecycleUpdated =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    !isLifecycleCreated &&
    (op === 'UPDATED' ||
      rawEvtType === 'THING_UPDATED' ||
      evtType === 'THING_UPDATED' ||
      topicLower.endsWith('/updated') ||
      Boolean(raw?.detail && raw.detail.eventName === 'UpdateThing'));

  const isLifecycleEvent = isLifecycleCreated || isLifecycleUpdated;

  const isManifestReport =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    !isLifecycleEvent &&
    (topicLower.includes('/manifest') ||
      (!topicLower.includes('/telemetry') &&
        Boolean(
          raw?.thing?.Master ||
            raw?.thing?.master ||
            raw?.Thing?.Master ||
            raw?.Master ||
            raw?.master ||
            raw?.runtimeConfig ||
            raw?.manufacturing ||
            Array.isArray(raw?.sensors) ||
            Array.isArray(raw?.components)
        )));

  const isTelemetryReport =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    !isLifecycleEvent &&
    !isManifestReport;

  return {
    topicStr,
    isDeletionEvent,
    isHealthRequestEcho,
    isHealthReport,
    isLifecycleCreated,
    isLifecycleUpdated,
    isLifecycleEvent,
    isManifestReport,
    isTelemetryReport,
  };
}

/**
 * Normalizes incoming events from AWS IoT Topic Rules, Lifecycle Events, Fleet Provisioning, or API Gateway.
 */
function extractDevicePayload(event) {
  let raw = event || {};
  const isHttpEvent = Boolean(
    event &&
      (event.body !== undefined ||
        event.requestContext !== undefined ||
        event.httpMethod !== undefined)
  );

  if (event && event.body !== undefined && event.body !== null) {
    raw = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  }

  // Unwrap envelope `{ topic, payload: { ... } }` if an IoT Rule or bridge nested the body under `payload`
  if (raw && typeof raw === 'object' && raw.payload !== undefined && raw.payload !== null) {
    const inner = typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      raw = {
        ...inner,
        ...(raw.topic && !inner.topic ? { topic: raw.topic } : {}),
        ...(raw.topicThingName && !inner.topicThingName ? { topicThingName: raw.topicThingName } : {}),
        ...(raw.eventType && !inner.eventType ? { eventType: raw.eventType } : {}),
        ...(raw.operation && !inner.operation ? { operation: raw.operation } : {}),
        ...(raw.timestamp !== undefined && inner.timestamp === undefined ? { timestamp: raw.timestamp } : {}),
      };
    }
  }

  if (raw.detail && raw.detail.requestParameters) {
    const req = raw.detail.requestParameters;
    return {
      isHttpEvent,
      thingName: req.thingName,
      thingTypeName: req.thingTypeName || null,
      thingArn: raw.detail.responseElements?.thingArn || null,
      deviceType: 'MASTER',
      serialNumber: req.thingName || null,
      attributes: req.attributePayload?.attributes || {},
      metadata: null,
      raw,
    };
  }

  if (raw.parameters) {
    const p = raw.parameters;
    const resolvedThing = p.ThingName || p.thingName || p.SerialNumber || p.serialNumber;
    return {
      isHttpEvent,
      thingName: resolvedThing,
      thingTypeName: p.ThingTypeName || p.thingTypeName || null,
      thingArn: p.ThingArn || p.thingArn || null,
      deviceType: p.DeviceType || p.deviceType || 'MASTER',
      serialNumber: p.SerialNumber || p.serialNumber || resolvedThing || null,
      attributes: p,
      metadata: null,
      raw,
    };
  }

  const hw = typeof raw.hardware === 'object' && raw.hardware !== null ? raw.hardware : {};
  const fw = typeof raw.firmware === 'object' && raw.firmware !== null ? raw.firmware : {};
  const mfg = typeof raw.manufacturing === 'object' && raw.manufacturing !== null ? raw.manufacturing : {};
  const attrs = typeof raw.attributes === 'object' && raw.attributes !== null ? raw.attributes : {};

  const topicStr = String(raw.topic || event?.topic || '');
  const topicMatch = topicStr.match(/(?:devices|lc-gate)\/([^\/]+)/);
  const topicThing = topicMatch ? topicMatch[1] : null;
  const prelimMaster = (raw.thing && raw.thing.Master) || (raw.Thing && raw.Thing.Master) || raw.Master || raw.master || {};
  const manifestSerial = prelimMaster['S.No.'] || prelimMaster['S.No'] || prelimMaster.sNo || prelimMaster.serialNumber;

  const resolvedThing =
    raw.MasterDeviceId ||
    raw.masterDeviceId ||
    raw.thingName ||
    raw.thing_name ||
    raw.topicThingName ||
    topicThing ||
    manifestSerial ||
    raw.SerialNumber ||
    raw.serialNumber ||
    attrs.serialNumber ||
    null;

  const manifestHw = extractManifestHardware(raw, resolvedThing);

  // Master DeviceRegistry.sensors only receives explicit master sensors (slave sensors live inside components / attributes.slaves)
  const masterSensorsRaw = manifestHw.masterObj?.Sensors || manifestHw.masterObj?.sensors;
  const sensors = raw.sensors !== undefined
    ? raw.sensors
    : (attrs.sensors !== undefined ? attrs.sensors : (masterSensorsRaw || []));

  const components = raw.components !== undefined
    ? raw.components
    : (attrs.components !== undefined ? attrs.components : manifestHw.parsedSlaves);

  const mergedAttrs = { ...attrs };
  if (manifestHw.deviceName) mergedAttrs.deviceName = manifestHw.deviceName;
  if (manifestHw.description) mergedAttrs.description = manifestHw.description;
  if (manifestHw.parsedSlaves.length > 0) mergedAttrs.slaves = manifestHw.parsedSlaves;
  if (raw.thing) mergedAttrs.thing = raw.thing;
  if (Object.keys(hw).length > 0 || manifestHw.deviceName || manifestHw.description) {
    mergedAttrs.hardware = {
      ...hw,
      ...(manifestHw.deviceName ? { deviceName: manifestHw.deviceName } : {}),
      ...(manifestHw.description ? { description: manifestHw.description } : {}),
    };
  }
  const firmwareVersion =
    raw.FirmwareVersion ||
    fw.version ||
    raw.firmwareVersion ||
    raw.firmware_version ||
    manifestHw.masterVersion ||
    (typeof raw.firmware === 'string' ? raw.firmware : null) ||
    attrs.firmwareVersion ||
    null;

  if (Object.keys(fw).length > 0 || firmwareVersion) {
    mergedAttrs.firmware = {
      ...fw,
      ...(firmwareVersion ? { version: firmwareVersion } : {}),
    };
  }

  return {
    thingName: resolvedThing,
    thingTypeName: raw.thingTypeName || raw.thing_type_name || attrs.thingTypeName || null,
    thingArn: raw.thingArn || raw.thing_arn || attrs.thingArn || null,
    deviceType: raw.DeviceType || raw.deviceType || raw.device_type || attrs.deviceType || 'MASTER',
    serialNumber: manifestSerial || raw.serialNumber || raw.SerialNumber || attrs.serialNumber || attrs.SerialNumber || null,
    dateOfMfg: mfg.dateOfMfg || raw.dateOfMfg || raw.date_of_mfg || raw.mfgDate || manifestHw.masterMfg || attrs.dateOfMfg || attrs.DateOfMfg,
    manufacturer: mfg.manufacturer || raw.manufacturer || attrs.manufacturer || null,
    modelNumber: mfg.modelNumber || raw.modelNumber || raw.model_number || attrs.modelNumber || attrs.ModelNumber || null,
    batchNumber: mfg.batchNumber || raw.batchNumber || raw.batch_number || attrs.batchNumber || null,
    firmwareVersion,
    hardwareVersion: hw.version || raw.hardwareVersion || raw.hardware_version || (typeof raw.hardware === 'string' ? raw.hardware : null) || attrs.hardwareVersion || null,
    macAddress: hw.macAddress || raw.macAddress || raw.mac_address || attrs.macAddress || null,
    imei: hw.imei || raw.imei || attrs.imei || null,
    sensors,
    components,
    runtimeConfig: raw.runtimeConfig || attrs.runtimeConfig || null,
    attributes: mergedAttrs,
    metadata: raw.metadata || null,
    raw,
  };
}

/**
 * Hardware association helper.
 * Unmapped AWS IoT Things MUST remain UNASSIGNED until explicitly linked via Cluster Management
 * (automatic serial guessing violates masterId @unique and skips LCGateEvent history sync).
 */
async function resolveAssociations() {
  return { gateId: null, masterId: null, childDeviceId: null };
}

async function bumpReportRevisionInTx(client, gateId) {
  if (!gateId || isNaN(gateId)) return 0n;
  const key = `REPORT_GATE_REV_${gateId}`;
  const revRes = await client.query(
    `
      INSERT INTO "AppSetting" ("key", "value")
      VALUES ($1, '1')
      ON CONFLICT ("key") DO UPDATE
      SET "value" = (CAST("AppSetting"."value" AS BIGINT) + 1)::TEXT
      RETURNING CAST("value" AS BIGINT) AS rev;
    `,
    [key]
  );
  return revRes.rows[0]?.rev != null ? BigInt(revRes.rows[0].rev) : 1n;
}

async function cleanupDetachedThingEventsInTx(client, { gateId, masterId, thingName }) {
  if (!gateId) return 0;
  const eventsRes = await client.query(
    `
      SELECT id, "gateId", "masterId", "masterSerial", "thingName",
             "openedAt", "closedAt", "durationSeconds", status,
             "openedBy", "closedBy", "trainNumber", remarks
      FROM "LCGateEvent"
      WHERE "gateId" = $1
        AND (
          ($2::text IS NOT NULL AND "thingName" = $2::text)
          OR ($3::int IS NOT NULL AND "masterId" = $3::int)
        )
      FOR UPDATE;
    `,
    [gateId, thingName || null, masterId || null]
  );

  const eventsToDelete = eventsRes.rows || [];
  if (eventsToDelete.length === 0) return 0;

  const revision = await bumpReportRevisionInTx(client, gateId);
  const revisionStr = revision.toString();

  for (const e of eventsToDelete) {
    await client.query(
      `
        INSERT INTO "LCGateEventTombstone" ("eventId", "gateId", "openedAt", "deletedAt")
        VALUES ($1, $2, $3, NOW());
      `,
      [e.id, e.gateId, e.openedAt]
    );

    await client.query(
      `
        INSERT INTO "LCGateEventChangeLog" (
          "eventId", "gateId", "masterId", "masterSerial", "thingName",
          "opType", "gateRevision", "status", "openedAt", "closedAt",
          "durationSeconds", "openedBy", "closedBy", "trainNumber", "remarks", "createdAt"
        )
        VALUES ($1, $2, $3, $4, $5, 'DELETE', $6::bigint, $7, $8, $9, $10, $11, $12, $13, $14, NOW());
      `,
      [
        e.id,
        e.gateId,
        e.masterId ?? null,
        e.masterSerial ?? null,
        e.thingName ?? null,
        revisionStr,
        e.status ?? null,
        e.openedAt ?? null,
        e.closedAt ?? null,
        e.durationSeconds ?? null,
        e.openedBy ?? null,
        e.closedBy ?? null,
        e.trainNumber ?? null,
        e.remarks ?? null,
      ]
    );
  }

  const deletedIds = eventsToDelete.map((e) => e.id);
  await client.query('DELETE FROM "LCGateEvent" WHERE id = ANY($1::int[])', [deletedIds]);
  return eventsToDelete.length;
}

async function handleDeletionEvent(event, raw, opts = {}) {
  const isHttpEvent = Boolean(opts.isHttpEvent);
  const topicStr = String(event?.topic || raw?.topic || '');
  const topicMatch = topicStr.match(/\$aws\/events\/thing\/([^\/]+)\/deleted/i);

  const thingToDelete =
    event.thingName ||
    raw?.thingName ||
    event.topicThingName ||
    raw?.topicThingName ||
    (topicMatch ? topicMatch[1] : null) ||
    (event.detail && event.detail.requestParameters && event.detail.requestParameters.thingName) ||
    (raw?.detail && raw.detail.requestParameters && raw.detail.requestParameters.thingName) ||
    (event.raw && event.raw.thingName);

  if (!thingToDelete) {
    if (isHttpEvent) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing thingName in deletion event' }) };
    }
    throw new Error('Missing thingName in deletion event');
  }

  if (!String(thingToDelete).toUpperCase().startsWith('LC-')) {
    console.log(`[IGNORING FOREIGN THING DELETION] thingName="${thingToDelete}" is not an LC Platform device`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Ignored foreign device deletion: ${thingToDelete}` }),
    };
  }

  console.log(`[DELETING DEVICE FROM RDS VIA AWS IOT LIFECYCLE EVENT] thingName=${thingToDelete}`);
  let client;
  try {
    const dbPool = getDbPool();
    client = await dbPool.connect();
    await client.query('BEGIN');
    const lockRes = await client.query(
      'SELECT id, "gateId", "masterId" FROM "DeviceRegistry" WHERE "thingName" = $1 FOR UPDATE',
      [thingToDelete]
    );
    const existing = lockRes.rows[0] || null;
    const registryId = existing?.id ?? null;

    let cleanedEventsCount = 0;
    if (existing?.gateId) {
      cleanedEventsCount = await cleanupDetachedThingEventsInTx(client, {
        gateId: existing.gateId,
        masterId: existing.masterId,
        thingName: thingToDelete,
      });
    }

    await client.query(
      'DELETE FROM "DeviceHealthCheck" WHERE "thingName" = $1 OR ($2::int IS NOT NULL AND "deviceRegistryId" = $2::int)',
      [thingToDelete, registryId]
    );
    await client.query(
      'DELETE FROM "DeviceTelemetry" WHERE "thingName" = $1 OR ($2::int IS NOT NULL AND "deviceRegistryId" = $2::int)',
      [thingToDelete, registryId]
    );
    const deleteRes = await client.query(
      'DELETE FROM "DeviceRegistry" WHERE "thingName" = $1 RETURNING id, "thingName"',
      [thingToDelete]
    );

    if (existing || deleteRes.rowCount > 0) {
      await bumpDirectoryRevisionInTx(client);
    }

    await client.query('COMMIT');
    console.log(
      `[DEVICE DELETED RESULT] thingName=${thingToDelete}, rowsDeleted=${deleteRes.rowCount}, cleanedEvents=${cleanedEventsCount}`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Device ${thingToDelete} deleted from RDS upon AWS IoT Thing deletion event`,
        rowsDeleted: deleteRes.rowCount,
        cleanedEventsCount,
      }),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('[ERROR DELETING DEVICE FROM RDS]', err);
    if (isHttpEvent) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
    throw err;
  } finally {
    if (client) client.release();
  }
}

async function upsertDeviceRegistry(client, fields) {
  const upsertSql = `
    INSERT INTO "DeviceRegistry" (
      "thingName", "thingArn", "thingTypeName", "deviceType", "serialNumber",
      "status", "connectivityStatus", "barrierState", "lastTelemetryAt",
      "gateId", "masterId", "childDeviceId", "macAddress", "imei",
      "firmwareVersion", "hardwareVersion", "dateOfMfg", "manufacturer",
      "modelNumber", "batchNumber", "sensors", "components", "attributes",
      "metadata", "lastSeenAt", "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, CASE WHEN $23::boolean THEN $26::timestamptz ELSE NULL END,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17,
      $18, $19, $20::jsonb, $21::jsonb, $22::jsonb,
      $24::jsonb, CASE WHEN $25::boolean THEN $26::timestamptz ELSE NULL END, NOW(), NOW()
    )
    ON CONFLICT ("thingName") DO UPDATE SET
      "thingArn" = COALESCE(EXCLUDED."thingArn", "DeviceRegistry"."thingArn"),
      "thingTypeName" = COALESCE(EXCLUDED."thingTypeName", "DeviceRegistry"."thingTypeName"),
      "deviceType" = COALESCE(NULLIF(EXCLUDED."deviceType", 'MASTER'), "DeviceRegistry"."deviceType", EXCLUDED."deviceType"),
      "serialNumber" = COALESCE(EXCLUDED."serialNumber", "DeviceRegistry"."serialNumber"),
      "status" = CASE
        WHEN "DeviceRegistry"."status" IN ('INACTIVE', 'DECOMMISSIONED') THEN "DeviceRegistry"."status"
        ELSE COALESCE(NULLIF("DeviceRegistry"."status", 'ONLINE'), 'ACTIVE')
      END,
      "connectivityStatus" = CASE
        WHEN "DeviceRegistry"."status" IN ('INACTIVE', 'DECOMMISSIONED') THEN "DeviceRegistry"."connectivityStatus"
        WHEN $25::boolean THEN 'ONLINE'
        ELSE "DeviceRegistry"."connectivityStatus"
      END,
      "barrierState" = COALESCE(EXCLUDED."barrierState", "DeviceRegistry"."barrierState"),
      "lastTelemetryAt" = CASE
        WHEN $23::boolean THEN GREATEST(COALESCE("DeviceRegistry"."lastTelemetryAt", $26::timestamptz), $26::timestamptz)
        ELSE "DeviceRegistry"."lastTelemetryAt"
      END,
      "gateId" = COALESCE("DeviceRegistry"."gateId", EXCLUDED."gateId"),
      "masterId" = COALESCE("DeviceRegistry"."masterId", EXCLUDED."masterId"),
      "childDeviceId" = COALESCE("DeviceRegistry"."childDeviceId", EXCLUDED."childDeviceId"),
      "macAddress" = COALESCE(EXCLUDED."macAddress", "DeviceRegistry"."macAddress"),
      "imei" = COALESCE(EXCLUDED."imei", "DeviceRegistry"."imei"),
      "firmwareVersion" = COALESCE(EXCLUDED."firmwareVersion", "DeviceRegistry"."firmwareVersion"),
      "hardwareVersion" = COALESCE(EXCLUDED."hardwareVersion", "DeviceRegistry"."hardwareVersion"),
      "dateOfMfg" = COALESCE(EXCLUDED."dateOfMfg", "DeviceRegistry"."dateOfMfg"),
      "manufacturer" = COALESCE(EXCLUDED."manufacturer", "DeviceRegistry"."manufacturer"),
      "modelNumber" = COALESCE(EXCLUDED."modelNumber", "DeviceRegistry"."modelNumber"),
      "batchNumber" = COALESCE(EXCLUDED."batchNumber", "DeviceRegistry"."batchNumber"),
      "sensors" = CASE
        WHEN EXCLUDED."sensors" IS NOT NULL AND EXCLUDED."sensors"::text != '[]' THEN EXCLUDED."sensors"
        ELSE "DeviceRegistry"."sensors"
      END,
      "components" = CASE
        WHEN EXCLUDED."components" IS NOT NULL AND EXCLUDED."components"::text != '[]' THEN EXCLUDED."components"
        ELSE "DeviceRegistry"."components"
      END,
      "attributes" = CASE
        WHEN EXCLUDED."attributes" IS NOT NULL AND EXCLUDED."attributes"::text != '{}' THEN COALESCE("DeviceRegistry"."attributes", '{}'::jsonb) || EXCLUDED."attributes"
        ELSE "DeviceRegistry"."attributes"
      END,
      "metadata" = CASE
        WHEN EXCLUDED."metadata" IS NOT NULL AND EXCLUDED."metadata"::text != '{}' THEN
          COALESCE("DeviceRegistry"."metadata", '{}'::jsonb) ||
          EXCLUDED."metadata" ||
          CASE
            WHEN "DeviceRegistry"."metadata" ? 'registeredAt' THEN jsonb_build_object(
              'registeredAt', "DeviceRegistry"."metadata"->'registeredAt',
              'registeredVia', COALESCE("DeviceRegistry"."metadata"->'registeredVia', to_jsonb('AWS_IOT_DEVICE_LAMBDA'::text))
            )
            ELSE '{}'::jsonb
          END
        ELSE "DeviceRegistry"."metadata"
      END,
      "lastSeenAt" = CASE
        WHEN $25::boolean THEN GREATEST(COALESCE("DeviceRegistry"."lastSeenAt", $26::timestamptz), $26::timestamptz)
        ELSE "DeviceRegistry"."lastSeenAt"
      END,
      "updatedAt" = NOW()
    RETURNING *;
  `;

  const values = [
    fields.thingName,                         // $1
    fields.thingArn,                          // $2
    fields.thingTypeName,                     // $3
    fields.deviceType,                        // $4
    fields.serialNumber,                      // $5
    fields.lifecycleStatus,                   // $6
    fields.connectivityStatus,                // $7
    fields.barrierState,                      // $8 (kept null on Lambda telemetry so telemetryMonitor owns transition)
    fields.gateId,                            // $9
    fields.masterId,                          // $10
    fields.childDeviceId,                     // $11
    fields.macAddress,                        // $12
    fields.imei,                              // $13
    fields.firmwareVersion,                   // $14
    fields.hardwareVersion,                   // $15
    fields.dateOfMfg,                         // $16
    fields.manufacturer,                      // $17
    fields.modelNumber,                       // $18
    fields.batchNumber,                       // $19
    JSON.stringify(fields.sensors),           // $20
    JSON.stringify(fields.components),        // $21
    JSON.stringify(fields.attributesJson),    // $22
    Boolean(fields.barrierState),             // $23
    JSON.stringify(fields.metadataJson),      // $24
    Boolean(fields.isMqttLive),               // $25
    fields.eventTimestamp || new Date(),      // $26
  ];

  const result = await client.query(upsertSql, values);
  return result.rows[0];
}

async function insertHealthCheck(client, thingName, raw, savedRecordId, fallbackFirmware, eventTimestamp) {
  const resolvedGateStatus = parseBarrierStateFromPayload(raw);
  const rawStatusUpper = raw.status !== undefined && raw.status !== null ? String(raw.status).trim().toUpperCase() : '';
  const explicitHealthStatus = raw.healthstatus ? String(raw.healthstatus).trim().toUpperCase() : null;
  const parsedHealthVerdict =
    explicitHealthStatus ||
    (['HEALTHY', 'DEGRADED'].includes(rawStatusUpper) ? rawStatusUpper : null) ||
    'HEALTHY';
  const networkType = raw.NetworkType || raw.networkType || null;

  await client.query(`
    INSERT INTO "DeviceHealthCheck" (
      "thingName", "requestId", "healthstatus", "gateStatus", "boomAngle",
      "mcuTempC", "signalStrength", "networkType", "limitSwitchClosed", "hallClosed",
      "batteryVoltage", "batteryPercentage", "solarVoltage", "solarCharging",
      "uptimeSeconds", "firmwareVersion", "rawPayload", "deviceRegistryId", "createdAt"
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18, $19::timestamptz
    )
  `, [
    thingName,
    raw.requestId || null,
    parsedHealthVerdict,
    resolvedGateStatus,
    toFiniteFloat(raw.BoomAngle),
    toFiniteFloat(raw.McuTempC),
    toFiniteInt(raw.SignalStrength),
    networkType,
    toStrictBoolean(raw.LimitSwitchClosed),
    toStrictBoolean(raw.HallClosed),
    toFiniteFloat(raw.BatteryVoltage),
    toFiniteInt(raw.BatteryPercentage),
    toFiniteFloat(raw.SolarVoltage),
    toStrictBoolean(raw.SolarCharging),
    toFiniteInt(raw.UptimeSeconds),
    raw.FirmwareVersion || fallbackFirmware || null,
    JSON.stringify(raw),
    savedRecordId,
    eventTimestamp || new Date(),
  ]);
}

async function insertDeviceTelemetry(client, { thingName, telemetryTopic, raw, teleStatus, savedRecordId, eventTimestamp }) {
  const res = await client.query(`
    INSERT INTO "DeviceTelemetry" ("thingName", "topic", "payload", "status", "deviceRegistryId", "receivedAt")
    VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
    RETURNING id, "receivedAt"
  `, [
    thingName,
    telemetryTopic,
    JSON.stringify(raw),
    teleStatus,
    savedRecordId,
    eventTimestamp || new Date(),
  ]);

  return res.rows[0];
}

exports.handler = async (event) => {
  console.log('[DEVICE REGISTRATION EVENT RECEIVED]', JSON.stringify(event));

  const isHttpEvent = Boolean(
    event &&
      (event.body !== undefined ||
        event.requestContext !== undefined ||
        event.httpMethod !== undefined)
  );

  let parsed;
  let raw;
  let classification;
  try {
    parsed = extractDevicePayload(event);
    raw = parsed.raw || event || {};
    classification = classifyIoTEvent(event || {}, raw);
  } catch (parseErr) {
    console.error('[INVALID PAYLOAD]', parseErr);
    if (isHttpEvent) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: parseErr.message }),
      };
    }
    throw parseErr;
  }

  if (classification.isDeletionEvent) {
    return handleDeletionEvent(event || {}, raw, { isHttpEvent });
  }

  if (classification.isHealthRequestEcho) {
    console.log('[IGNORING OUTBOUND HEALTH CHECK REQUEST TOPIC]', classification.topicStr);
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignored outbound command' }) };
  }

  const thingName = parsed.thingName;
  if (!thingName) {
    console.error('[ERROR] Missing thingName in event payload');
    if (isHttpEvent) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing thingName in event payload' }),
      };
    }
    throw new Error('Missing thingName in event payload');
  }

  if (!String(thingName).toUpperCase().startsWith('LC-')) {
    console.log(`[IGNORING FOREIGN THING] thingName="${thingName}" does not belong to LC Platform (must start with "LC-")`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Ignored foreign device: ${thingName}` }),
    };
  }

  const attrs = parsed.attributes || {};
  // Live connectivity comes strictly from direct AWS IoT MQTT device packets (never HTTP API writes or lifecycle events)
  const isMqttLive = !classification.isLifecycleEvent && !(parsed.isHttpEvent || isHttpEvent);
  const eventTimestamp = resolveEventTimestamp(event, raw);
  const barrierState = (classification.isTelemetryReport || classification.isHealthReport)
    ? parseBarrierStateFromPayload(raw)
    : null;
  // Do not pre-overwrite DeviceRegistry.barrierState / lastTelemetryAt inside Lambda:
  // backend telemetryMonitor owns monotonic barrierState & lastTelemetryAt updates + LCGateEvent transitions (and health checks never set lastTelemetryAt).
  const registryBarrierState = null;

  const sensors = safeJson(parsed.sensors, []);
  const components = safeJson(parsed.components, []);
  const attributesJson = safeJson(attrs, {});
  const metadataJson = safeJson(parsed.metadata, {
    registeredVia: isHttpEvent ? 'API_REGISTRATION_LAMBDA' : 'AWS_IOT_DEVICE_LAMBDA',
    registeredAt: new Date().toISOString(),
    eventSource: event?.eventType || (classification.isLifecycleUpdated ? 'THING_UPDATED' : (classification.isManifestReport ? 'MQTT_MANIFEST' : (classification.isHealthReport ? 'MQTT_HEALTH' : 'MQTT_TELEMETRY'))),
    ...(parsed.runtimeConfig ? { runtimeConfig: parsed.runtimeConfig } : {}),
  });

  let client;
  try {
    const dbPool = getDbPool();
    client = await dbPool.connect();
    await client.query('BEGIN');

    const lockRes = await client.query(
      'SELECT id, "serialNumber", "thingTypeName", "connectivityStatus", "lastSeenAt", "gateId", "masterId" FROM "DeviceRegistry" WHERE "thingName" = $1 FOR UPDATE',
      [thingName]
    );
    const existing = lockRes.rows[0] || null;
    const wasOffline =
      !existing ||
      existing.connectivityStatus !== 'ONLINE' ||
      !existing.lastSeenAt ||
      (eventTimestamp.getTime() - new Date(existing.lastSeenAt).getTime() > GATE_ONLINE_CUTOFF_MS);

    const explicitSerial = parsed.serialNumber || attrs.serialNumber || attrs.SerialNumber || null;
    let serialNumber = explicitSerial;
    if (serialNumber) {
      const conflictRes = await client.query(
        'SELECT id, "thingName" FROM "DeviceRegistry" WHERE "serialNumber" = $1 AND "thingName" <> $2 LIMIT 1',
        [serialNumber, thingName]
      );
      if (conflictRes.rows.length > 0) {
        console.warn(
          `⚠️ [P0.5] Serial "${serialNumber}" already assigned to "${conflictRes.rows[0].thingName}"; falling back to avoid 23505 on "${thingName}".`
        );
        serialNumber = null;
      }
    }
    if (!serialNumber && (!existing || !existing.serialNumber)) {
      const thingFallbackConflict = await client.query(
        'SELECT id, "thingName" FROM "DeviceRegistry" WHERE "serialNumber" = $1 AND "thingName" <> $2 LIMIT 1',
        [thingName, thingName]
      );
      serialNumber = thingFallbackConflict.rows.length === 0 ? thingName : null;
    }

    const { gateId, masterId, childDeviceId } = await resolveAssociations(client, serialNumber);

    const savedRecord = await upsertDeviceRegistry(client, {
      thingName,
      thingArn: parsed.thingArn || attrs.thingArn || null,
      thingTypeName: parsed.thingTypeName || attrs.thingTypeName || (existing?.thingTypeName ? null : 'MasterUnit'),
      deviceType: parsed.deviceType || attrs.deviceType || attrs.DeviceType || 'MASTER',
      serialNumber,
      lifecycleStatus: 'ACTIVE',
      connectivityStatus: isMqttLive ? 'ONLINE' : 'OFFLINE',
      barrierState: registryBarrierState,
      gateId,
      masterId,
      childDeviceId,
      macAddress: parsed.macAddress || attrs.macAddress || null,
      imei: parsed.imei || attrs.imei || null,
      firmwareVersion: parsed.firmwareVersion || attrs.firmwareVersion || attrs.Firmware || null,
      hardwareVersion: parsed.hardwareVersion || attrs.hardwareVersion || null,
      dateOfMfg: parseFlexibleDate(parsed.dateOfMfg),
      manufacturer: parsed.manufacturer || attrs.manufacturer || null,
      modelNumber: parsed.modelNumber || attrs.modelNumber || attrs.ModelNumber || null,
      batchNumber: parsed.batchNumber || attrs.batchNumber || null,
      sensors,
      components,
      attributesJson,
      metadataJson,
      isMqttLive,
      eventTimestamp,
    });

    let telemetryRecord = null;
    if (classification.isHealthReport) {
      await insertHealthCheck(client, thingName, raw, savedRecord.id, parsed.firmwareVersion, eventTimestamp);
      console.log(`[SUCCESS] Recorded health diagnostic in DeviceHealthCheck for thing=${thingName}`);
    } else {
      const telemetryTopic =
        event?.topic ||
        raw?.topic ||
        (classification.isLifecycleCreated
          ? `$aws/events/thing/${thingName}/created`
          : classification.isLifecycleUpdated
            ? `$aws/events/thing/${thingName}/updated`
            : classification.isManifestReport
              ? `lc/devices/${thingName}/manifest`
              : `lc-gate/${thingName}/telemetry`);

      const rawUpperStatus = raw?.Status ? String(raw.Status).trim().toUpperCase() : null;
      const rawUpperDeviceStatus = raw?.DeviceStatus ? String(raw.DeviceStatus).trim().toUpperCase() : null;
      const explicitNonHeartbeatStatus =
        barrierState ||
        (rawUpperStatus && rawUpperStatus !== 'ONLINE' ? rawUpperStatus : null) ||
        (rawUpperDeviceStatus && rawUpperDeviceStatus !== 'ONLINE' ? rawUpperDeviceStatus : null);

      const teleStatus = classification.isLifecycleCreated
        ? 'ACTIVE'
        : classification.isLifecycleUpdated
          ? 'UPDATED'
          : classification.isManifestReport
            ? 'MANIFEST'
            : (explicitNonHeartbeatStatus || 'HEARTBEAT');

      telemetryRecord = await insertDeviceTelemetry(client, {
        thingName,
        telemetryTopic,
        raw,
        teleStatus,
        savedRecordId: savedRecord.id,
        eventTimestamp,
      });
      console.log(`[SUCCESS] Recorded DeviceTelemetry id=${telemetryRecord?.id} for thing=${thingName} (topic=${telemetryTopic}, status=${teleStatus})`);
    }

    if (isMqttLive && wasOffline) {
      await bumpDirectoryRevisionInTx(client);
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Device and telemetry processed successfully in LC-Platform RDS',
        device: savedRecord,
        telemetryId: telemetryRecord?.id || null,
      }),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('[DB INSERT ERROR]', err);
    if (isHttpEvent) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message, stack: err.stack }),
      };
    }
    // Throw for async AWS IoT / EventBridge triggers so Lambda retries & DLQ engage
    throw err;
  } finally {
    if (client) client.release();
  }
};

exports._helpers = {
  parseFlexibleDate,
  parseBarrierStateFromPayload,
  extractManifestHardware,
  classifyIoTEvent,
  extractDevicePayload,
  resolveEventTimestamp,
  toStrictBoolean,
  toFiniteFloat,
  toFiniteInt,
};
