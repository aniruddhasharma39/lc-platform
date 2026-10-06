
class ProvisioningProvider {
  async registerDevice(deviceData) { throw new Error('Not implemented'); }
  async provisionDevice(deviceId) { throw new Error('Not implemented'); }
  async generateCertificate(deviceId) { throw new Error('Not implemented'); }
  async revokeCertificate(deviceId) { throw new Error('Not implemented'); }
  async decommissionDevice(deviceId) { throw new Error('Not implemented'); }
}
module.exports = ProvisioningProvider;
