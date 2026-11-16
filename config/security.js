require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace_')) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters.');
}

module.exports = { jwtSecret };
