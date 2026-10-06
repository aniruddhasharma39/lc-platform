const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const db = require('../config/db');
const AccessResolver = require('../rbac/AccessResolver'); // We will build this next

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid token');
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user is still active
    const userResult = await db.query('SELECT id, status, must_change_password FROM users WHERE id = $1', [decoded.userId]);
    if (userResult.rows.length === 0) {
      throw new UnauthorizedError('User no longer exists');
    }
    
    const user = userResult.rows[0];
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('User account is not active');
    }
    
    // Check for must_change_password except for password change route
    if (user.must_change_password && !req.path.includes('/password/change')) {
        throw new ForbiddenError('MUST_CHANGE_PASSWORD');
    }

    req.user = user;
    
    // Resolve effective access for the user and attach to request for quick checks
    const effectiveAccess = await AccessResolver.resolveUserAccess(user.id);
    req.effectiveAccess = effectiveAccess; // { permissions: Set, clusters: Set }

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      next(new UnauthorizedError('Token expired'));
    } else {
      next(error);
    }
  }
};

const authorize = (permission) => {
  return (req, res, next) => {
    try {
      if (!req.effectiveAccess || !req.effectiveAccess.permissions.has(permission)) {
        throw new ForbiddenError(`Missing required permission: ${permission}`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};

const scopeGuard = (clusterIdParamName = 'clusterId') => {
  return (req, res, next) => {
    try {
      const clusterId = parseInt(req.params[clusterIdParamName] || req.body[clusterIdParamName], 10);
      if (!clusterId) {
        throw new Error('Cluster ID not provided in request');
      }

      // If user has global scope (represented by a special flag or just containing all), they might pass.
      // We check if clusterId is in their resolved clusters
      if (!req.effectiveAccess.clusters.has(clusterId)) {
        throw new ForbiddenError(`Access denied to cluster: ${clusterId}`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = {
  authenticate,
  authorize,
  scopeGuard,
};
