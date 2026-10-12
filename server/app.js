require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { randomInt, createHmac, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { getPool, withTransaction } = require('./db');
const {
  authenticate,
  clearSessionCookie,
  requireAdmin,
  setSessionCookie
} = require('./auth');
const {
  sendInquiryNotice,
  sendInquiryUpdate,
  sendPasswordResetCode,
  sendVerificationCode
} = require('./email');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com']
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
  next();
});

const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath, { extensions: ['html'], index: 'index.html' }));
app.use('/images', express.static(path.join(publicPath, 'images')));

const rateLimits = new Map();
function rateLimit({ limit, windowMs }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    if (rateLimits.size > 10000) {
      for (const [entry, value] of rateLimits) {
        if (now >= value.resetAt) rateLimits.delete(entry);
      }
    }
    const current = rateLimits.get(key);
    if (!current || now >= current.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (current.count >= limit) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    current.count += 1;
    return next();
  };
}

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();

  const configuredOrigin = process.env.ALLOWED_ORIGIN;
  const expectedOrigin = configuredOrigin || `${req.protocol}://${req.get('host')}`;
  if (origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  return next();
});

app.get('/api/health', async (req, res) => {
  await getPool().query('SELECT 1 FROM users LIMIT 0');
  res.json({ status: 'ok', database: 'connected' });
});

function text(value, field, { required = false, max = 2000 } = {}) {
  if (typeof value !== 'string') {
    if (required) throw Object.assign(new Error(`${field} is required.`), { status: 400 });
    return '';
  }
  const normalized = value.trim();
  if (required && !normalized) throw Object.assign(new Error(`${field} is required.`), { status: 400 });
  if (normalized.length > max) {
    throw Object.assign(new Error(`${field} must be no longer than ${max} characters.`), { status: 400 });
  }
  return normalized;
}

function emailAddress(value, { required = true } = {}) {
  const email = text(value, 'Email', { required, max: 254 }).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  }
  return email;
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error('A valid record ID is required.'), { status: 400 });
  }
  return id;
}

function codeDigest(code) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
  }
  return createHmac('sha256', secret).update(code).digest();
}

function codeMatches(code, digest) {
  const expected = codeDigest(code);
  const actual = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

app.post('/api/auth/register', rateLimit({ limit: 5, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const fullName = text(req.body.fullName, 'Full name', { required: true, max: 150 });
  const email = emailAddress(req.body.email);
  const contactNumber = text(req.body.contactNumber, 'Contact number', { max: 40 });
  const password = text(req.body.password, 'Password', { required: true, max: 128 });
  const role = req.body.role === 'admin' ? 'admin' : req.body.role === 'client' ? 'client' : '';
  if (!role) return res.status(400).json({ error: 'Choose a valid account type.' });
  if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include upper-case, lower-case, and a number.' });
  }

  const pool = getPool();
  const existing = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rowCount) return res.status(409).json({ error: 'An account with that email already exists.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const code = String(randomInt(100000, 1000000));
  await pool.query(
    `INSERT INTO registration_codes
       (email, full_name, contact_number, password_hash, requested_role, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '10 minutes', 0)
     ON CONFLICT (email) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       contact_number = EXCLUDED.contact_number,
       password_hash = EXCLUDED.password_hash,
       requested_role = EXCLUDED.requested_role,
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       created_at = NOW()`,
    [email, fullName, contactNumber, passwordHash, role, codeDigest(code).toString('hex')]
  );
  await sendVerificationCode(email, fullName, code);
  res.status(202).json({ message: 'A verification code was sent to your email.', email });
});

app.post('/api/auth/register/resend-code', rateLimit({ limit: 3, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const email = emailAddress(req.body.email);
  const code = String(randomInt(100000, 1000000));
  const { rows } = await getPool().query(
    `UPDATE registration_codes
     SET code_hash = $1, expires_at = NOW() + INTERVAL '10 minutes',
         attempts = 0, created_at = NOW()
     WHERE email = $2
       AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(users.email) = $2)
     RETURNING full_name`,
    [codeDigest(code).toString('hex'), email]
  );

  if (rows[0]) {
    await sendVerificationCode(email, rows[0].full_name, code);
  }
  res.status(202).json({ message: 'If registration is pending for this address, a new verification code has been sent.' });
});

app.post('/api/auth/verify', rateLimit({ limit: 8, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = emailAddress(req.body.email);
  const code = text(req.body.code, 'Verification code', { required: true, max: 6 });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM registration_codes
       WHERE email = $1 AND expires_at > NOW() AND attempts < 5
       FOR UPDATE`,
      [email]
    );
    const pending = rows[0];
    if (!pending) return null;
    if (!codeMatches(code, pending.code_hash)) {
      await client.query('UPDATE registration_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return null;
    }

    const status = pending.requested_role === 'admin' ? 'pending_approval' : 'active';
    const inserted = await client.query(
      `INSERT INTO users (full_name, email, contact_number, password_hash, role, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, email, contact_number, role, status`,
      [pending.full_name, pending.email, pending.contact_number, pending.password_hash, pending.requested_role, status]
    );
    const createdUser = inserted.rows[0];
    if (pending.requested_role === 'admin') {
      await client.query(
        'INSERT INTO admin_requests (user_id, email) VALUES ($1, $2)',
        [createdUser.id, createdUser.email]
      );
    } else {
      await client.query(
        `UPDATE clients SET account_user_id = $1
         WHERE id = (
           SELECT id FROM clients
           WHERE LOWER(email) = $2 AND account_user_id IS NULL
           ORDER BY date_added DESC LIMIT 1
         )`,
        [createdUser.id, email]
      );
      for (const table of ['projects', 'schedules', 'billings', 'inquiries']) {
        await client.query(
          `UPDATE ${table} SET client_user_id = $1
           WHERE LOWER(${table === 'inquiries' ? 'email' : 'client_email'}) = $2 AND client_user_id IS NULL`,
          [createdUser.id, email]
        );
      }
    }
    await client.query('DELETE FROM registration_codes WHERE email = $1', [email]);
    return createdUser;
  });

  if (!user) return res.status(400).json({ error: 'The code is invalid, expired, or has reached its attempt limit.' });
  if (user.status === 'active') setSessionCookie(res, user);
  res.status(201).json({
    user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, status: user.status },
    message: user.status === 'active'
      ? 'Your account is verified.'
      : 'Your email is verified. An administrator must approve your administrator access.'
  });
});

app.post('/api/auth/login', rateLimit({ limit: 8, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = emailAddress(req.body.email);
  const password = text(req.body.password, 'Password', { required: true, max: 128 });
  const { rows } = await getPool().query(
    `SELECT id, full_name, email, contact_number, password_hash, role, status, session_version
     FROM users WHERE LOWER(email) = $1`,
    [email]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (user.status !== 'active') {
    const message = user.status === 'pending_approval'
      ? 'Your administrator access is awaiting approval.'
      : 'Verify your email before signing in.';
    return res.status(403).json({ error: message, status: user.status });
  }
  setSessionCookie(res, user);
  res.json({
    user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
  });
});

app.post('/api/auth/password-reset/request', rateLimit({ limit: 3, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const email = emailAddress(req.body.email);
  const { rows } = await getPool().query(
    `SELECT id, full_name FROM users WHERE LOWER(email) = $1 AND status = 'active'`,
    [email]
  );
  if (rows[0]) {
    const code = String(randomInt(100000, 1000000));
    await getPool().query(
      `INSERT INTO password_reset_codes (email, code_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, NOW())
       ON CONFLICT (email) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         created_at = NOW()`,
      [email, codeDigest(code).toString('hex')]
    );
    await sendPasswordResetCode(email, rows[0].full_name, code);
  }
  res.status(202).json({ message: 'If an active account exists for this address, a password reset code has been sent.' });
});

app.post('/api/auth/password-reset/complete', rateLimit({ limit: 8, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = emailAddress(req.body.email);
  const code = text(req.body.code, 'Reset code', { required: true, max: 6 });
  const password = text(req.body.password, 'New password', { required: true, max: 128 });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit reset code.' });
  if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include upper-case, lower-case, and a number.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const reset = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM password_reset_codes
       WHERE email = $1 AND expires_at > NOW() AND attempts < 5
       FOR UPDATE`,
      [email]
    );
    const pending = rows[0];
    if (!pending) return false;
    if (!codeMatches(code, pending.code_hash)) {
      await client.query('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return false;
    }

    const { rowCount } = await client.query(
      `UPDATE users SET password_hash = $1, session_version = session_version + 1, updated_at = NOW()
       WHERE LOWER(email) = $2 AND status = 'active'`,
      [passwordHash, email]
    );
    await client.query('DELETE FROM password_reset_codes WHERE email = $1', [email]);
    return rowCount > 0;
  });
  if (!reset) return res.status(400).json({ error: 'The code is invalid, expired, or has reached its attempt limit.' });
  res.json({ message: 'Password reset successfully. Sign in with your new password.' });
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
  await getPool().query(
    'UPDATE users SET session_version = session_version + 1, updated_at = NOW() WHERE id = $1',
    [req.user.id]
  );
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', authenticate, (req, res) => {
  const { id, full_name, email, contact_number, role } = req.user;
  res.json({ user: { id, fullName: full_name, email, contactNumber: contact_number, role } });
});

app.post('/api/inquiries', rateLimit({ limit: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const clientName = text(req.body.clientName, 'Full name', { required: true, max: 150 });
  const email = emailAddress(req.body.email);
  const contactNumber = text(req.body.contactNumber, 'Contact number', { max: 40 });
  const projectType = text(req.body.projectType, 'Project type', { max: 150 });
  const message = text(req.body.message, 'Message', { max: 4000 });
  if (!contactNumber) return res.status(400).json({ error: 'Contact number is required.' });

  const { rows } = await getPool().query(
    `INSERT INTO inquiries (client_name, email, contact_number, project_type, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [clientName, email, contactNumber, projectType, message]
  );
  let emailNotified = true;
  try {
    await sendInquiryNotice({ clientName, email, contactNumber, projectType, message });
  } catch (error) {
    emailNotified = false;
    console.error('Inquiry was saved but the notification email was not sent:', error.message);
  }
  res.status(201).json({
    message: 'Your inquiry has been received.',
    id: rows[0].id,
    emailNotified
  });
});

app.get('/api/client/summary', authenticate, async (req, res) => {
  if (req.user.role !== 'client') return res.status(403).json({ error: 'Client access is required.' });
  const { rows: clients } = await getPool().query(
    'SELECT * FROM clients WHERE account_user_id = $1 ORDER BY date_added DESC LIMIT 1',
    [req.user.id]
  );
  const [projects, billings, schedules, inquiries] = await Promise.all([
    getPool().query('SELECT * FROM projects WHERE client_user_id = $1 ORDER BY start_date DESC', [req.user.id]),
    getPool().query('SELECT * FROM billings WHERE client_user_id = $1 ORDER BY billing_date DESC', [req.user.id]),
    getPool().query('SELECT * FROM schedules WHERE client_user_id = $1 ORDER BY scheduled_date', [req.user.id]),
    getPool().query('SELECT * FROM inquiries WHERE client_user_id = $1 ORDER BY date_submitted DESC', [req.user.id])
  ]);
  res.json({
    client: clients[0] || null,
    projects: projects.rows,
    billings: billings.rows,
    schedules: schedules.rows,
    inquiries: inquiries.rows
  });
});

const resources = {
  inquiries: {
    table: 'inquiries',
    order: 'date_submitted DESC',
    fields: {
      clientName: 'client_name', contactNumber: 'contact_number', email: 'email',
      projectType: 'project_type', message: 'message',
      paymentMethod: 'payment_method', paymentStatus: 'payment_status'
    },
    required: ['clientName']
  },
  projects: {
    table: 'projects',
    order: 'start_date DESC',
    fields: {
      projectName: 'project_name', clientName: 'client_name', clientEmail: 'client_email', location: 'location',
      status: 'status', startDate: 'start_date', endDate: 'end_date', budget: 'budget'
    },
    required: ['projectName']
  },
  schedules: {
    table: 'schedules',
    order: 'scheduled_date ASC',
    fields: {
      title: 'title', projectName: 'project_name', clientEmail: 'client_email', assignedTo: 'assigned_to',
      scheduledDate: 'scheduled_date', status: 'status', notes: 'notes'
    },
    required: ['title']
  },
  billings: {
    table: 'billings',
    order: 'billing_date DESC',
    fields: {
      clientName: 'client_name', projectName: 'project_name', clientEmail: 'client_email', amount: 'amount',
      status: 'status', dueDate: 'due_date', notes: 'notes'
    },
    required: ['clientName']
  },
  clients: {
    table: 'clients',
    order: 'date_added DESC',
    fields: {
      fullName: 'full_name', email: 'email', contactNumber: 'contact_number', address: 'address'
    },
    required: ['fullName']
  },
  'admin-requests': {
    table: 'admin_requests',
    order: 'request_date DESC',
    fields: {},
    required: []
  }
};

const allowedStatuses = {
  inquiries: ['New', 'Pending', 'Meeting Set', 'Discussed', 'Accepted', 'Rejected'],
  projects: ['Ongoing', 'Completed', 'On Hold', 'Cancelled'],
  schedules: ['Upcoming', 'Completed', 'Cancelled'],
  billings: ['Pending', 'Paid', 'Overdue', 'Cancelled']
};
const allowedPaymentStatuses = ['Unpaid', 'Pending', 'Paid', 'Overdue', 'Cancelled'];
const numericFields = new Set(['budget', 'amount', 'projectBudget', 'advancePaymentPercent']);
const dateFields = new Set(['startDate', 'endDate', 'scheduledDate', 'dueDate', 'meetingDate']);

function normalizeResourceValue(resourceName, field, value, { required = false } = {}) {
  if (field === 'email' || field === 'clientEmail') {
    if (value !== null && value !== '' && typeof value !== 'string') {
      throw Object.assign(new Error('Email must be a string.'), { status: 400 });
    }
    return emailAddress(value, { required });
  }
  if (numericFields.has(field)) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw Object.assign(new Error(`${field} must be a number.`), { status: 400 });
    }
    const number = Number(value ?? 0);
    if (!Number.isFinite(number) || number < 0 || number > 999999999999.99) {
      throw Object.assign(new Error(`${field} must be a non-negative amount within the supported limit.`), { status: 400 });
    }
    return number;
  }
  if (dateFields.has(field)) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw Object.assign(new Error(`${field} must be a valid date.`), { status: 400 });
    }
    if (field !== 'scheduledDate' && field !== 'meetingDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw Object.assign(new Error(`${field} must be a valid date.`), { status: 400 });
      }
      return value;
    }
    return new Date(value).toISOString();
  }
  if (field === 'status' && allowedStatuses[resourceName] && !allowedStatuses[resourceName].includes(value)) {
    throw Object.assign(new Error(`Status is invalid for ${resourceName}.`), { status: 400 });
  }
  if (field === 'paymentStatus' && !allowedPaymentStatuses.includes(value)) {
    throw Object.assign(new Error('Payment status is invalid.'), { status: 400 });
  }
  return text(value, field, { required, max: 2000 });
}

async function findActiveClientId(email, executor = getPool()) {
  if (!email) return null;
  const { rows } = await executor.query(
    `SELECT id FROM users
     WHERE LOWER(email) = $1 AND role = 'client' AND status = 'active'
     LIMIT 1`,
    [email]
  );
  return rows[0]?.id || null;
}

app.use('/api/admin', authenticate, requireAdmin);

app.get('/api/admin/dashboard', async (req, res) => {
  const pool = getPool();
  const [
    newInquiries, ongoingProjects, pendingQuotations, pendingBills,
    paid, pending, schedules, recentInquiries, completedProjects, adminRequests
  ] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM inquiries WHERE status = 'New'"),
    pool.query("SELECT COUNT(*)::int AS count FROM projects WHERE status = 'Ongoing'"),
    pool.query("SELECT COUNT(*)::int AS count FROM inquiries WHERE status = 'Pending'"),
    pool.query("SELECT COUNT(*)::int AS count FROM billings WHERE status = 'Pending'"),
    pool.query("SELECT COALESCE(SUM(amount), 0) AS amount FROM billings WHERE status = 'Paid'"),
    pool.query("SELECT COALESCE(SUM(amount), 0) AS amount FROM billings WHERE status = 'Pending'"),
    pool.query("SELECT * FROM schedules WHERE status = 'Upcoming' ORDER BY scheduled_date LIMIT 5"),
    pool.query('SELECT * FROM inquiries ORDER BY date_submitted DESC LIMIT 5'),
    pool.query("SELECT * FROM projects WHERE status = 'Completed' ORDER BY end_date DESC NULLS LAST LIMIT 5"),
    pool.query("SELECT * FROM admin_requests WHERE status = 'Pending' ORDER BY request_date DESC")
  ]);
  res.json({
    newInquiries: newInquiries.rows[0].count,
    ongoingProjects: ongoingProjects.rows[0].count,
    pendingQuotations: pendingQuotations.rows[0].count,
    pendingBills: pendingBills.rows[0].count,
    totalRevenue: Number(paid.rows[0].amount),
    pendingRevenue: Number(pending.rows[0].amount),
    upcomingSchedules: schedules.rows,
    recentInquiries: recentInquiries.rows,
    completedProjects: completedProjects.rows,
    pendingAdminRequests: adminRequests.rows.length
  });
});

app.get('/api/admin/reports', async (req, res) => {
  const pool = getPool();
  const [
    inquiryCount, newInquiryCount, projectCount, ongoingCount, completedCount,
    scheduleCount, upcomingCount, clientCount, paid, pending, recentBillings, recentProjects
  ] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM inquiries'),
    pool.query("SELECT COUNT(*)::int AS count FROM inquiries WHERE status = 'New'"),
    pool.query('SELECT COUNT(*)::int AS count FROM projects'),
    pool.query("SELECT COUNT(*)::int AS count FROM projects WHERE status = 'Ongoing'"),
    pool.query("SELECT COUNT(*)::int AS count FROM projects WHERE status = 'Completed'"),
    pool.query('SELECT COUNT(*)::int AS count FROM schedules'),
    pool.query("SELECT COUNT(*)::int AS count FROM schedules WHERE status = 'Upcoming'"),
    pool.query('SELECT COUNT(*)::int AS count FROM clients'),
    pool.query("SELECT COALESCE(SUM(amount), 0) AS amount FROM billings WHERE status = 'Paid'"),
    pool.query("SELECT COALESCE(SUM(amount), 0) AS amount FROM billings WHERE status = 'Pending'"),
    pool.query('SELECT * FROM billings ORDER BY billing_date DESC LIMIT 5'),
    pool.query('SELECT * FROM projects ORDER BY start_date DESC LIMIT 5')
  ]);
  res.json({
    totalInquiries: inquiryCount.rows[0].count,
    newInquiries: newInquiryCount.rows[0].count,
    totalProjects: projectCount.rows[0].count,
    ongoingProjects: ongoingCount.rows[0].count,
    completedProjects: completedCount.rows[0].count,
    totalSchedules: scheduleCount.rows[0].count,
    upcomingSchedules: upcomingCount.rows[0].count,
    totalClients: clientCount.rows[0].count,
    totalPaid: Number(paid.rows[0].amount),
    totalPending: Number(pending.rows[0].amount),
    recentBillings: recentBillings.rows,
    recentProjects: recentProjects.rows
  });
});

app.get('/api/admin/:resource', async (req, res) => {
  const resource = resources[req.params.resource];
  if (!resource) return res.status(404).json({ error: 'Unknown data resource.' });
  const { rows } = await getPool().query(`SELECT * FROM ${resource.table} ORDER BY ${resource.order}`);
  res.json({ items: rows });
});

app.post('/api/admin/:resource', async (req, res) => {
  const resource = resources[req.params.resource];
  if (!resource || req.params.resource === 'admin-requests') {
    return res.status(404).json({ error: 'This resource cannot be created.' });
  }

  const columns = [];
  const values = [];
  for (const [field, column] of Object.entries(resource.fields)) {
    if (Object.hasOwn(req.body, field)) {
      columns.push(column);
      const value = normalizeResourceValue(req.params.resource, field, req.body[field], {
        required: resource.required.includes(field)
      });
      if (value === null && ['startDate', 'scheduledDate'].includes(field)) {
        columns.pop();
        continue;
      }
      values.push(value);
    }
  }
  for (const field of resource.required) {
    if (Object.hasOwn(req.body, field) && !String(req.body[field] ?? '').trim()) {
      return res.status(400).json({ error: `${field} cannot be empty.` });
    }
  }
  for (const field of resource.required) {
    if (!Object.hasOwn(req.body, field)) {
      return res.status(400).json({ error: `${field} is required.` });
    }
  }
  if (!columns.length) return res.status(400).json({ error: 'Provide at least one valid field.' });
  if (['projects', 'schedules', 'billings'].includes(req.params.resource) && Object.hasOwn(req.body, 'clientEmail')) {
    columns.push('client_user_id');
    values.push(await findActiveClientId(normalizeResourceValue(req.params.resource, 'clientEmail', req.body.clientEmail)));
  } else if (req.params.resource === 'clients' && Object.hasOwn(req.body, 'email')) {
    columns.push('account_user_id');
    values.push(await findActiveClientId(normalizeResourceValue(req.params.resource, 'email', req.body.email)));
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  const { rows } = await getPool().query(
    `INSERT INTO ${resource.table} (${columnList}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  res.status(201).json({ item: rows[0] });
});

app.patch('/api/admin/admin-requests/:id', async (req, res) => {
  const id = positiveId(req.params.id);
  const status = text(req.body.status, 'Status', { required: true, max: 20 });
  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be Approved or Rejected.' });
  }
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM admin_requests WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!rows[0]) return null;
    const request = rows[0];
    if (request.status !== 'Pending') {
      throw Object.assign(new Error('This administrator request has already been reviewed.'), { status: 409 });
    }
    await client.query('UPDATE admin_requests SET status = $1 WHERE id = $2', [status, id]);
    await client.query(
      'UPDATE users SET status = $1, role = $2, updated_at = NOW() WHERE id = $3',
      ['active', status === 'Approved' ? 'admin' : 'client', request.user_id]
    );
    return { ...request, status };
  });
  if (!result) return res.status(404).json({ error: 'Administrator request not found.' });
  res.json({ item: result });
});

app.patch('/api/admin/inquiries/:id/meeting', async (req, res) => {
  const id = positiveId(req.params.id);
  const meetingDate = text(req.body.meetingDate, 'Meeting date', { required: true, max: 40 });
  const date = new Date(meetingDate);
  if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'Enter a valid meeting date.' });
  const notes = text(req.body.meetingNotes, 'Meeting notes', { max: 2000 });
  const budget = Number(req.body.projectBudget || 0);
  const percent = Number(req.body.advancePaymentPercent || 0);
  if (!Number.isFinite(budget) || budget < 0 || budget > 999999999999.99 ||
      !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return res.status(400).json({ error: 'Budget or advance payment percentage is invalid.' });
  }
  const advance = Math.round(budget * percent) / 100;
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM inquiries WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return null;
    if (['Accepted', 'Rejected'].includes(rows[0].status)) {
      throw Object.assign(new Error('Closed inquiries cannot be rescheduled.'), { status: 409 });
    }
    const { rows: updated } = await client.query(
      `UPDATE inquiries SET meeting_date = $1, meeting_notes = $2, project_budget = $3,
         advance_payment_percent = $4, advance_payment_amount = $5, status = 'Meeting Set'
       WHERE id = $6 RETURNING *`,
      [date, notes, budget, percent, advance, id]
    );
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'Inquiry not found.' });

  let emailSent = true;
  try {
    await sendInquiryUpdate({
      to: result.email,
      name: result.client_name,
      subject: 'AlphaVerse Construction — Meeting Scheduled',
      lines: [
        `Your meeting is scheduled for ${date.toLocaleString()}.`,
        `Notes: ${notes || 'No additional notes.'}`,
        `Estimated advance payment: PHP ${advance.toFixed(2)}.`
      ]
    });
  } catch (error) {
    emailSent = false;
    console.error('Meeting was saved but the email was not sent:', error.message);
  }
  res.json({ item: result, emailSent });
});

app.post('/api/admin/inquiries/:id/discussed', async (req, res) => {
  const id = positiveId(req.params.id);
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT status FROM inquiries WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return null;
    if (!['Pending', 'Meeting Set'].includes(rows[0].status)) {
      throw Object.assign(new Error('Only pending or scheduled inquiries can be marked discussed.'), { status: 409 });
    }
    const { rows: updated } = await client.query(
      `UPDATE inquiries SET status = 'Discussed' WHERE id = $1 RETURNING *`,
      [id]
    );
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'Inquiry not found.' });
  res.json({ item: result });
});

app.post('/api/admin/inquiries/:id/accept', async (req, res) => {
  const id = positiveId(req.params.id);
  const data = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM inquiries WHERE id = $1 FOR UPDATE', [id]);
    const inquiry = rows[0];
    if (!inquiry) return null;
    if (inquiry.status !== 'Discussed') {
      throw Object.assign(new Error('Only discussed inquiries can be accepted.'), { status: 409 });
    }
    const projectName = inquiry.project_type || 'New Project';
    const userId = await findActiveClientId(inquiry.email, client);
    await client.query(
      `INSERT INTO clients (full_name, email, contact_number, account_user_id)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM clients WHERE LOWER(email) = LOWER($2))`,
      [inquiry.client_name, inquiry.email, inquiry.contact_number, userId]
    );
    if (userId) {
      await client.query(
        `UPDATE clients SET account_user_id = $1
         WHERE id = (
           SELECT id FROM clients
           WHERE LOWER(email) = LOWER($2) AND account_user_id IS NULL
           ORDER BY date_added DESC LIMIT 1
         )`,
        [userId, inquiry.email]
      );
    }
    const { rows: projects } = await client.query(
      `INSERT INTO projects (project_name, client_name, client_email, client_user_id, status, start_date, budget)
       VALUES ($1, $2, $3, $4, 'Ongoing', CURRENT_DATE, $5) RETURNING *`,
      [projectName, inquiry.client_name, inquiry.email, userId, inquiry.project_budget]
    );
    await client.query(
      `INSERT INTO schedules (title, project_name, client_email, client_user_id, scheduled_date, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'Upcoming', $6)`,
      [`Initial Schedule - ${projectName}`, projectName, inquiry.email, userId, inquiry.meeting_date || new Date(Date.now() + 7 * 86400000), inquiry.meeting_notes]
    );
    await client.query(
      `INSERT INTO billings (client_name, project_name, client_email, client_user_id, amount, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'Pending', $6)`,
      [inquiry.client_name, projectName, inquiry.email, userId, inquiry.advance_payment_amount, `Advance Payment (${inquiry.advance_payment_percent}%) - Method: ${inquiry.payment_method}`]
    );
    const { rows: updated } = await client.query(
      `UPDATE inquiries SET status = 'Accepted', client_user_id = $1 WHERE id = $2 RETURNING *`,
      [userId, id]
    );
    return { inquiry: updated[0], project: projects[0] };
  });
  if (!data) return res.status(404).json({ error: 'Inquiry not found.' });
  let emailSent = true;
  try {
    await sendInquiryUpdate({
      to: data.inquiry.email,
      name: data.inquiry.client_name,
      subject: 'AlphaVerse Construction — Inquiry Accepted',
      lines: [`Your inquiry has been accepted.`, `Project: ${data.project.project_name}`, 'Our team will contact you about next steps.']
    });
  } catch (error) {
    emailSent = false;
    console.error('Inquiry acceptance was saved but the email was not sent:', error.message);
  }
  res.json({ ...data, emailSent });
});

app.post('/api/admin/inquiries/:id/reject', async (req, res) => {
  const id = positiveId(req.params.id);
  const reason = text(req.body.reason, 'Rejection reason', { max: 2000 });
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM inquiries WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return null;
    if (['Accepted', 'Rejected'].includes(rows[0].status)) {
      throw Object.assign(new Error('This inquiry has already been closed.'), { status: 409 });
    }
    const { rows: updated } = await client.query(
      `UPDATE inquiries SET status = 'Rejected', rejection_reason = $1 WHERE id = $2 RETURNING *`,
      [reason, id]
    );
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'Inquiry not found.' });
  let emailSent = true;
  try {
    await sendInquiryUpdate({
      to: result.email,
      name: result.client_name,
      subject: 'AlphaVerse Construction — Inquiry Update',
      lines: [reason || 'We are unable to proceed with this inquiry at this time.']
    });
  } catch (error) {
    emailSent = false;
    console.error('Inquiry rejection was saved but the email was not sent:', error.message);
  }
  res.json({ item: result, emailSent });
});

app.patch('/api/admin/:resource/:id', async (req, res) => {
  const resource = resources[req.params.resource];
  if (!resource || req.params.resource === 'admin-requests') {
    return res.status(404).json({ error: 'Unknown data resource.' });
  }
  const id = positiveId(req.params.id);
  for (const field of resource.required) {
    if (Object.hasOwn(req.body, field) && !String(req.body[field] ?? '').trim()) {
      return res.status(400).json({ error: `${field} cannot be empty.` });
    }
  }
  const columns = [];
  const values = [];
  for (const [field, column] of Object.entries(resource.fields)) {
    if (Object.hasOwn(req.body, field)) {
      const value = normalizeResourceValue(req.params.resource, field, req.body[field], {
        required: resource.required.includes(field)
      });
      if (value === null && ['startDate', 'scheduledDate'].includes(field)) {
        return res.status(400).json({ error: `${field} cannot be empty.` });
      }
      columns.push(`"${column}" = $${values.length + 1}`);
      values.push(value);
    }
  }
  if (['projects', 'schedules', 'billings'].includes(req.params.resource) && Object.hasOwn(req.body, 'clientEmail')) {
    columns.push(`"client_user_id" = $${values.length + 1}`);
    values.push(await findActiveClientId(normalizeResourceValue(req.params.resource, 'clientEmail', req.body.clientEmail)));
  } else if (req.params.resource === 'clients' && Object.hasOwn(req.body, 'email')) {
    columns.push(`"account_user_id" = $${values.length + 1}`);
    values.push(await findActiveClientId(normalizeResourceValue(req.params.resource, 'email', req.body.email)));
  }
  if (!columns.length) return res.status(400).json({ error: 'Provide at least one valid field to update.' });
  values.push(id);
  const { rows } = await getPool().query(
    `UPDATE ${resource.table} SET ${columns.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
  res.json({ item: rows[0] });
});

app.delete('/api/admin/:resource/:id', async (req, res) => {
  const resource = resources[req.params.resource];
  if (!resource || req.params.resource === 'admin-requests') {
    return res.status(404).json({ error: 'Unknown data resource.' });
  }
  const id = positiveId(req.params.id);
  const { rowCount } = await getPool().query(
    `DELETE FROM ${resource.table} WHERE id = $1`,
    [id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Record not found.' });
  res.status(204).end();
});

app.get('/api/settings', authenticate, (req, res) => {
  const { id, full_name, email, contact_number, role } = req.user;
  res.json({ user: { id, fullName: full_name, email, contactNumber: contact_number, role } });
});

app.patch('/api/settings/email', authenticate, async (req, res) => {
  const email = emailAddress(req.body.email);
  const password = text(req.body.password, 'Current password', { required: true, max: 128 });
  const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  try {
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2',
        [email, req.user.id]
      );
      await client.query('UPDATE clients SET email = $1 WHERE account_user_id = $2', [email, req.user.id]);
      for (const table of ['projects', 'schedules', 'billings']) {
        await client.query(`UPDATE ${table} SET client_email = $1 WHERE client_user_id = $2`, [email, req.user.id]);
      }
      await client.query('UPDATE inquiries SET email = $1 WHERE client_user_id = $2', [email, req.user.id]);
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email address is already in use.' });
    throw error;
  }
  res.json({ message: 'Email address updated.' });
});

app.patch('/api/settings/password', authenticate, async (req, res) => {
  const currentPassword = text(req.body.currentPassword, 'Current password', { required: true, max: 128 });
  const newPassword = text(req.body.newPassword, 'New password', { required: true, max: 128 });
  if (newPassword.length < 8 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters and include upper-case, lower-case, and a number.' });
  }
  const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const { rows: updated } = await getPool().query(
    'UPDATE users SET password_hash = $1, session_version = session_version + 1, updated_at = NOW() WHERE id = $2 RETURNING session_version',
    [passwordHash, req.user.id]
  );
  setSessionCookie(res, { ...req.user, session_version: updated[0].session_version });
  res.json({ message: 'Password updated.' });
});

app.get('/api/backup', authenticate, requireAdmin, async (req, res) => {
  const pool = getPool();
  const backup = {};
  for (const [name, resource] of Object.entries(resources)) {
    const { rows } = await pool.query(`SELECT * FROM ${resource.table} ORDER BY ${resource.order}`);
    backup[name] = rows;
  }
  res.setHeader('Content-Disposition', 'attachment; filename="alphaverse-backup.json"');
  res.type('application/json').send(JSON.stringify(backup, null, 2));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.get('*path', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const databaseInputErrors = new Set(['23503', '23514', '22P02', '22007', '22003']);
  const status = Number.isInteger(error.status)
    ? error.status
    : error.code === '23505' ? 409
      : databaseInputErrors.has(error.code) ? 400
        : 500;
  if (status >= 500) console.error('Request failed:', error);
  res.status(status).json({
    error: status >= 500
      ? 'The request could not be completed. Check server logs for details.'
      : error.code === '23505' ? 'A record with those details already exists.'
        : databaseInputErrors.has(error.code) ? 'The submitted data is invalid.'
          : error.message
  });
});

async function seedAdministrator() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
  const passwordHash = await bcrypt.hash(password, 12);
  const { rowCount } = await getPool().query(
    `INSERT INTO users (full_name, email, password_hash, role, status)
     VALUES ('AlphaVerse Administrator', $1, $2, 'admin', 'active')
     ON CONFLICT (LOWER(email)) DO NOTHING`,
    [email, passwordHash]
  );
  if (rowCount) console.log(`Initial administrator account created for ${email}.`);
}

module.exports = { app, seedAdministrator };
