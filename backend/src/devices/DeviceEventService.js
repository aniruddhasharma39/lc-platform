
const db = require('../config/db');
class DeviceEventService {
  async logEvent(deviceId, eventType, actor, payload = {}) {
    await db.query(`
      INSERT INTO device_events (device_id, event_type, event_source, payload)
      VALUES ($1, $2, $3, $4)
    `, [deviceId, eventType, actor, JSON.stringify(payload)]);
  }
  async getEvents(deviceId) {
    const res = await db.query('SELECT * FROM device_events WHERE device_id = $1 ORDER BY created_at DESC', [deviceId]);
    return res.rows;
  }
}
module.exports = new DeviceEventService();
