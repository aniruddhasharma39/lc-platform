require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const defaultPermissions = [
  'users:view', 'users:create', 'users:update', 'users:delete',
  'roles:view', 'roles:create', 'roles:update', 'roles:delete',
  'scope_groups:view', 'scope_groups:create', 'scope_groups:update', 'scope_groups:delete',
  'clusters:view', 'clusters:create', 'clusters:update', 'clusters:delete',
  'masterdata:view', 'masterdata:create', 'masterdata:update', 'masterdata:delete',
  'alerts:view', 'alerts:acknowledge',
  'reports:view', 'reports:export'
];

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Seeding permissions...');
    for (const perm of defaultPermissions) {
      await client.query(`
        INSERT INTO permissions (name, description) 
        VALUES ($1, $2)
        ON CONFLICT (name) DO NOTHING
      `, [perm, `Allows ${perm}`]);
    }

    console.log('Seeding superadmin role...');
    const roleRes = await client.query(`
      INSERT INTO roles (name, description) 
      VALUES ('Super Admin', 'Has all permissions')
      ON CONFLICT (name) DO UPDATE SET description = 'Has all permissions'
      RETURNING id
    `);
    const adminRoleId = roleRes.rows[0].id;

    console.log('Assigning all permissions to Super Admin role...');
    const permsRes = await client.query('SELECT id FROM permissions');
    for (const perm of permsRes.rows) {
      await client.query(`
        INSERT INTO role_permissions (role_id, permission_id) 
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [adminRoleId, perm.id]);
    }

    console.log('Seeding global scope group (all clusters)...');
    const scopeRes = await client.query(`
      INSERT INTO scope_groups (name, description) 
      VALUES ('Global Scope', 'Contains all clusters globally')
      ON CONFLICT (name) DO UPDATE SET description = 'Contains all clusters globally'
      RETURNING id
    `);
    const globalScopeId = scopeRes.rows[0].id;

    console.log('Seeding default super admin user...');
    const hash = await bcrypt.hash('Admin@123', 10);
    const userRes = await client.query(`
      INSERT INTO users (name, email, employee_id, password_hash, status, must_change_password)
      VALUES ('Admin User', 'admin@lcplatform.com', 'EMP001', $1, 'ACTIVE', false)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, [hash]);
    
    let adminUserId;
    if (userRes.rows.length > 0) {
      adminUserId = userRes.rows[0].id;
    } else {
      const existingUser = await client.query(`SELECT id FROM users WHERE email = 'admin@lcplatform.com'`);
      adminUserId = existingUser.rows[0].id;
    }

    console.log('Assigning Super Admin role and Global Scope to admin user...');
    await client.query(`
      INSERT INTO user_assignments (user_id, role_id, scope_group_id, is_active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT DO NOTHING
    `, [adminUserId, adminRoleId, globalScopeId]);

    await client.query('COMMIT');
    console.log('Seeding completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error seeding data:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runSeed();
