
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
