const fs = require('fs');
const path = require('path');

const backendSrc = path.join(__dirname, 'backend', 'src');
const devicesPath = path.join(backendSrc, 'devices');
const providersPath = path.join(backendSrc, 'providers');
const simulatorPath = path.join(__dirname, 'simulator');

[devicesPath, providersPath, simulatorPath].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Providers
fs.writeFileSync(path.join(providersPath, 'ProvisioningProvider.js'), `
class ProvisioningProvider {
  async registerDevice(deviceData) { throw new Error('Not implemented'); }
  async provisionDevice(deviceId) { throw new Error('Not implemented'); }
  async generateCertificate(deviceId) { throw new Error('Not implemented'); }
  async revokeCertificate(deviceId) { throw new Error('Not implemented'); }
  async decommissionDevice(deviceId) { throw new Error('Not implemented'); }
}
module.exports = ProvisioningProvider;
`);

fs.writeFileSync(path.join(providersPath, 'SimulationProvisioningProvider.js'), `
const ProvisioningProvider = require('./ProvisioningProvider');
class SimulationProvisioningProvider extends ProvisioningProvider {
  async registerDevice(deviceData) { return { status: 'REGISTERED' }; }
  async provisionDevice(deviceId) { return { status: 'PROVISIONED' }; }
  async generateCertificate(deviceId) { return { cert: 'SIM_CERT', status: 'GENERATED' }; }
  async revokeCertificate(deviceId) { return { status: 'REVOKED' }; }
  async decommissionDevice(deviceId) { return { status: 'RETIRED' }; }
}
module.exports = SimulationProvisioningProvider;
`);

fs.writeFileSync(path.join(providersPath, 'AwsProvisioningProvider.js'), `
const ProvisioningProvider = require('./ProvisioningProvider');
class AwsProvisioningProvider extends ProvisioningProvider {
  // Stubbed for future AWS implementation
}
module.exports = AwsProvisioningProvider;
`);

// Device Domain
fs.writeFileSync(path.join(devicesPath, 'DeviceEventService.js'), `
const db = require('../config/db');
class DeviceEventService {
  async logEvent(deviceId, eventType, actor, payload = {}) {
    await db.query(\`
      INSERT INTO device_events (device_id, event_type, event_source, payload)
      VALUES ($1, $2, $3, $4)
    \`, [deviceId, eventType, actor, JSON.stringify(payload)]);
  }
  async getEvents(deviceId) {
    const res = await db.query('SELECT * FROM device_events WHERE device_id = $1 ORDER BY created_at DESC', [deviceId]);
    return res.rows;
  }
}
module.exports = new DeviceEventService();
`);

fs.writeFileSync(path.join(devicesPath, 'DeviceRepository.js'), `
const db = require('../config/db');
class DeviceRepository {
  async findAll() {
    const res = await db.query('SELECT * FROM master_devices ORDER BY created_at DESC');
    return res.rows;
  }
  async findById(id) {
    const res = await db.query('SELECT * FROM master_devices WHERE id = $1', [id]);
    return res.rows[0];
  }
  async create(data) {
    const res = await db.query(\`
      INSERT INTO master_devices (factory_device_id, thing_name, status, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *
    \`, [data.factory_device_id, data.thing_name, data.status || 'CREATED']);
    return res.rows[0];
  }
  async updateStatus(id, status) {
    const res = await db.query('UPDATE master_devices SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, id]);
    return res.rows[0];
  }
  async delete(id) {
    await db.query('DELETE FROM master_devices WHERE id = $1', [id]);
  }
}
module.exports = new DeviceRepository();
`);

fs.writeFileSync(path.join(devicesPath, 'DeviceService.js'), `
const repository = require('./DeviceRepository');
const eventService = require('./DeviceEventService');
const SimulationProvider = require('../providers/SimulationProvisioningProvider');
const provider = new SimulationProvider(); // Currently using simulation

class DeviceService {
  async getAllDevices() { return await repository.findAll(); }
  async getDeviceById(id) { return await repository.findById(id); }
  
  async createDevice(data, actor) {
    const device = await repository.create(data);
    await eventService.logEvent(device.id, 'DEVICE_CREATED', actor, data);
    return device;
  }
  
  async activateDevice(id, actor) {
    const device = await repository.updateStatus(id, 'ACTIVE');
    await eventService.logEvent(id, 'DEVICE_ACTIVATED', actor);
    return device;
  }

  async retireDevice(id, actor) {
    const device = await repository.updateStatus(id, 'RETIRED');
    await eventService.logEvent(id, 'DEVICE_RETIRED', actor);
    await provider.decommissionDevice(id);
    return device;
  }
  
  async generateCertificate(id, actor) {
    const cert = await provider.generateCertificate(id);
    await eventService.logEvent(id, 'CERTIFICATE_GENERATED', actor, cert);
    return cert;
  }
}
module.exports = new DeviceService();
`);

fs.writeFileSync(path.join(devicesPath, 'DeviceController.js'), `
const service = require('./DeviceService');
const eventService = require('./DeviceEventService');

class DeviceController {
  async getAll(req, res, next) {
    try { res.json({ success: true, data: await service.getAllDevices() }); } catch (err) { next(err); }
  }
  async getById(req, res, next) {
    try { res.json({ success: true, data: await service.getDeviceById(req.params.id) }); } catch (err) { next(err); }
  }
  async create(req, res, next) {
    try { res.json({ success: true, data: await service.createDevice(req.body, req.user ? req.user.email : 'system') }); } catch (err) { next(err); }
  }
  async activate(req, res, next) {
    try { res.json({ success: true, data: await service.activateDevice(req.params.id, req.user ? req.user.email : 'system') }); } catch (err) { next(err); }
  }
  async retire(req, res, next) {
    try { res.json({ success: true, data: await service.retireDevice(req.params.id, req.user ? req.user.email : 'system') }); } catch (err) { next(err); }
  }
  async generateCertificate(req, res, next) {
    try { res.json({ success: true, data: await service.generateCertificate(req.params.id, req.user ? req.user.email : 'system') }); } catch (err) { next(err); }
  }
  async getEvents(req, res, next) {
    try { res.json({ success: true, data: await eventService.getEvents(req.params.id) }); } catch (err) { next(err); }
  }
}
module.exports = new DeviceController();
`);

fs.writeFileSync(path.join(devicesPath, 'deviceRoutes.js'), `
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
`);

console.log('Backend device domain generated successfully.');
