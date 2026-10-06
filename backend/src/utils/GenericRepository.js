const db = require('../config/db');
const { NotFoundError } = require('../utils/errors');

class GenericRepository {
  constructor(tableName) {
    this.tableName = tableName;
  }

  async findAll() {
    const res = await db.query(`SELECT * FROM ${this.tableName} ORDER BY id ASC`);
    return res.rows;
  }

  async findById(id) {
    const res = await db.query(`SELECT * FROM ${this.tableName} WHERE id = $1`, [id]);
    if (res.rows.length === 0) throw new NotFoundError(`${this.tableName} not found`);
    return res.rows[0];
  }

  async create(data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    
    const res = await db.query(
      `INSERT INTO ${this.tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return res.rows[0];
  }

  async update(id, data) {
    const keys = Object.keys(data);
    if (keys.length === 0) return this.findById(id);
    
    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map(key => data[key]);
    
    const res = await db.query(
      `UPDATE ${this.tableName} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    if (res.rows.length === 0) throw new NotFoundError(`${this.tableName} not found`);
    return res.rows[0];
  }

  async delete(id) {
    const res = await db.query(`DELETE FROM ${this.tableName} WHERE id = $1 RETURNING *`, [id]);
    if (res.rows.length === 0) throw new NotFoundError(`${this.tableName} not found`);
    return res.rows[0];
  }
}

module.exports = GenericRepository;
