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
import shiftsRoutes from './routes/shifts';
import rosterRoutes from './routes/roster';
import attendanceRoutes from './routes/attendance';

import reportsRoutes from './routes/reports';
import { errorHandler } from './middleware/error';
import { prisma } from './lib/prisma';
import { startTelemetryMonitor } from './lib/telemetryMonitor';
import { initTelemetryWebSocket } from './lib/telemetryWs';
import { getJwtRefreshSecret, getJwtSecret } from './middleware/auth';
import { startAttendanceRetentionWorker } from './workers/attendanceRetentionWorker';

import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const isRenderEnvironment =
  process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);

if (!isRenderEnvironment && process.env.NODE_ENV === 'production') {
  // Fail fast at startup if production secrets are missing
  getJwtSecret();
  getJwtRefreshSecret();
}

// Universal CORS & Chrome Private Network Access header support
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, If-None-Match, If-Match, Cache-Control');
  res.header('Access-Control-Expose-Headers', 'ETag, Content-Disposition');
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(cors({
  origin: '*',
  exposedHeaders: ['ETag', 'Content-Disposition'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'If-None-Match', 'If-Match', 'Cache-Control'],
}));
if (isRenderEnvironment) {
  // Decommissioned stub for legacy Render deployment: keeps Render health check 200 OK
  // so this deploy replaces older code, while blocking all APIs and running 0 DB/telemetry workers.
  app.get(['/', '/health', '/healthz'], (_req, res) => {
    res.status(200).json({
      status: 'decommissioned',
      message: 'Backend has been migrated. This Render endpoint is disabled.',
    });
  });

  app.use((_req, res) => {
    res.status(503).json({
      error: 'Service unavailable on legacy Render host. Please use the updated LC Platform Mobile App.',
    });
  });

  app.listen(port, () => {
    console.log(`⛔ [RENDER DECOMMISSIONED STUB] Listening on port ${port} with DB & telemetry workers disabled.`);
  });
} else {
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
  app.use('/api/v1/uploads', express.static(path.join(process.cwd(), 'uploads')));

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
  app.use('/api/v1/lcgates', lcgateRoutes);
  app.use('/api/v1/lc-gates', lcgateRoutes);
  app.use('/api/v1/devices', deviceRoutes);
  app.use('/api/v1/evidence', evidenceRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/shifts', shiftsRoutes);
  app.use('/api/v1/roster', rosterRoutes);
  app.use('/api/v1/attendance', attendanceRoutes);

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
    startAttendanceRetentionWorker();
    console.log(`Server is running on port ${port} with WebSocket telemetry stream`);
  });
}
