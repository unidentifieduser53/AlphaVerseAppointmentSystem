CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    contact_number TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'pending_verification', 'pending_approval')),
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS registration_codes (
    email TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    contact_number TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    requested_role TEXT NOT NULL CHECK (requested_role IN ('admin', 'client')),
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    request_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inquiries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_name TEXT NOT NULL,
    contact_number TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    project_type TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'New',
    date_submitted TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meeting_date TIMESTAMPTZ,
    meeting_notes TEXT NOT NULL DEFAULT '',
    advance_payment_percent NUMERIC(7, 2) NOT NULL DEFAULT 0,
    project_budget NUMERIC(14, 2) NOT NULL DEFAULT 0,
    advance_payment_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT '',
    payment_status TEXT NOT NULL DEFAULT 'Unpaid',
    rejection_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS projects (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_name TEXT NOT NULL,
    client_name TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL DEFAULT '',
    client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Ongoing',
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    budget NUMERIC(14, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schedules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL DEFAULT '',
    client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    assigned_to TEXT NOT NULL DEFAULT '',
    scheduled_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'Upcoming',
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS billings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_name TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL DEFAULT '',
    client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Pending',
    billing_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_date DATE,
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clients (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    account_user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    contact_number TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    date_added TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_email TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS client_email TEXT NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE billings ADD COLUMN IF NOT EXISTS client_email TEXT NOT NULL DEFAULT '';
ALTER TABLE billings ADD COLUMN IF NOT EXISTS client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS client_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inquiries_submitted_idx ON inquiries (date_submitted DESC);
CREATE INDEX IF NOT EXISTS projects_start_date_idx ON projects (start_date DESC);
CREATE INDEX IF NOT EXISTS schedules_date_idx ON schedules (scheduled_date);
CREATE INDEX IF NOT EXISTS billings_date_idx ON billings (billing_date DESC);
CREATE INDEX IF NOT EXISTS admin_requests_status_idx ON admin_requests (status);
CREATE INDEX IF NOT EXISTS projects_client_user_idx ON projects (client_user_id);
CREATE INDEX IF NOT EXISTS inquiries_client_user_idx ON inquiries (client_user_id);
CREATE INDEX IF NOT EXISTS schedules_client_user_idx ON schedules (client_user_id);
CREATE INDEX IF NOT EXISTS billings_client_user_idx ON billings (client_user_id);
