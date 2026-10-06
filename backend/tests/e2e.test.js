const request = require('supertest');
const app = require('../api');

process.env.JWT_SECRET = 'test-secret';

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() }
}));

const db = require('../src/config/db');
const bcrypt = require('bcrypt');

describe('E2E Platform Foundation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should authenticate admin successfully', async () => {
    // Mock user find
    const hash = await bcrypt.hash('Admin@123', 10);
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'admin@lcplatform.com', password_hash: hash, status: 'ACTIVE', must_change_password: false }]
    }); // findByEmail
    
    // Mock update last_login
    db.query.mockResolvedValueOnce({ rows: [] }); 
    // Mock refresh_token update
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@lcplatform.com', password: 'Admin@123' });
      
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('should reject unauthorized access', async () => {
    const res = await request(app)
      .get('/api/v1/me/config');
      
    expect(res.statusCode).toBe(401);
  });
});
