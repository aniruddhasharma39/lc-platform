require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const errorHandler = require('./src/middlewares/errorHandler');
const authRoutes = require('./src/auth/authRoutes');
const masterdataRoutes = require('./src/masterdata/masterdataRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.get('/health', (req, res) => res.json({ status: 'ok', component: 'api' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', authRoutes); // for /me/config
app.use('/api/v1/masterdata', masterdataRoutes);

app.use(errorHandler);

const db = require('./src/config/db');

if (require.main === module) {
  db.testConnection().then(isConnected => {
    app.listen(port, () => {
      console.log(`API Server listening on port ${port}`);
      if (!isConnected) {
        console.warn('WARNING: Starting server without a working database connection!');
      }
    });
  });
}

module.exports = app;
