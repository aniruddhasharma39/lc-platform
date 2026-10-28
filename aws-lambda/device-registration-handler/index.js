/**
 * AWS Lambda Function: LC-Platform Device Registry Handler
 * 
 * Triggered automatically when an IoT device is registered as a "Thing" in AWS IoT Core.
 * Parses the IoT lifecycle event / rule payload and registers/upserts the device
 * into the RDS PostgreSQL "DeviceRegistry" table with hardware metadata:
 * sensors within, components, date of mfg, firmware version, gate linkage, etc.
 * 
 * Supported Triggers:
 * 1. AWS IoT Topic Rule on '$aws/events/thing/+/created'
 * 2. AWS IoT Fleet Provisioning pre/post-provisioning hook
 * 3. EventBridge (aws.iot CreateThing / RegisterThing)
 * 4. API Gateway / Function URL / Direct Invocation
 */

const { Pool } = require('pg');

// Global connection pool cached across Lambda warm invocations
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
      max: 3, // Keep pool small for Lambda concurrency
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('[DB POOL ERROR]', err);
    });
  }
  return pool;
}

/**
 * Normalizes incoming events from different AWS IoT sources
 */
function extractDevicePayload(event) {
  let raw = event;

  // Handle API Gateway / Function URL body
  if (event.body) {
    raw = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  }

  // Handle EventBridge CloudTrail format
  if (raw.detail && raw.detail.requestParameters) {
    const req = raw.detail.requestParameters;
    return {
      thingName: req.thingName,
      thingTypeName: req.thingTypeName || null,
      thingArn: raw.detail.responseElements?.thingArn || null,
      attributes: req.attributePayload?.attributes || {},
      raw,
    };
  }

  // Handle AWS IoT Fleet Provisioning template hook format
  if (raw.parameters) {
    const p = raw.parameters;
    return {
      thingName: p.ThingName || p.thingName || p.SerialNumber || p.serialNumber,
      thingTypeName: p.ThingTypeName || p.thingTypeName || null,
      thingArn: p.ThingArn || p.thingArn || null,
      attributes: p,
      raw,
    };
  }

  // Standard AWS IoT Rule, MQTT manifest topic, or direct payload format
  // Handles nested structures from firmware: { hardware: {...}, firmware: {...}, manufacturing: {...}, sensors: [...], components: [...] }
  const hw = raw.hardware || {};
  const fw = raw.firmware || {};
  const mfg = raw.manufacturing || {};
  const attrs = raw.attributes || {};

  const topicStr = String(raw.topic || event.topic || '');
  const topicMatch = topicStr.match(/(?:devices|lc-gate)\/([^\/]+)/);
  const topicThing = topicMatch ? topicMatch[1] : null;
  const thingMaster = (raw.thing && raw.thing.Master) || raw.Master || {};
  const manifestSerial = thingMaster['S.No.'] || thingMaster['S.No'] || thingMaster.serialNumber;
  const resolvedThing = raw.MasterDeviceId || raw.masterDeviceId || raw.thingName || raw.thing_name || raw.topicThingName || topicThing || manifestSerial || raw.SerialNumber || raw.serialNumber || attrs.serialNumber;

  return {
    thingName: resolvedThing,
    thingTypeName: raw.thingTypeName || raw.thing_type_name || attrs.thingTypeName || 'MasterUnit',
    thingArn: raw.thingArn || raw.thing_arn || attrs.thingArn || null,
    deviceType: raw.DeviceType || raw.deviceType || raw.device_type || attrs.deviceType || 'MASTER',
    serialNumber: resolvedThing,
    status: raw.Status || attrs.status || 'ACTIVE',
    dateOfMfg: mfg.dateOfMfg || raw.dateOfMfg || raw.date_of_mfg || raw.mfgDate || attrs.dateOfMfg,
    manufacturer: mfg.manufacturer || raw.manufacturer || attrs.manufacturer,
    modelNumber: mfg.modelNumber || raw.modelNumber || raw.model_number || attrs.modelNumber,
    batchNumber: mfg.batchNumber || raw.batchNumber || raw.batch_number || attrs.batchNumber,
    firmwareVersion: raw.FirmwareVersion || fw.version || raw.firmwareVersion || raw.firmware_version || attrs.firmwareVersion,
    hardwareVersion: hw.version || raw.hardwareVersion || raw.hardware_version || attrs.hardwareVersion,
    macAddress: hw.macAddress || raw.macAddress || raw.mac_address || attrs.macAddress,
    imei: hw.imei || raw.imei || attrs.imei,
    sensors: raw.sensors !== undefined ? raw.sensors : attrs.sensors,
    components: raw.components !== undefined ? raw.components : attrs.components,
    runtimeConfig: raw.runtimeConfig || attrs.runtimeConfig,
    attributes: attrs,
    metadata: raw.metadata || {},
    raw,
  };
}

/**
 * Resolves optional associations to existing LCGate, MasterUnit, or ChildDevice
 */
async function resolveAssociations(client, serialNumber) {
  if (!serialNumber) return { gateId: null, masterId: null, childDeviceId: null };

  let gateId = null;
  let masterId = null;
  let childDeviceId = null;

  try {
    // 1. Check MasterUnit table
    const masterRes = await client.query(
      'SELECT id, "gateId" FROM "MasterUnit" WHERE "serialNumber" = $1 LIMIT 1',
      [serialNumber]
    );
    if (masterRes.rows.length > 0) {
      masterId = masterRes.rows[0].id;
      gateId = masterRes.rows[0].gateId;
    } else {
      // 2. Check ChildDevice table
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

    // 3. If gateId still null, try matching LC number prefix (e.g. LC-0001)
    if (!gateId && serialNumber.startsWith('LC-')) {
      const parts = serialNumber.split('-');
      if (parts.length >= 2) {
        const lcNumber = `${parts[0]}-${parts[1]}`;
        const gateRes = await client.query(
          'SELECT id FROM "LCGate" WHERE "lcNumber" = $1 LIMIT 1',
          [lcNumber]
        );
        if (gateRes.rows.length > 0) {
          gateId = gateRes.rows[0].id;
        }
      }
    }
  } catch (err) {
    console.warn('[ASSOCIATION LOOKUP WARNING]', err.message);
  }

  return { gateId, masterId, childDeviceId };
}

/**
 * Helper to safely parse JSON or object
 */
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
 * Main AWS Lambda Handler
 */
exports.handler = async (event, context) => {
  console.log('[DEVICE REGISTRATION EVENT RECEIVED]', JSON.stringify(event));

  // Check if this is an AWS IoT Thing Deletion event
  // Sources: $aws/events/thing/+/deleted, CloudTrail DeleteThing, or explicit eventType: 'deleted'
  const isDeletionEvent = 
    event.eventType === 'deleted' ||
    event.eventType === 'thingDeleted' ||
    (event.topic && event.topic.endsWith('/deleted')) ||
    (event.detail && event.detail.eventName === 'DeleteThing');

  if (isDeletionEvent) {
    const thingToDelete = 
      event.thingName || 
      (event.detail && event.detail.requestParameters && event.detail.requestParameters.thingName) ||
      (event.raw && event.raw.thingName);

    if (thingToDelete) {
      console.log(`[DELETING DEVICE FROM RDS VIA AWS IOT LIFECYCLE EVENT] thingName=${thingToDelete}`);
      const dbPool = getDbPool();
      const client = await dbPool.connect();
      try {
        await client.query('DELETE FROM "DeviceTelemetry" WHERE "thingName" = $1', [thingToDelete]);
        try {
          await client.query('DELETE FROM "ScopeGroupDevice" WHERE "thingName" = $1', [thingToDelete]);
        } catch (_) {}
        const deleteRes = await client.query('DELETE FROM "DeviceRegistry" WHERE "thingName" = $1 RETURNING id, "thingName"', [thingToDelete]);
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
        return {
          statusCode: 500,
          body: JSON.stringify({ error: err.message }),
        };
      } finally {
        client.release();
      }
    }
  }

  const topicStr = String(event.topic || (event.raw && event.raw.topic) || '');
  if (topicStr.includes('/health/request') || (event.action === 'HEALTH_CHECK' && event.action !== 'HEALTH_CHECK_RESPONSE')) {
    console.log('[IGNORING OUTBOUND HEALTH CHECK REQUEST TOPIC]', topicStr);
    return { statusCode: 200, body: JSON.stringify({ message: 'Ignored outbound command' }) };
  }

  const parsed = extractDevicePayload(event);
  let thingName = parsed.thingName;

  if (!thingName) {
    try {
      const dbPool = getDbPool();
      const client = await dbPool.connect();
      try {
        const fallbackRes = await client.query('SELECT "thingName" FROM "DeviceRegistry" WHERE "status" = \'ACTIVE\' ORDER BY "lastSeenAt" DESC NULLS LAST, "id" ASC LIMIT 1');
        if (fallbackRes.rows.length > 0) {
          thingName = fallbackRes.rows[0].thingName;
          console.log(`[RESOLVED THINGNAME FALLBACK] Using active device: ${thingName}`);
        }
      } finally {
        client.release();
      }
    } catch (e) {
      console.warn('[FALLBACK RESOLUTION ERROR]', e.message);
    }
  }

  if (!thingName) {
    console.error('[ERROR] Missing thingName in event payload and no active devices found in RDS');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing thingName in event payload' }),
    };
  }

  const attrs = parsed.attributes || {};

  // Resolve fields with attribute fallback
  const serialNumber = parsed.serialNumber || attrs.serialNumber || attrs.SerialNumber || thingName;
  const thingArn = parsed.thingArn || attrs.thingArn || null;
  const thingTypeName = parsed.thingTypeName || attrs.thingTypeName || null;
  const deviceType = parsed.deviceType || attrs.deviceType || attrs.DeviceType || (serialNumber.includes('-A') || serialNumber.includes('-B') ? 'SLAVE' : 'MASTER');
  const status = attrs.status || 'ACTIVE';
  const manufacturer = parsed.manufacturer || attrs.manufacturer || 'Mirtha / LC-Platform';
  const modelNumber = parsed.modelNumber || attrs.modelNumber || attrs.ModelNumber || 'LC-GATE-CONTROLLER';
  const batchNumber = parsed.batchNumber || attrs.batchNumber || null;
  const firmwareVersion = parsed.firmwareVersion || attrs.firmwareVersion || attrs.Firmware || 'v1.0.0';
  const hardwareVersion = parsed.hardwareVersion || attrs.hardwareVersion || 'rev1.0';
  const macAddress = parsed.macAddress || attrs.macAddress || null;
  const imei = parsed.imei || attrs.imei || null;

  // Date of Manufacturing
  let dateOfMfg = null;
  const rawMfg = parsed.dateOfMfg || attrs.dateOfMfg || attrs.DateOfMfg || attrs.mfgDate;
  if (rawMfg) {
    const d = new Date(rawMfg);
    if (!isNaN(d.getTime())) dateOfMfg = d.toISOString();
  }

  // Parse sensors metadata: strictly use what firmware provided, or default to empty array [] (no dummy placeholders)
  const sensors = safeJson(parsed.sensors !== undefined ? parsed.sensors : attrs.sensors, []);

  // Parse components metadata: strictly use what firmware provided, or default to empty array [] (no dummy placeholders)
  const components = safeJson(parsed.components !== undefined ? parsed.components : attrs.components, []);

  const attributesJson = safeJson(attrs, {});
  const metadataJson = safeJson(parsed.metadata, {
    registeredVia: 'AWS_IOT_DEVICE_LAMBDA',
    registeredAt: new Date().toISOString(),
    eventSource: event.eventType || 'AWS_IOT_RULE',
    runtimeConfig: parsed.runtimeConfig || null,
  });

  const dbPool = getDbPool();
  const client = await dbPool.connect();

  try {
    // Check associations with LC Gates & Units
    const { gateId, masterId, childDeviceId } = await resolveAssociations(client, serialNumber);

    console.log(`[UPSERTING DEVICE] thingName=${thingName}, serialNumber=${serialNumber}, gateId=${gateId}`);

    const upsertSql = `
      INSERT INTO "DeviceRegistry" (
        "thingName", "thingArn", "thingTypeName", "deviceType", "serialNumber",
        "status", "gateId", "masterId", "childDeviceId", "macAddress", "imei",
        "firmwareVersion", "hardwareVersion", "dateOfMfg", "manufacturer",
        "modelNumber", "batchNumber", "sensors", "components", "attributes",
        "metadata", "lastSeenAt", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, NOW(), NOW(), NOW()
      )
      ON CONFLICT ("thingName") DO UPDATE SET
        "thingArn" = COALESCE(EXCLUDED."thingArn", "DeviceRegistry"."thingArn"),
        "thingTypeName" = COALESCE(EXCLUDED."thingTypeName", "DeviceRegistry"."thingTypeName"),
        "deviceType" = EXCLUDED."deviceType",
        "serialNumber" = COALESCE(EXCLUDED."serialNumber", "DeviceRegistry"."serialNumber"),
        "status" = EXCLUDED."status",
        "gateId" = COALESCE(EXCLUDED."gateId", "DeviceRegistry"."gateId"),
        "masterId" = COALESCE(EXCLUDED."masterId", "DeviceRegistry"."masterId"),
        "childDeviceId" = COALESCE(EXCLUDED."childDeviceId", "DeviceRegistry"."childDeviceId"),
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
        "attributes" = COALESCE(EXCLUDED."attributes", "DeviceRegistry"."attributes"),
        "metadata" = COALESCE(EXCLUDED."metadata", "DeviceRegistry"."metadata"),
        "lastSeenAt" = NOW(),
        "updatedAt" = NOW()
      RETURNING *;
    `;

    const values = [
      thingName,
      thingArn,
      thingTypeName,
      deviceType,
      serialNumber,
      status,
      gateId,
      masterId,
      childDeviceId,
      macAddress,
      imei,
      firmwareVersion,
      hardwareVersion,
      dateOfMfg,
      manufacturer,
      modelNumber,
      batchNumber,
      JSON.stringify(sensors),
      JSON.stringify(components),
      JSON.stringify(attributesJson),
      JSON.stringify(metadataJson),
    ];

    const result = await client.query(upsertSql, values);
    const savedRecord = result.rows[0];

    // Also record into appropriate table (DeviceHealthCheck vs DeviceTelemetry)
    const topicStrReport = String(event.topic || parsed.raw?.topic || '');
    const isHealthReport = 
      (topicStrReport.includes('/health') && !topicStrReport.includes('/request')) ||
      parsed.raw?.action === 'HEALTH_CHECK_RESPONSE' ||
      (parsed.raw?.healthstatus !== undefined && parsed.raw?.action !== 'HEALTH_CHECK');

    if (isHealthReport) {
      try {
        const raw = parsed.raw || event;
        const resolvedGateStatus = raw.Status || (raw.LimitSwitchClosed !== undefined ? (raw.LimitSwitchClosed ? 'CLOSED' : 'NOT_CLOSED') : 'NOT_CLOSED');
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
          raw.SignalStrength !== undefined && raw.SignalStrength !== null ? parseInt(raw.SignalStrength) : null,
          raw.NetworkType || '4G_LTE',
          raw.LimitSwitchClosed !== undefined && raw.LimitSwitchClosed !== null ? Boolean(raw.LimitSwitchClosed) : null,
          raw.HallClosed !== undefined && raw.HallClosed !== null ? Boolean(raw.HallClosed) : null,
          raw.BatteryVoltage !== undefined && raw.BatteryVoltage !== null ? parseFloat(raw.BatteryVoltage) : null,
          raw.BatteryPercentage !== undefined && raw.BatteryPercentage !== null ? parseInt(raw.BatteryPercentage) : null,
          raw.SolarVoltage !== undefined && raw.SolarVoltage !== null ? parseFloat(raw.SolarVoltage) : null,
          raw.SolarCharging !== undefined && raw.SolarCharging !== null ? Boolean(raw.SolarCharging) : null,
          raw.UptimeSeconds !== undefined && raw.UptimeSeconds !== null ? parseInt(raw.UptimeSeconds) : null,
          raw.FirmwareVersion || '1.0.6',
          JSON.stringify(raw),
          savedRecord.id
        ]);
        console.log(`[SUCCESS] Recorded health diagnostic in DeviceHealthCheck for thing=${thingName}`);
      } catch (hcErr) {
        console.warn('[HEALTH CHECK INSERT WARNING]', hcErr.message);
      }
    } else {
      // Regular Telemetry: strictly gate state telemetry
      const telemetryTopic = event.topic || parsed.raw?.topic || (parsed.raw?.topicThingName ? `lc/devices/${parsed.raw.topicThingName}/manifest` : `lc-gate/${thingName}/telemetry`);
      const teleStatus = parsed.raw?.Status || 'NOT_CLOSED';

      try {
        await client.query(`
          INSERT INTO "DeviceTelemetry" ("thingName", "topic", "payload", "status", "deviceRegistryId", "receivedAt")
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
          thingName,
          telemetryTopic,
          JSON.stringify(parsed.raw || event),
          teleStatus,
          savedRecord.id
        ]);
        console.log(`[SUCCESS] Recorded historic telemetry for thing=${thingName} (topic=${telemetryTopic}, status=${teleStatus})`);
      } catch (telErr) {
        console.warn('[TELEMETRY INSERT WARNING]', telErr.message);
      }
    }

    console.log(`[SUCCESS] Registered device ID=${savedRecord.id} in RDS for thing=${thingName}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Device successfully registered in LC-Platform RDS device registry',
        device: savedRecord,
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
