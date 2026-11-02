import http from 'http';
import jwt from 'jsonwebtoken';
import express from 'express';
import authRoutes from '../src/routes/auth';
import userRoutes from '../src/routes/users';
import rolesRoutes from '../src/routes/roles';
import modulesRoutes from '../src/routes/modules';
import registrationFormsRoutes from '../src/routes/registration-forms';
import settingsRoutes from '../src/routes/settings';
import lcgateRoutes from '../src/routes/lcgate';
import deviceRoutes from '../src/routes/deviceRegistry';
import evidenceRoutes from '../src/routes/evidence';
import notificationsRoutes from '../src/routes/notifications';
import scopeGroupsRoutes from '../src/routes/scopeGroups';
import reportsRoutes from '../src/routes/reports';
import { errorHandler } from '../src/middleware/error';
import { prisma } from '../src/lib/prisma';

async function testAllSidebarSubmodules() {
  console.log('========================================================================');
  console.log('🔍 SYSTEM-WIDE AUDIT: ALL SIDEBAR SUBMODULE ENDPOINTS & APIS');
  console.log('========================================================================\n');

  // Find an admin/developer user
  const user = await prisma.user.findFirst({
    where: {
      status: 'APPROVED',
      role: { name: { in: ['Developer', 'DEVELOPER', 'Admin', 'ADMIN'] } },
    },
    include: { role: true },
  }) || await prisma.user.findFirst({
    where: { status: 'APPROVED' },
    include: { role: true },
  });

  if (!user) {
    throw new Error('No user found to test endpoints');
  }

  const jwtSecret = process.env.JWT_SECRET || 'super-secret-jwt-key';
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role?.name || 'Developer' },
    jwtSecret,
    { expiresIn: '2h' }
  );

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/roles', rolesRoutes);
  app.use('/api/v1/modules', modulesRoutes);
  app.use('/api/v1/registration-forms', registrationFormsRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/branding', settingsRoutes);
  app.use('/api/v1/lcgate', lcgateRoutes);
  app.use('/api/v1/lcgates', lcgateRoutes);
  app.use('/api/v1/devices', deviceRoutes);
  app.use('/api/v1/evidence', evidenceRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/scope-groups', scopeGroupsRoutes);
  app.use('/api/v1/reports', reportsRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const endpoints = [
    { module: 'System / Navigation', name: 'Modules List', path: '/modules', method: 'GET' },
    { module: 'System / Auth', name: 'User Profile (/auth/me)', path: '/auth/me', method: 'GET' },
    { module: 'System / Header', name: 'Notifications', path: '/notifications', method: 'GET' },
    { module: 'Branding', name: 'Branding Settings', path: '/branding', method: 'GET' },
    { module: 'Home / LC Gates', name: 'LC Gates List', path: '/lcgate', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Dashboard Summary', path: '/lcgate/dashboard-summary', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Status Summary', path: '/lcgate/status-summary', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Reference Data', path: '/lcgate/reference-data', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Divisions', path: '/lcgate/divisions', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Single Gate Details (Gate 17)', path: '/lcgate/17', method: 'GET' },
    { module: 'Home / LC Gates', name: 'Gate 17 Telemetry', path: '/lcgate/17/telemetry', method: 'GET' },
    { module: 'Reports', name: 'Reports Clusters', path: '/reports/clusters', method: 'GET' },
    { module: 'Reports', name: 'Reports Records', path: '/reports/records?startDate=2026-01-01&endDate=2026-12-31', method: 'GET' },
    { module: 'Reports', name: 'Reports Changes (Delta)', path: '/reports/records/changes', method: 'GET' },
    { module: 'Cluster / Scopes', name: 'Scope Groups', path: '/scope-groups', method: 'GET' },
    { module: 'Cluster / Scopes', name: 'My Scope (/scope-groups/my-scope)', path: '/scope-groups/my-scope', method: 'GET' },
    { module: 'Device Registry', name: 'Devices List', path: '/devices', method: 'GET' },
    { module: 'Device Registry', name: 'Device Stats Summary', path: '/devices/stats/summary', method: 'GET' },
    { module: 'Manage Users', name: 'Users List', path: '/users', method: 'GET' },
    { module: 'Registration Builder', name: 'Registration Forms', path: '/registration-forms', method: 'GET' },
    { module: 'Roles & Permissions', name: 'Roles List', path: '/roles', method: 'GET' },
  ];

  let passed = 0;
  let failed = 0;

  console.log(`Auditing as: ${user.fullName} (${user.role?.name || 'No Role'}, ID: ${user.id})\n`);

  for (const ep of endpoints) {
    const start = performance.now();
    try {
      const res = await fetch(`${baseUrl}${ep.path}`, { headers });
      const duration = (performance.now() - start).toFixed(1);
      const isJson = res.headers.get('content-type')?.includes('application/json');
      let dataSummary = '';
      if (isJson) {
        const body = await res.json();
        if (Array.isArray(body)) {
          dataSummary = `Array[${body.length}]`;
        } else if (typeof body === 'object' && body !== null) {
          const keys = Object.keys(body).slice(0, 4).join(', ');
          dataSummary = `{ ${keys}... }`;
        }
      }

      if (res.ok) {
        console.log(`  ✅ [PASS] [${ep.module}] ${ep.name} -> HTTP ${res.status} (${duration}ms) ${dataSummary}`);
        passed++;
      } else {
        console.error(`  ❌ [FAIL] [${ep.module}] ${ep.name} -> HTTP ${res.status} (${duration}ms)`);
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ [ERROR] [${ep.module}] ${ep.name} -> Exception: ${err.message}`);
      failed++;
    }
  }

  server.close();
  await prisma.$disconnect();

  console.log('\n========================================================================');
  console.log(`📊 SUBMODULE ENDPOINT AUDIT: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

testAllSidebarSubmodules().catch((err) => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});
