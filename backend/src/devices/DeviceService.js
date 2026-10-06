
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
