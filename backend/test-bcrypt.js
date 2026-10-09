const bcrypt = require('bcrypt');

async function testPassword() {
  const hash = '$2b$10$G9dZU/WLHTlNdCwFBiJy0uO1egBlf7eBp4ruZEsZGwUFiVBHz.Oe.';
  const password = 'admin123';
  const result = await bcrypt.compare(password, hash);
  console.log('Password match:', result);
}
testPassword();
