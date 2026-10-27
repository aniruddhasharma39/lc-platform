import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import rolesRoutes from './routes/roles';
import modulesRoutes from './routes/modules';
import registrationFormsRoutes from './routes/registration-forms';
import settingsRoutes from './routes/settings';
import lcgateRoutes from './routes/lcgate';
import deviceRoutes from './routes/deviceRegistry';
import evidenceRoutes from './routes/evidence';
import notificationsRoutes from './routes/notifications';
import scopeGroupsRoutes from './routes/scopeGroups';
import reportsRoutes from './routes/reports';
import { errorHandler } from './middleware/error';
import { prisma } from './lib/prisma';
import { startTelemetryMonitor } from './lib/telemetryMonitor';
import { initTelemetryWebSocket } from './lib/telemetryWs';

import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Normalize repeated slashes in request paths (e.g., //api/v1 -> /api/v1)
app.use((req, res, next) => {
  if (req.url.includes('//')) {
    req.url = req.url.replace(/\/+/g, '/');
  }
  next();
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/roles', rolesRoutes);
app.use('/api/v1/modules', modulesRoutes);
app.use('/api/v1/registration-forms', registrationFormsRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/branding', settingsRoutes);
app.use('/api/v1/lcgate', lcgateRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use('/api/v1/evidence', evidenceRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/scope-groups', scopeGroupsRoutes);
app.use('/api/v1/reports', reportsRoutes);

// Error Handling
app.use(errorHandler);

// Ensure system modules exist
const ensureSystemModules = async () => {
  try {
    const modulesToEnsure = [
      { name: 'LC Gates', slug: 'lc-gates' },
      { name: 'Reports', slug: 'reports' },
      { name: 'Cluster', slug: 'cluster' },
      { name: 'Device Registry', slug: 'devices' },
      { name: 'Scope Groups', slug: 'scope-groups' },
      { name: 'Manage Users', slug: 'manage-users' },
      { name: 'Registration Builder', slug: 'registration' },
      { name: 'Roles', slug: 'roles' },
      { name: 'Branding', slug: 'branding' },
    ];
    for (const mod of modulesToEnsure) {
      await prisma.module.upsert({
        where: { slug: mod.slug },
        update: {},
        create: { name: mod.name, slug: mod.slug }
      });
    }
  } catch (err) {
    console.error('Failed to ensure system modules:', err);
  }
};

const server = http.createServer(app);
initTelemetryWebSocket(server);

server.listen(port, () => {
  ensureSystemModules();
  startTelemetryMonitor(3000);
  console.log(`Server is running on port ${port} with WebSocket telemetry stream`);
});
