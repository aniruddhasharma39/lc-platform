require('dotenv').config();
console.log('Password length:', process.env.DEFAULT_ADMIN_PASSWORD.length);
console.log('Password:', process.env.DEFAULT_ADMIN_PASSWORD);
