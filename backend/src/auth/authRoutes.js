const express = require('express');
const router = express.Router();
const authController = require('./AuthController');
const { authenticate } = require('../middlewares/auth');

router.post('/login', authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/password/change', authenticate, authController.changePassword);
router.post('/logout', authenticate, authController.logout);
router.get('/me/config', authenticate, authController.getMeConfig);

module.exports = router;
