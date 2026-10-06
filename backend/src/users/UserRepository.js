const db = require('../config/db');

class UserRepository {
  async findByEmail(email) {
    const res = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return res.rows[0];
  }
  
  async findById(id) {
    const res = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0];
  }
  
  async create(userData) {
    const { name, mobile, email, employee_id, password_hash, status, must_change_password } = userData;
    const res = await db.query(
      `INSERT INTO users (name, mobile, email, employee_id, password_hash, status, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, mobile, email, employee_id, password_hash, status, must_change_password]
    );
    return res.rows[0];
  }
  
  async update(id, updates) {
    // Basic dynamic update query builder
    const keys = Object.keys(updates);
    if (keys.length === 0) return this.findById(id);
    
    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    const values = keys.map(key => updates[key]);
    
    const res = await db.query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return res.rows[0];
  }
}

module.exports = new UserRepository();
