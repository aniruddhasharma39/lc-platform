const authService = require('./AuthService');
const { successResponse } = require('../utils/responseFormatter');

class AuthController {
  async login(req, res, next) {
    try {
      const { email, password } = req.body;
      const data = await authService.login(email, password);
      return successResponse(res, data);
    } catch (error) {
      next(error);
    }
  }

  async refreshToken(req, res, next) {
    try {
      const { token } = req.body;
      const data = await authService.refreshToken(token);
      return successResponse(res, data);
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req, res, next) {
    try {
      const { oldPassword, newPassword } = req.body;
      await authService.changePassword(req.user.id, oldPassword, newPassword);
      return successResponse(res, { message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      await authService.logout(req.user.id);
      return successResponse(res, { message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }

  async getMeConfig(req, res, next) {
    try {
      // req.effectiveAccess is injected by authenticate middleware
      const { permissions, clusters } = req.effectiveAccess;
      
      const config = {
        user: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          status: req.user.status,
          must_change_password: req.user.must_change_password
        },
        permissions: Array.from(permissions),
        clusters: Array.from(clusters),
        menus: [], // To be populated dynamically based on permissions
        featureFlags: {} // To be extended in future modules
      };
      
      // Simple dynamic menu builder
      if (permissions.has('users:view') || permissions.has('roles:view')) {
        config.menus.push({ label: 'User Management', path: '/users' });
      }
      if (permissions.has('clusters:view')) {
        config.menus.push({ label: 'Clusters', path: '/clusters' });
      }
      
      return successResponse(res, config);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
