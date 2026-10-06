const db = require('../config/db');
const { ValidationError } = require('../utils/errors');

class ScopeResolutionService {
  
  /**
   * Checks if adding childGroupId to parentGroupId would create a cycle.
   */
  async checkCycle(parentGroupId, childGroupId) {
    if (parentGroupId === childGroupId) {
      throw new ValidationError('A scope group cannot contain itself.');
    }
    
    // We need to recursively check if childGroupId contains parentGroupId
    const queue = [childGroupId];
    const visited = new Set();
    
    while (queue.length > 0) {
      const currentId = queue.shift();
      
      if (currentId === parentGroupId) {
        throw new ValidationError('Cycle detected: The target scope group already contains the parent group indirectly.');
      }
      
      if (!visited.has(currentId)) {
        visited.add(currentId);
        
        // Find all scope groups that 'currentId' contains
        const res = await db.query(
          `SELECT member_scope_group_id FROM scope_group_members WHERE scope_group_id = $1 AND member_type = 'SCOPE_GROUP'`,
          [currentId]
        );
        
        for (const row of res.rows) {
          queue.push(row.member_scope_group_id);
        }
      }
    }
  }

  /**
   * Rebuilds the flattened clusters for a given scope group.
   * Should be called whenever a scope group's members change.
   */
  async rebuildFlattenedScope(scopeGroupId) {
    // Collect all unique cluster IDs recursively
    const clusterIds = new Set();
    const queue = [scopeGroupId];
    const visitedGroups = new Set();
    
    while (queue.length > 0) {
      const currentGroupId = queue.shift();
      
      if (!visitedGroups.has(currentGroupId)) {
        visitedGroups.add(currentGroupId);
        
        const res = await db.query(
          `SELECT member_type, member_cluster_id, member_scope_group_id 
           FROM scope_group_members 
           WHERE scope_group_id = $1`,
          [currentGroupId]
        );
        
        for (const row of res.rows) {
          if (row.member_type === 'CLUSTER' && row.member_cluster_id) {
            clusterIds.add(row.member_cluster_id);
          } else if (row.member_type === 'SCOPE_GROUP' && row.member_scope_group_id) {
            queue.push(row.member_scope_group_id);
          }
        }
      }
    }
    
    // Update the scope_group_clusters_flat table transactionally
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Delete old flat entries
      await client.query(`DELETE FROM scope_group_clusters_flat WHERE scope_group_id = $1`, [scopeGroupId]);
      
      // Insert new flat entries
      for (const cid of clusterIds) {
        await client.query(
          `INSERT INTO scope_group_clusters_flat (scope_group_id, cluster_id) VALUES ($1, $2)`,
          [scopeGroupId, cid]
        );
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cascade rebuild for all groups that contain the modified group.
   * Very important to keep parent groups updated when a child group changes.
   */
  async cascadeRebuild(modifiedGroupId) {
    // Find all parents of this group, recursively rebuild them bottom-up or just trigger rebuild
    const parents = new Set();
    const queue = [modifiedGroupId];
    const visited = new Set();
    
    while (queue.length > 0) {
      const current = queue.shift();
      if (!visited.has(current)) {
        visited.add(current);
        const res = await db.query(
          `SELECT scope_group_id FROM scope_group_members WHERE member_type = 'SCOPE_GROUP' AND member_scope_group_id = $1`,
          [current]
        );
        for (const row of res.rows) {
          parents.add(row.scope_group_id);
          queue.push(row.scope_group_id);
        }
      }
    }
    
    // Rebuild all affected parents
    for (const parentId of parents) {
      await this.rebuildFlattenedScope(parentId);
    }
  }

  async addMember(scopeGroupId, memberType, memberClusterId = null, memberScopeGroupId = null) {
    if (memberType === 'SCOPE_GROUP') {
      await this.checkCycle(scopeGroupId, memberScopeGroupId);
    }

    await db.query(
      `INSERT INTO scope_group_members (scope_group_id, member_type, member_cluster_id, member_scope_group_id)
       VALUES ($1, $2, $3, $4)`,
      [scopeGroupId, memberType, memberClusterId, memberScopeGroupId]
    );

    // Rebuild self and cascade to parents
    await this.rebuildFlattenedScope(scopeGroupId);
    await this.cascadeRebuild(scopeGroupId);
  }
}

module.exports = new ScopeResolutionService();
