import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcrypt';
import { prisma } from '../src/lib/prisma';
import { DESIGNATIONS } from '../src/lib/railwayHierarchy';

interface UserSpec {
  fullName: string;
  email: string;
  mobile: string;
  employeeId: string;
  department: 'Operations' | 'Engineering';
  designation: string;
  zone: string;
  division: string;
  stationCode?: string;
  gateLcNumbers?: string[];
  roleName: string;
}

const USERS_TO_CREATE: UserSpec[] = [
  // ==========================================
  // OPERATIONS DEPARTMENT
  // ==========================================
  {
    fullName: 'Rajesh Sharma (Sr. DOM)',
    email: 'srdom.pune@lcgate.in',
    mobile: '9876543201',
    employeeId: 'CR-OPS-001',
    department: 'Operations',
    designation: 'Senior DOM',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'Senior DOM'
  },
  {
    fullName: 'Amit Verma (DOM)',
    email: 'dom.pune@lcgate.in',
    mobile: '9876543202',
    employeeId: 'CR-OPS-002',
    department: 'Operations',
    designation: 'DOM',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'DOM'
  },
  {
    fullName: 'Suresh Patil (ADOM)',
    email: 'adom.pune@lcgate.in',
    mobile: '9876543203',
    employeeId: 'CR-OPS-003',
    department: 'Operations',
    designation: 'ADOM/AOM',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'ADOM/AOM'
  },
  {
    fullName: 'Mahesh Kulkarni (Station Master)',
    email: 'sm.targaon@lcgate.in',
    mobile: '9876543204',
    employeeId: 'CR-OPS-004',
    department: 'Operations',
    designation: 'Station Master',
    zone: 'Central Railway',
    division: 'Pune',
    stationCode: 'TGN-01', // Fallback station lookup
    gateLcNumbers: ['LC-91'],
    roleName: 'Station Master'
  },

  // ==========================================
  // ENGINEERING DEPARTMENT
  // ==========================================
  {
    fullName: 'Vikram Singh (Sr. DEN)',
    email: 'srden.pune@lcgate.in',
    mobile: '9876543205',
    employeeId: 'CR-ENG-001',
    department: 'Engineering',
    designation: 'Senior DEN',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'Senior DEN'
  },
  {
    fullName: 'Ramesh Chandra (DEN)',
    email: 'den.pune@lcgate.in',
    mobile: '9876543206',
    employeeId: 'CR-ENG-002',
    department: 'Engineering',
    designation: 'DEN',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'DEN'
  },
  {
    fullName: 'Anil Deshmukh (ADEN)',
    email: 'aden.pune@lcgate.in',
    mobile: '9876543207',
    employeeId: 'CR-ENG-003',
    department: 'Engineering',
    designation: 'ADEN',
    zone: 'Central Railway',
    division: 'Pune',
    roleName: 'ADEN'
  },
  {
    fullName: 'Ganesh Jadhav (Engg Supervisor)',
    email: 'engsup.satara@lcgate.in',
    mobile: '9876543208',
    employeeId: 'CR-ENG-004',
    department: 'Engineering',
    designation: 'Engineering Supervisor',
    zone: 'Central Railway',
    division: 'Pune',
    gateLcNumbers: ['LC-63'],
    roleName: 'Engineering Supervisor'
  },
  {
    fullName: 'Raju Shinde (Gateman)',
    email: 'gateman.lc91@lcgate.in',
    mobile: '9876543209',
    employeeId: 'CR-ENG-005',
    department: 'Engineering',
    designation: 'Gateman',
    zone: 'Central Railway',
    division: 'Pune',
    gateLcNumbers: ['LC-91'],
    roleName: 'Gateman'
  }
];

async function seedHierarchyUsers() {
  console.log('Seeding Department Users (Operations & Engineering)...');

  const defaultPassword = 'Railway@123';
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  // Find standard registration form
  const form = await prisma.registrationForm.findFirst({
    where: { status: 'LIVE' }
  });

  // Load all gates with stations
  const allGates = await prisma.lCGate.findMany({
    include: { station: true }
  });

  // Load all stations
  const allStations = await prisma.station.findMany();

  for (const spec of USERS_TO_CREATE) {
    console.log(`\nProcessing user: ${spec.fullName} (${spec.designation} - ${spec.department})`);

    // 1. Find role
    const role = await prisma.role.findFirst({
      where: { name: spec.roleName }
    });
    if (!role) {
      console.error(`Role not found: ${spec.roleName}`);
      continue;
    }

    // 2. Resolve gates and station
    let resolvedStationId: number | null = null;
    const resolvedGateIds: number[] = [];

    if (spec.gateLcNumbers && spec.gateLcNumbers.length > 0) {
      for (const lcNum of spec.gateLcNumbers) {
        const foundGate = allGates.find(g => g.lcNumber.toLowerCase() === lcNum.toLowerCase());
        if (foundGate) {
          resolvedGateIds.push(foundGate.id);
          if (!resolvedStationId && foundGate.stationId) {
            resolvedStationId = foundGate.stationId;
          }
        }
      }
    }

    if (!resolvedStationId && spec.stationCode) {
      const foundStation = allStations.find(s => s.code.toLowerCase() === spec.stationCode?.toLowerCase());
      if (foundStation) {
        resolvedStationId = foundStation.id;
      }
    }

    // 3. Upsert user
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: spec.email },
          { mobile: spec.mobile },
          { employeeId: spec.employeeId }
        ]
      }
    });

    let user;
    if (existingUser) {
      user = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          fullName: spec.fullName,
          email: spec.email,
          mobile: spec.mobile,
          employeeId: spec.employeeId,
          department: spec.department,
          designation: spec.designation,
          roleId: role.id,
          requestedRoleId: role.id,
          status: 'APPROVED',
          passwordHash: passwordHash,
          zone: spec.zone,
          division: spec.division,
          stationId: resolvedStationId,
          idCardUrl: 'https://images.unsplash.com/photo-1544717305-2782549b5136?w=400&q=80',
          metadata: JSON.stringify({
            fullName: spec.fullName,
            email: spec.email,
            mobile: spec.mobile,
            employeeId: spec.employeeId,
            department: spec.department,
            designation: spec.designation,
            zone: spec.zone,
            division: spec.division,
            declarationConfirmed: true
          })
        }
      });
      console.log(`Updated user ${user.id}: ${user.email}`);
    } else {
      user = await prisma.user.create({
        data: {
          fullName: spec.fullName,
          email: spec.email,
          mobile: spec.mobile,
          employeeId: spec.employeeId,
          department: spec.department,
          designation: spec.designation,
          roleId: role.id,
          requestedRoleId: role.id,
          status: 'APPROVED',
          passwordHash: passwordHash,
          zone: spec.zone,
          division: spec.division,
          stationId: resolvedStationId,
          idCardUrl: 'https://images.unsplash.com/photo-1544717305-2782549b5136?w=400&q=80',
          metadata: JSON.stringify({
            fullName: spec.fullName,
            email: spec.email,
            mobile: spec.mobile,
            employeeId: spec.employeeId,
            department: spec.department,
            designation: spec.designation,
            zone: spec.zone,
            division: spec.division,
            declarationConfirmed: true
          })
        }
      });
      console.log(`Created user ${user.id}: ${user.email}`);
    }

    // 4. Assign gates via UserGate
    if (resolvedGateIds.length > 0) {
      for (const gateId of resolvedGateIds) {
        await prisma.userGate.upsert({
          where: {
            userId_gateId: { userId: user.id, gateId: gateId }
          },
          update: {},
          create: {
            userId: user.id,
            gateId: gateId
          }
        });
      }
      console.log(`Assigned ${resolvedGateIds.length} gate(s) to user ${user.id}`);
    }

    // 5. Ensure matching approved RegistrationRequest
    if (form) {
      const existingReq = await prisma.registrationRequest.findFirst({
        where: {
          data: { contains: spec.employeeId }
        }
      });

      if (!existingReq) {
        await prisma.registrationRequest.create({
          data: {
            formId: form.id,
            data: JSON.stringify({
              fullName: spec.fullName,
              email: spec.email,
              mobile: spec.mobile,
              employeeId: spec.employeeId,
              department: spec.department,
              designation: spec.designation,
              zone: spec.zone,
              division: spec.division,
              stationId: resolvedStationId,
              gateIds: resolvedGateIds,
              declarationConfirmed: true
            }),
            status: 'APPROVED',
            requestedRoleId: role.id,
            department: spec.department,
            designation: spec.designation,
            zone: spec.zone,
            division: spec.division,
            stationId: resolvedStationId,
            gateIds: resolvedGateIds,
            declarationConfirmed: true,
            approvedByUserId: 1, // System Admin
            approvedAt: new Date(),
            idCardUrl: 'https://images.unsplash.com/photo-1544717305-2782549b5136?w=400&q=80'
          }
        });
        console.log(`Created approved registration request for ${spec.employeeId}`);
      }
    }
  }

  console.log('\nAll department users successfully seeded!');
}

seedHierarchyUsers()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Failed to seed users:', e);
    process.exit(1);
  });
