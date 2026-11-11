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
      connectionTimeoutMillis: 10000,
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

/**
 * Parses DD-MM-YYYY, ISO strings, or epoch milliseconds into an ISO timestamp string.
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
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return d.toISOString();
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

  const isDeletionEvent =
    event.eventType === 'deleted' ||
    event.eventType === 'thingDeleted' ||
    raw?.eventType === 'deleted' ||
    raw?.eventType === 'thingDeleted' ||
    topicLower.endsWith('/deleted') ||
    (event.detail && event.detail.eventName === 'DeleteThing') ||
    (raw?.detail && raw.detail.eventName === 'DeleteThing');

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
    (raw?.operation === 'CREATED' ||
      raw?.eventType === 'THING_EVENT' ||
      raw?.eventType === 'THING_CREATED' ||
      topicLower.endsWith('/created') ||
      Boolean(raw?.detail && (raw.detail.eventName === 'CreateThing' || raw.detail.eventName === 'RegisterThing')));

  const isManifestReport =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    !isLifecycleCreated &&
    (topicLower.includes('/manifest') ||
      Boolean(raw?.thing?.Master || raw?.thing?.master || raw?.Thing?.Master || raw?.Master || raw?.master));

  const isTelemetryReport =
    !isDeletionEvent &&
    !isHealthRequestEcho &&
    !isHealthReport &&
    !isLifecycleCreated &&
    !isManifestReport;

  return {
    topicStr,
    isDeletionEvent,
    isHealthRequestEcho,
    isHealthReport,
    isLifecycleCreated,
    isManifestReport,
    isTelemetryReport,
  };
}

/**
 * Normalizes incoming events from AWS IoT Topic Rules, Lifecycle Events, Fleet Provisioning, or API Gateway.
 */
function extractDevicePayload(event) {
  let raw = event || {};

  if (event && event.body) {
    raw = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  }

  if (raw.detail && raw.detail.requestParameters) {
    const req = raw.detail.requestParameters;
    return {
      thingName: req.thingName,
      thingTypeName: req.thingTypeName || 'MasterUnit',
      thingArn: raw.detail.responseElements?.thingArn || null,
      deviceType: 'MASTER',
      serialNumber: req.thingName,
      attributes: req.attributePayload?.attributes || {},
      metadata: null,
      raw,
    };
  }

  if (raw.parameters) {
    const p = raw.parameters;
    const resolvedThing = p.ThingName || p.thingName || p.SerialNumber || p.serialNumber;
    return {
      thingName: resolvedThing,
      thingTypeName: p.ThingTypeName || p.thingTypeName || 'MasterUnit',
      thingArn: p.ThingArn || p.thingArn || null,
      deviceType: p.DeviceType || p.deviceType || 'MASTER',
      serialNumber: resolvedThing,
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

  const sensors = raw.sensors !== undefined
    ? raw.sensors
    : (attrs.sensors !== undefined ? attrs.sensors : manifestHw.normalizedSensors);

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
    thingTypeName: raw.thingTypeName || raw.thing_type_name || attrs.thingTypeName || 'MasterUnit',
    thingArn: raw.thingArn || raw.thing_arn || attrs.thingArn || null,
    deviceType: raw.DeviceType || raw.deviceType || raw.device_type || attrs.deviceType || 'MASTER',
    serialNumber: manifestSerial || resolvedThing,
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
 * Resolves exact 1-to-1 associations to existing MasterUnit or ChildDevice by serialNumber.
 * Unmapped AWS IoT Things remain UNASSIGNED until explicitly linked via Cluster management.
 */
async function resolveAssociations(client, serialNumber) {
  if (!serialNumber) return { gateId: null, masterId: null, childDeviceId: null };

  let gateId = null;
  let masterId = null;
  let childDeviceId = null;

  try {
    const masterRes = await client.query(
      'SELECT id, "gateId" FROM "MasterUnit" WHERE "serialNumber" = $1 LIMIT 1',
      [serialNumber]
    );
    if (masterRes.rows.length > 0) {
      masterId = masterRes.rows[0].id;
      gateId = masterRes.rows[0].gateId;
    } else {
      const childRes = await client.query(
        'SELECT c.id, c."masterId", m."gateId" FROM "ChildDevice" c JOIN "MasterUnit" m ON c."masterId" = m.id WHERE c."serialNumber" = $1 LIMIT 1',
        [serialNumber]
      );
      if (childRes.rows.length > 0) {
        childDeviceId = childRes.rows[0].id;
        masterId = childRes.rows[0].masterId;
        gateId = childRes.rows[0].gateId;
      }
    }
  } catch (err) {
    console.warn('[ASSOCIATION LOOKUP WARNING]', err.message);
  }

  return { gateId, masterId, childDeviceId };
}

async function handleDeletionEvent(event, raw) {
  const thingToDelete =
    event.thingName ||
    raw?.thingName ||
    (event.detail && event.detail.requestParameters && event.detail.requestParameters.thingName) ||
    (raw?.detail && raw.detail.requestParameters && raw.detail.requestParameters.thingName) ||
    (event.raw && event.raw.thingName);

  if (!thingToDelete) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing thingName in deletion event' }) };
  }

  if (!String(thingToDelete).toUpperCase().startsWith('LC-')) {
    console.log(`[IGNORING FOREIGN THING DELETION] thingName="${thingToDelete}" is not an LC Platform device`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Ignored foreign device deletion: ${thingToDelete}` }),
    };
  }

  console.log(`[DELETING DEVICE FROM RDS VIA AWS IOT LIFECYCLE EVENT] thingName=${thingToDelete}`);
  const dbPool = getDbPool();
  const client = await dbPool.connect();
  try {
    await client.query('DELETE FROM "DeviceHealthCheck" WHERE "thingName" = $1', [thingToDelete]);
    await client.query('DELETE FROM "DeviceTelemetry" WHERE "thingName" = $1', [thingToDelete]);
    const deleteRes = await client.query(
      'DELETE FROM "DeviceRegistry" WHERE "thingName" = $1 RETURNING id, "thingName"',
      [thingToDelete]
    );
    console.log(`[DEVICE DELETED RESULT] thingName=${thingToDelete}, rowsDeleted=${deleteRes.rowCount}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Device ${thingToDelete} deleted from RDS upon AWS IoT Thing deletion event`,
        rowsDeleted: deleteRes.rowCount,
      }),
    };
  } catch (err) {
    console.error('[ERROR DELETING DEVICE FROM RDS]', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  } finally {
    client.release();
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
      $6, $7, $8, CASE WHEN $23::boolean THEN NOW() ELSE NULL END,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17,
      $18, $19, $20::jsonb, $21::jsonb, $22::jsonb,
      $24::jsonb, CASE WHEN $25::boolean THEN NOW() ELSE NULL END, NOW(), NOW()
    )
    ON CONFLICT ("thingName") DO UPDATE SET
      "thingArn" = COALESCE(EXCLUDED."thingArn", "DeviceRegistry"."thingArn"),
      "thingTypeName" = COALESCE(EXCLUDED."thingTypeName", "DeviceRegistry"."thingTypeName"),
      "deviceType" = COALESCE(NULLIF(EXCLUDED."deviceType", 'MASTER'), "DeviceRegistry"."deviceType", EXCLUDED."deviceType"),
      "serialNumber" = COALESCE(EXCLUDED."serialNumber", "DeviceRegistry"."serialNumber"),
      "status" = COALESCE(NULLIF("DeviceRegistry"."status", 'ONLINE'), 'ACTIVE'),
      "connectivityStatus" = CASE WHEN $25::boolean THEN 'ONLINE' ELSE "DeviceRegistry"."connectivityStatus" END,
      "barrierState" = COALESCE(EXCLUDED."barrierState", "DeviceRegistry"."barrierState"),
      "lastTelemetryAt" = CASE WHEN $23::boolean THEN NOW() ELSE "DeviceRegistry"."lastTelemetryAt" END,
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
        WHEN EXCLUDED."metadata" IS NOT NULL AND EXCLUDED."metadata"::text != '{}' THEN COALESCE("DeviceRegistry"."metadata", '{}'::jsonb) || EXCLUDED."metadata"
        ELSE "DeviceRegistry"."metadata"
      END,
      "lastSeenAt" = CASE WHEN $25::boolean THEN NOW() ELSE "DeviceRegistry"."lastSeenAt" END,
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
    fields.barrierState,                      // $8
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
  ];

  const result = await client.query(upsertSql, values);
  return result.rows[0];
}

async function insertHealthCheck(client, thingName, raw, savedRecordId, fallbackFirmware) {
  const resolvedGateStatus = parseBarrierStateFromPayload(raw);
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
      $15, $16, $17, $18, NOW()
    )
  `, [
    thingName,
    raw.requestId || null,
    raw.healthstatus || 'HEALTHY',
    resolvedGateStatus,
    raw.BoomAngle !== undefined && raw.BoomAngle !== null ? parseFloat(raw.BoomAngle) : null,
    raw.McuTempC !== undefined && raw.McuTempC !== null ? parseFloat(raw.McuTempC) : null,
    raw.SignalStrength !== undefined && raw.SignalStrength !== null ? parseInt(raw.SignalStrength, 10) : null,
    raw.NetworkType || raw.networkType || '4G_LTE',
    raw.LimitSwitchClosed !== undefined && raw.LimitSwitchClosed !== null ? Boolean(raw.LimitSwitchClosed) : null,
    raw.HallClosed !== undefined && raw.HallClosed !== null ? Boolean(raw.HallClosed) : null,
    raw.BatteryVoltage !== undefined && raw.BatteryVoltage !== null ? parseFloat(raw.BatteryVoltage) : null,
    raw.BatteryPercentage !== undefined && raw.BatteryPercentage !== null ? parseInt(raw.BatteryPercentage, 10) : null,
    raw.SolarVoltage !== undefined && raw.SolarVoltage !== null ? parseFloat(raw.SolarVoltage) : null,
    raw.SolarCharging !== undefined && raw.SolarCharging !== null ? Boolean(raw.SolarCharging) : null,
    raw.UptimeSeconds !== undefined && raw.UptimeSeconds !== null ? parseInt(raw.UptimeSeconds, 10) : null,
    raw.FirmwareVersion || fallbackFirmware || null,
    JSON.stringify(raw),
    savedRecordId,
  ]);
}

async function insertDeviceTelemetry(client, { thingName, telemetryTopic, raw, teleStatus, savedRecordId, isGenuineBarrierTelemetry }) {
  const res = await client.query(`
    INSERT INTO "DeviceTelemetry" ("thingName", "topic", "payload", "status", "deviceRegistryId", "receivedAt")
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id, "receivedAt"
  `, [
    thingName,
    telemetryTopic,
    JSON.stringify(raw),
    teleStatus,
    savedRecordId,
  ]);

  const inserted = res.rows[0];
  if (isGenuineBarrierTelemetry && inserted?.id) {
    await client.query(`
      UPDATE "DeviceRegistry"
      SET "lastTelemetryId" = $1, "lastTelemetryAt" = $2, "updatedAt" = NOW()
      WHERE id = $3
    `, [inserted.id, inserted.receivedAt, savedRecordId]);
  }
  return inserted;
}

exports.handler = async (event) => {
  console.log('[DEVICE REGISTRATION EVENT RECEIVED]', JSON.stringify(event));

  const parsed = extractDevicePayload(event);
  const raw = parsed.raw || event || {};
  const classification = classifyIoTEvent(event || {}, raw);

  if (classification.isDeletionEvent) {
    return handleDeletionEvent(event || {}, raw);
  }

  if (classification.isHealthRequestEcho) {
    console.log('[IGNORING OUTBOUND HEALTH CHECK REQUEST TOPIC]', classification.topicStr);
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignored outbound command' }) };
  }

  const thingName = parsed.thingName;
  if (!thingName) {
    console.error('[ERROR] Missing thingName in event payload');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing thingName in event payload' }),
    };
  }

  if (!String(thingName).toUpperCase().startsWith('LC-')) {
    console.log(`[IGNORING FOREIGN THING] thingName="${thingName}" does not belong to LC Platform (must start with "LC-")`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Ignored foreign device: ${thingName}` }),
    };
  }

  const attrs = parsed.attributes || {};
  const isMqttLive = !classification.isLifecycleCreated;
  const barrierState = (classification.isTelemetryReport || classification.isHealthReport)
    ? parseBarrierStateFromPayload(raw)
    : null;

  const sensors = safeJson(parsed.sensors, []);
  const components = safeJson(parsed.components, []);
  const attributesJson = safeJson(attrs, {});
  const metadataJson = safeJson(parsed.metadata, {
    registeredVia: 'AWS_IOT_DEVICE_LAMBDA',
    registeredAt: new Date().toISOString(),
    eventSource: event?.eventType || (classification.isManifestReport ? 'MQTT_MANIFEST' : (classification.isHealthReport ? 'MQTT_HEALTH' : 'MQTT_TELEMETRY')),
    ...(parsed.runtimeConfig ? { runtimeConfig: parsed.runtimeConfig } : {}),
  });

  const dbPool = getDbPool();
  const client = await dbPool.connect();

  try {
    const serialNumber = parsed.serialNumber || attrs.serialNumber || attrs.SerialNumber || thingName;
    const { gateId, masterId, childDeviceId } = await resolveAssociations(client, serialNumber);

    const savedRecord = await upsertDeviceRegistry(client, {
      thingName,
      thingArn: parsed.thingArn || attrs.thingArn || null,
      thingTypeName: parsed.thingTypeName || attrs.thingTypeName || 'MasterUnit',
      deviceType: parsed.deviceType || attrs.deviceType || attrs.DeviceType || 'MASTER',
      serialNumber,
      lifecycleStatus: 'ACTIVE',
      connectivityStatus: isMqttLive ? 'ONLINE' : 'OFFLINE',
      barrierState,
      gateId,
      masterId,
      childDeviceId,
      macAddress: parsed.macAddress || attrs.macAddress || null,
      imei: parsed.imei || attrs.imei || null,
      firmwareVersion: parsed.firmwareVersion || attrs.firmwareVersion || attrs.Firmware || null,
      hardwareVersion: parsed.hardwareVersion || attrs.hardwareVersion || 'rev1.0',
      dateOfMfg: parseFlexibleDate(parsed.dateOfMfg),
      manufacturer: parsed.manufacturer || attrs.manufacturer || 'Mirtha / LC-Platform',
      modelNumber: parsed.modelNumber || attrs.modelNumber || attrs.ModelNumber || 'LC-GATE-CONTROLLER',
      batchNumber: parsed.batchNumber || attrs.batchNumber || null,
      sensors,
      components,
      attributesJson,
      metadataJson,
      isMqttLive,
    });

    let telemetryRecord = null;
    if (classification.isHealthReport) {
      await insertHealthCheck(client, thingName, raw, savedRecord.id, parsed.firmwareVersion);
      console.log(`[SUCCESS] Recorded health diagnostic in DeviceHealthCheck for thing=${thingName}`);
    } else {
      const telemetryTopic =
        event?.topic ||
        raw?.topic ||
        (classification.isLifecycleCreated
          ? `$aws/events/thing/${thingName}/created`
          : classification.isManifestReport
            ? `lc/devices/${thingName}/manifest`
            : `lc-gate/${thingName}/telemetry`);

      const teleStatus = classification.isLifecycleCreated
        ? 'ACTIVE'
        : classification.isManifestReport
          ? 'MANIFEST'
          : (barrierState || (raw?.Status ? String(raw.Status).trim().toUpperCase() : null) || (raw?.DeviceStatus ? String(raw.DeviceStatus).trim().toUpperCase() : null) || 'ONLINE');

      telemetryRecord = await insertDeviceTelemetry(client, {
        thingName,
        telemetryTopic,
        raw,
        teleStatus,
        savedRecordId: savedRecord.id,
        isGenuineBarrierTelemetry: classification.isTelemetryReport && barrierState !== null,
      });
      console.log(`[SUCCESS] Recorded DeviceTelemetry id=${telemetryRecord?.id} for thing=${thingName} (topic=${telemetryTopic}, status=${teleStatus})`);
    }

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
    console.error('[DB INSERT ERROR]', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  } finally {
    client.release();
  }
};

exports._helpers = {
  parseFlexibleDate,
  parseBarrierStateFromPayload,
  extractManifestHardware,
  classifyIoTEvent,
  extractDevicePayload,
};
