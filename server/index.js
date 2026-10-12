require('dotenv').config();
const { app, seedAdministrator } = require('./app');

const port = Number(process.env.PORT || 3000);

async function start() {
  if (process.env.DATABASE_URL) {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
    }
    if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD)) {
      throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD to create the initial administrator.');
    }
    if (process.env.ADMIN_EMAIL) await seedAdministrator();
  }

  app.listen(port, () => {
    console.log(`AlphaVerse is listening on port ${port}.`);
  });
}

start().catch((error) => {
  console.error('Application startup failed:', error.message);
  process.exitCode = 1;
});
