const db = require('../config/db');

class AccessResolver {
  
  /**
   * Resolves effective access for a user.
   * Returns { permissions: Set<string>, clusters: Set<number> }
   */
  async resolveUserAccess(userId) {
    const permissions = new Set();
    const clusters = new Set();
    
    // 1. Find all active assignments for the user
    const assignmentsRes = await db.query(
      `SELECT role_id, scope_group_id FROM user_assignments WHERE user_id = $1 AND is_active = true`,
      [userId]
    );
    
    if (assignmentsRes.rows.length === 0) {
      return { permissions, clusters };
    }
    
    const roleIds = assignmentsRes.rows.map(a => a.role_id);
    const scopeGroupIds = assignmentsRes.rows.map(a => a.scope_group_id);
    
    // 2. Union of all permissions across all roles
    if (roleIds.length > 0) {
      const permsRes = await db.query(`
        SELECT p.name 
        FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = ANY($1::int[])
      `, [roleIds]);
      
      permsRes.rows.forEach(row => permissions.add(row.name));
    }
    
    // 3. Union of all clusters across all scope groups
    if (scopeGroupIds.length > 0) {
      const clustersRes = await db.query(`
        SELECT cluster_id 
        FROM scope_group_clusters_flat
        WHERE scope_group_id = ANY($1::int[])
      `, [scopeGroupIds]);
      
      clustersRes.rows.forEach(row => clusters.add(row.cluster_id));
    }
    
    return { permissions, clusters };
  }
}

module.exports = new AccessResolver();
