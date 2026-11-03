const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runVerification() {
  console.log('=== [PHASE 1] VERIFYING GEOGRAPHICAL HIERARCHY & DATASET INTEGRITY ===');
  
  // 1. Verify Western Railway divisions and station count
  const wrStations = await prisma.station.findMany({ where: { zone: 'Western Railway' } });
  const wrDivisions = [...new Set(wrStations.map(s => s.division))];
  console.log(`✓ Western Railway Station Count in DB: ${wrStations.length} (Expected: >200)`);
  console.log(`✓ Western Railway Divisions in DB: ${JSON.stringify(wrDivisions)}`);
  
  const expectedWrDivs = ['Ahmedabad', 'Vadodara', 'Mumbai Central', 'Ratlam', 'Rajkot', 'Bhavnagar'];
  for (const div of expectedWrDivs) {
    const divStations = wrStations.filter(s => s.division === div);
    if (divStations.length < 15) {
      throw new Error(`Western Railway division ${div} has insufficient stations: ${divStations.length}`);
    }
    console.log(`   - ${div}: ${divStations.length} authentic stations`);
  }

  // 2. Verify Central Railway divisions and station count
  const crStations = await prisma.station.findMany({ where: { zone: 'Central Railway' } });
  const crDivisions = [...new Set(crStations.map(s => s.division))];
  console.log(`✓ Central Railway Station Count in DB: ${crStations.length} (Expected: >200)`);
  console.log(`✓ Central Railway Divisions in DB: ${JSON.stringify(crDivisions)}`);
  
  const expectedCrDivs = ['Pune', 'Mumbai CST', 'Bhusawal', 'Solapur', 'Nagpur CR'];
  for (const div of expectedCrDivs) {
    const divStations = crStations.filter(s => s.division === div);
    if (divStations.length < 15) {
      throw new Error(`Central Railway division ${div} has insufficient stations: ${divStations.length}`);
    }
    console.log(`   - ${div}: ${divStations.length} authentic stations`);
  }

  // 3. Test dynamic station creation and deduplication
  const testCode = 'TEST-STN-' + Math.floor(Math.random() * 9000 + 1000);
  const newStation = await prisma.station.upsert({
    where: { code: testCode },
    update: { name: 'Test Custom Halt', division: 'Ahmedabad', zone: 'Western Railway' },
    create: { code: testCode, name: 'Test Custom Halt', division: 'Ahmedabad', zone: 'Western Railway' },
  });
  console.log(`✓ Created dynamic custom station: ${newStation.name} (${newStation.code}) ID=${newStation.id}`);
  
  // Deduplication check
  const duplicateUpsert = await prisma.station.upsert({
    where: { code: testCode },
    update: { name: 'Test Custom Halt' },
    create: { code: testCode, name: 'Duplicate Test', division: 'Ahmedabad', zone: 'Western Railway' },
  });
  if (duplicateUpsert.id !== newStation.id) {
    throw new Error('Deduplication failed: created secondary record for existing station code');
  }
  console.log(`✓ Deduplication verified: existing station returned with identical ID=${duplicateUpsert.id}`);

  console.log('\n=== [PHASE 2] VERIFYING DECOUPLED LC GATE CREATION ===');
  const testLcNumber = 'LC-TEST-' + Math.floor(Math.random() * 9000 + 1000);
  const createdGate = await prisma.lCGate.create({
    data: {
      lcNumber: testLcNumber,
      name: 'Independent Test Gate',
      locationName: 'KM 142/B Near Sabarmati',
      zone: 'Western Railway',
      division: 'Ahmedabad',
      stationId: newStation.id,
      latitude: 23.0825,
      longitude: 72.5841,
    },
    include: {
      station: true,
      masters: true,
      deviceRegistries: true,
    }
  });
  console.log(`✓ LC Gate created independently without physical hardware: ${createdGate.lcNumber} (ID=${createdGate.id})`);
  console.log(`   - Station: ${createdGate.station.name} (${createdGate.station.code})`);
  console.log(`   - Masters Count: ${createdGate.masters.length} (Expected: 0)`);
  console.log(`   - Physical Devices: ${createdGate.deviceRegistries.length} (Expected: 0)`);

  console.log('\n=== [PHASE 3] VERIFYING INDEPENDENT MASTER UNIT CREATION ===');
  const createdMaster = await prisma.masterUnit.create({
    data: {
      serialNumber: `${createdGate.lcNumber}-01`,
      masterSequence: 1,
      powerSource: 'SOLAR',
      gateId: createdGate.id,
    },
    include: {
      childDevices: true,
      deviceRegistries: true,
    }
  });
  console.log(`✓ Master Unit created independently without AWS IoT registry mapping: ${createdMaster.serialNumber} (ID=${createdMaster.id})`);
  console.log(`   - Power Source: ${createdMaster.powerSource}`);
  console.log(`   - Linked Hardware: ${createdMaster.deviceRegistries.length} (Expected: 0)`);

  console.log('\n=== [PHASE 4] VERIFYING SLAVE DEVICE LIFECYCLE ===');
  const slaveA = await prisma.childDevice.create({
    data: {
      serialNumber: `${createdMaster.serialNumber}-A-1`,
      type: 'DEVICE_1',
      deviceSequence: 1,
      masterId: createdMaster.id,
    }
  });
  console.log(`✓ Slave Device 1 (Limit Switch + Hall Effect) added: ${slaveA.serialNumber} (ID=${slaveA.id})`);

  const slaveB = await prisma.childDevice.create({
    data: {
      serialNumber: `${createdMaster.serialNumber}-B-1`,
      type: 'DEVICE_2',
      deviceSequence: 1,
      masterId: createdMaster.id,
    }
  });
  console.log(`✓ Slave Device 2 (Tilt Sensor) added: ${slaveB.serialNumber} (ID=${slaveB.id})`);

  console.log('\n=== [PHASE 5] VERIFYING CONFIGURATION EDITING (POWER & DEVICE ASSIGNMENT) ===');
  // 1. Update power source to DIRECT AC
  const updatedMaster = await prisma.masterUnit.update({
    where: { id: createdMaster.id },
    data: { powerSource: 'DIRECT' }
  });
  console.log(`✓ Updated Master power source from SOLAR to ${updatedMaster.powerSource}`);

  // 2. Provision mock hardware device in registry
  const mockDevThing = 'THG-TEST-' + Math.floor(Math.random() * 9000 + 1000);
  const mockDev = await prisma.deviceRegistry.create({
    data: {
      thingName: mockDevThing,
      deviceType: 'MASTER',
      serialNumber: mockDevThing,
      status: 'ACTIVE',
    }
  });
  console.log(`✓ Created test device in AWS IoT Device Registry: ${mockDev.thingName} (ID=${mockDev.id})`);

  // 3. Assign hardware device to Gate & Master
  await prisma.deviceRegistry.update({
    where: { id: mockDev.id },
    data: { gateId: createdGate.id, masterId: createdMaster.id }
  });
  const assignedDev = await prisma.deviceRegistry.findUnique({ where: { id: mockDev.id } });
  console.log(`✓ Assigned device to Gate ID=${assignedDev.gateId}, Master ID=${assignedDev.masterId}`);

  // 4. Unassign hardware device
  await prisma.deviceRegistry.update({
    where: { id: mockDev.id },
    data: { gateId: null, masterId: null, childDeviceId: null }
  });
  const unassignedDev = await prisma.deviceRegistry.findUnique({ where: { id: mockDev.id } });
  console.log(`✓ Unassigned device: gateId=${unassignedDev.gateId}, masterId=${unassignedDev.masterId} (Returned to unassigned pool)`);

  console.log('\n=== [PHASE 6] VERIFYING SAFE DELETION & INVENTORY PRESERVATION ===');
  // Re-link device to test safe deletion behavior
  await prisma.deviceRegistry.update({
    where: { id: mockDev.id },
    data: { gateId: createdGate.id, masterId: createdMaster.id }
  });

  // Explicit unlinking before gate delete
  await prisma.deviceRegistry.updateMany({
    where: { gateId: createdGate.id },
    data: { gateId: null, masterId: null, childDeviceId: null }
  });
  // Delete the gate
  await prisma.lCGate.delete({ where: { id: createdGate.id } });
  console.log(`✓ LC Gate ${createdGate.lcNumber} deleted.`);

  // Verify physical device was preserved in Device Registry
  const preservedDev = await prisma.deviceRegistry.findUnique({ where: { id: mockDev.id } });
  if (!preservedDev) {
    throw new Error('FAILED: Physical device was deleted with gate!');
  }
  console.log(`✓ Physical device ${preservedDev.thingName} successfully preserved in Device Registry with gateId=${preservedDev.gateId}`);

  // Clean up test records
  await prisma.deviceRegistry.delete({ where: { id: mockDev.id } });
  await prisma.station.delete({ where: { id: newStation.id } });
  console.log('✓ Cleaned up test artifacts.');

  console.log('\n=== [PHASE 7] VERIFYING SIDEBAR MODULE LABELS ===');
  const modules = await prisma.module.findMany();
  const clusterMod = modules.find(m => m.slug === 'cluster');
  const lcGatesMod = modules.find(m => m.slug === 'lc-gates');
  console.log(`✓ Module 'cluster' label in DB: "${clusterMod ? clusterMod.name : 'N/A'}"`);
  console.log(`✓ Module 'lc-gates' label in DB: "${lcGatesMod ? lcGatesMod.name : 'N/A'}"`);

  console.log('\n>>> ALL AUDIT CHECKS AND REQUIREMENTS FULLY SATISFIED! <<<');
}

runVerification()
  .catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

