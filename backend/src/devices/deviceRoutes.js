
const express = require('express');
const router = express.Router();
const controller = require('./DeviceController');
const { authorize } = require('../middlewares/auth');

router.get('/', authorize('devices:view'), controller.getAll);
router.get('/:id', authorize('devices:view'), controller.getById);
router.post('/', authorize('devices:create'), controller.create);
router.post('/:id/activate', authorize('devices:activate'), controller.activate);
router.post('/:id/retire', authorize('devices:retire'), controller.retire);
router.post('/:id/generate-certificate', authorize('devices:certificate'), controller.generateCertificate);
router.get('/:id/events', authorize('devices:view'), controller.getEvents);

module.exports = router;
