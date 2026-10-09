import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import rolesRoutes from './routes/roles';
import modulesRoutes from './routes/modules';
import registrationFormsRoutes from './routes/registration-forms';
import settingsRoutes from './routes/settings';
import lcgateRoutes from './routes/lcgate';
import evidenceRoutes from './routes/evidence';
import { errorHandler } from './middleware/error';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/roles', rolesRoutes);
app.use('/api/v1/modules', modulesRoutes);
app.use('/api/v1/registration-forms', registrationFormsRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/lcgate', lcgateRoutes);
app.use('/api/v1/evidence', evidenceRoutes);

// Error Handling
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
