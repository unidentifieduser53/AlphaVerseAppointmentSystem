require('dotenv').config();
const { app, seedAdministrator } = require('../server/app');

let adminSeed;

module.exports = async (req, res) => {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    adminSeed ||= seedAdministrator().catch((error) => {
      adminSeed = null;
      throw error;
    });
    try {
      await adminSeed;
    } catch (error) {
      console.error('Initial administrator setup failed:', error.message);
      return res.status(500).json({ error: 'Initial administrator setup failed.' });
    }
  }
  return app(req, res);
};
