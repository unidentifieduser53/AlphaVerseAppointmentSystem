# AlphaVerse Construction

The application is a vanilla HTML/CSS/JavaScript website with a small Node.js API. The API stores account, inquiry, project, schedule, billing, and client data in PostgreSQL. Resend is used for email verification, password recovery, and inquiry notifications. The same project can be deployed to Render or Vercel; use one host as the website origin so the secure, same-origin session cookie works.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `SESSION_SECRET`, and the Resend sender settings. Do not commit `.env`.
3. Create a PostgreSQL database and run:

   ```sh
   npm install
   npm run db:setup
   ```

4. To create the first administrator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters) in the environment, then start the server. The first admin is inserted once; changing the environment password later does not reset an existing account.
5. Run `npm start` and open `http://localhost:3000`.

The public site can be opened without a database, but account, inquiry, and dashboard APIs require PostgreSQL. Email verification, password recovery, and outbound notification require a valid Resend API key, verified sender, and `EMAIL_FROM`. Set `INQUIRY_NOTIFICATION_EMAIL` for inquiry alerts.

Run `npm run db:setup` again after updating the application to apply idempotent schema additions. Client-owned projects, schedules, billing, and inquiries are linked to the verified account ID; the dashboard does not use client names as an ownership check. When creating project, schedule, or billing records in the admin dashboard, set the client account email to link the record to a verified account or to associate it when that client registers later.

On Windows with PostgreSQL 18 installed under `C:\Program Files\PostgreSQL\18\bin`, `npm run db:local` creates a dedicated local cluster on `127.0.0.1:5433`, creates the app database/user, applies the schema, and writes local credentials to the Git-ignored `.env`. Set `ADMIN_EMAIL` before running it to create the initial administrator.

## PostgreSQL schema

`database/schema.sql` defines the replacement PostgreSQL schema. Apply it to the new database with `npm run db:setup`. The former SQLite file, if present, is preserved as the private, ignored `database/legacy.sqlite` migration source; it is not automatically copied into PostgreSQL. Export and transform existing records before a production cutover if it contains data that must be retained.

## Deploy to Render

Create a Node web service from this repository. Render uses `npm ci` and `npm start`. At startup, the app applies the idempotent PostgreSQL schema before seeding the initial administrator, so the `users` table exists first. Attach a PostgreSQL instance and set the service's `DATABASE_URL` to its connection string. Add `RESEND_API_KEY`, `EMAIL_FROM`, `INQUIRY_NOTIFICATION_EMAIL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` as Render environment secrets.

## Deploy to Vercel

Import the repository as a Node.js project. The `api/[...route].js` function forwards API requests to the shared Node application; the static pages are in `public/`. Add the same database and Resend environment variables in Vercel project settings. Apply `database/schema.sql` to PostgreSQL before using the API. Set `DATABASE_SSL=true` if the database provider requires TLS.

## Email and credentials

Never put PostgreSQL credentials, Resend keys, or account passwords in browser JavaScript or checked-in configuration. All secrets are read from environment variables on the server.
