
const ProvisioningProvider = require('./ProvisioningProvider');
class SimulationProvisioningProvider extends ProvisioningProvider {
  async registerDevice(deviceData) { return { status: 'REGISTERED' }; }
  async provisionDevice(deviceId) { return { status: 'PROVISIONED' }; }
  async generateCertificate(deviceId) { return { cert: 'SIM_CERT', status: 'GENERATED' }; }
  async revokeCertificate(deviceId) { return { status: 'REVOKED' }; }
  async decommissionDevice(deviceId) { return { status: 'RETIRED' }; }
}
module.exports = SimulationProvisioningProvider;
