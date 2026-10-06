
const db = require('../config/db');
class DeviceRepository {
  async findAll() {
    const res = await db.query('SELECT * FROM master_devices ORDER BY created_at DESC');
    return res.rows;
  }
  async findById(id) {
    const res = await db.query('SELECT * FROM master_devices WHERE id = $1', [id]);
    return res.rows[0];
  }
  async create(data) {
    const res = await db.query(`
      INSERT INTO master_devices (factory_device_id, thing_name, status, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *
    `, [data.factory_device_id, data.thing_name, data.status || 'CREATED']);
    return res.rows[0];
  }
  async updateStatus(id, status) {
    const res = await db.query('UPDATE master_devices SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, id]);
    return res.rows[0];
  }
  async delete(id) {
    await db.query('DELETE FROM master_devices WHERE id = $1', [id]);
  }
}
module.exports = new DeviceRepository();
