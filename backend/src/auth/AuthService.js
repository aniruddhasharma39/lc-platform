const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const userRepository = require('../users/UserRepository');
const { UnauthorizedError, ValidationError } = require('../utils/errors');

class AuthService {
  async login(email, password) {
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }
    
    if (user.status === 'LOCKED') {
      if (user.locked_until && new Date() < new Date(user.locked_until)) {
        throw new UnauthorizedError('Account is locked');
      } else {
        // Unlock if time expired
        await userRepository.update(user.id, { status: 'ACTIVE', locked_until: null, failed_login_attempts: 0 });
        user.status = 'ACTIVE';
      }
    }
    
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Account is inactive');
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      let updates = { failed_login_attempts: attempts };
      
      if (attempts >= 5) {
        updates.status = 'LOCKED';
        updates.locked_until = new Date(Date.now() + 15 * 60 * 1000); // Lock for 15 mins
      }
      await userRepository.update(user.id, updates);
      throw new UnauthorizedError('Invalid credentials');
    }
    
    // Reset attempts on success
    await userRepository.update(user.id, { failed_login_attempts: 0, last_login: new Date() });
    
    return this.generateTokens(user);
  }

  async generateTokens(user) {
    const accessToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    
    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    await userRepository.update(user.id, { refresh_token: refreshToken });
    
    return {
      accessToken,
      refreshToken,
      mustChangePassword: user.must_change_password
    };
  }

  async refreshToken(oldToken) {
    try {
      const decoded = jwt.verify(oldToken, process.env.JWT_SECRET);
      if (decoded.type !== 'refresh') throw new UnauthorizedError('Invalid token type');
      
      const user = await userRepository.findById(decoded.userId);
      if (!user || user.refresh_token !== oldToken) {
        throw new UnauthorizedError('Invalid refresh token');
      }
      
      // Token rotation
      return this.generateTokens(user);
    } catch (err) {
      throw new UnauthorizedError('Invalid refresh token');
    }
  }

  async changePassword(userId, oldPassword, newPassword) {
    const user = await userRepository.findById(userId);
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    
    if (!isValid) {
      throw new ValidationError('Invalid old password');
    }
    
    const hash = await bcrypt.hash(newPassword, 10);
    await userRepository.update(userId, { 
      password_hash: hash, 
      must_change_password: false,
      refresh_token: null // Invalidate existing sessions
    });
  }

  async logout(userId) {
    await userRepository.update(userId, { refresh_token: null });
  }
}

module.exports = new AuthService();
