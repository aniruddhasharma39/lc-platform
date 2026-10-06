const db = require('./src/config/db');
const bcrypt = require('bcrypt');

async function resetAdmin() {
  const hash = await bcrypt.hash('Admin@123', 10);
  await db.query(`UPDATE users SET password_hash = $1, failed_login_attempts = 0, status = 'ACTIVE' WHERE email = 'admin@lcplatform.com'`, [hash]);
  console.log('Password reset successfully');
  await db.pool.end();
}

resetAdmin().catch(console.error);
