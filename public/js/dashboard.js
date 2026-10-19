const navItems = [
  ['dashboard', 'Dashboard'],
  ['inquiries', 'Inquiries'],
  ['projects', 'Projects'],
  ['schedules', 'Scheduling'],
  ['billings', 'Billing'],
  ['reports', 'Reports'],
  ['clients', 'Clients'],
  ['settings', 'Settings'],
  ['admin-requests', 'Admin requests']
];

const definitions = {
  inquiries: {
    title: 'Inquiries',
    fields: [
      ['clientName', 'Client name', 'text', true], ['email', 'Email', 'email', true],
      ['contactNumber', 'Contact number', 'tel'], ['projectType', 'Project type', 'text'],
      ['message', 'Message', 'textarea'],
      ['paymentMethod', 'Payment method', 'text'], ['paymentStatus', 'Payment status', 'text']
    ],
    columns: [['client_name', 'Client'], ['email', 'Email'], ['project_type', 'Project'], ['status', 'Status'], ['date_submitted', 'Received']],
    actions: 'inquiries'
  },
  projects: {
    title: 'Projects',
    fields: [
      ['projectName', 'Project name', 'text', true], ['clientName', 'Client', 'text'],
      ['clientEmail', 'Client account email', 'email'],
      ['location', 'Location', 'text'], ['budget', 'Budget (₱)', 'number'],
      ['startDate', 'Start date', 'date'], ['endDate', 'End date', 'date'],
      ['status', 'Status', 'select', false, ['Ongoing', 'Completed', 'On Hold', 'Cancelled']]
    ],
    columns: [['project_name', 'Project'], ['client_name', 'Client'], ['location', 'Location'], ['budget', 'Budget'], ['start_date', 'Start date'], ['status', 'Status']]
  },
  schedules: {
    title: 'Scheduling',
    fields: [
      ['title', 'Title', 'text', true], ['projectName', 'Project', 'text'],
      ['clientEmail', 'Client account email', 'email'],
      ['assignedTo', 'Assigned to', 'text'], ['scheduledDate', 'Date and time', 'datetime-local'],
      ['status', 'Status', 'select', false, ['Upcoming', 'Completed', 'Cancelled']],
      ['notes', 'Notes', 'textarea']
    ],
    columns: [['title', 'Title'], ['project_name', 'Project'], ['assigned_to', 'Assigned to'], ['scheduled_date', 'Date'], ['status', 'Status']]
  },
  billings: {
    title: 'Billing',
    fields: [
      ['clientName', 'Client name', 'text', true], ['projectName', 'Project', 'text'],
      ['clientEmail', 'Client account email', 'email'],
      ['amount', 'Amount (₱)', 'number'], ['dueDate', 'Due date', 'date'],
      ['status', 'Status', 'select', false, ['Pending', 'Paid', 'Overdue', 'Cancelled']],
      ['notes', 'Notes', 'textarea']
    ],
    columns: [['client_name', 'Client'], ['project_name', 'Project'], ['amount', 'Amount'], ['billing_date', 'Billed'], ['due_date', 'Due'], ['status', 'Status']]
  },
  clients: {
    title: 'Clients',
    fields: [
      ['fullName', 'Full name', 'text', true], ['email', 'Email', 'email'],
      ['contactNumber', 'Contact number', 'tel'], ['address', 'Address', 'textarea']
    ],
    columns: [['full_name', 'Name'], ['email', 'Email'], ['contact_number', 'Contact'], ['address', 'Address'], ['date_added', 'Added']]
  },
  'admin-requests': {
    title: 'Administrator requests',
    fields: [],
    columns: [['email', 'Email'], ['status', 'Status'], ['request_date', 'Requested']],
    actions: 'admin-requests'
  }
};

let activeUser;
let lastTable;
const panel = document.querySelector('#dashboard-panel');
const nav = document.querySelector('#dashboard-nav');
const messageBox = document.querySelector('#dashboard-message');
const dialog = document.querySelector('#record-dialog');
const dialogContent = document.querySelector('#dialog-content');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function display(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const date = new Date(value);
  if (typeof value === 'string' && !Number.isNaN(date.getTime()) && /^\d{4}-\d\d-\d\d/.test(value)) {
    return date.toLocaleDateString();
  }
  return String(value);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || 'Request failed.');
  return result;
}

function notify(text, kind = 'success') {
  messageBox.textContent = text;
  messageBox.className = `form-message ${kind}`;
  window.setTimeout(() => { messageBox.textContent = ''; messageBox.className = 'form-message'; }, 7000);
}

function navMarkup(role, selected) {
  const visibleItems = role === 'admin'
    ? navItems
    : [
        ['client', 'Dashboard'],
        ['client-projects', 'My projects'],
        ['client-schedules', 'Scheduling'],
        ['client-billings', 'Billing'],
        ['client-inquiries', 'Inquiries'],
        ['settings', 'Settings']
      ];
  nav.innerHTML = visibleItems.map(([slug, title]) =>
    `<a href="#${slug}"${selected === slug ? ' aria-current="page"' : ''}>${escapeHtml(title.toUpperCase())}</a>`
  ).join('');
}

function money(value) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value) || 0);
}

function statusClassName(status = '') {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (!normalized) return 'neutral';
  if (/(rejected|cancelled|declined|denied)/.test(normalized)) return 'rejected';
  if (/(pending|new|upcoming|meeting set|discussed|on hold)/.test(normalized)) return 'pending';
  if (/(completed|accepted|approved|paid|ongoing|done)/.test(normalized)) return 'completed';
  return 'neutral';
}

function metric(label, value) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function tableMarkup(columns, items, { actions = false } = {}) {
  if (!items.length) return '<div class="empty-state">No records to show yet.</div>';
  const headers = columns.map(([, title]) => `<th>${escapeHtml(title)}</th>`).join('');
  const rows = items.map((item) => `<tr data-id="${escapeHtml(item.id)}">
    ${columns.map(([key]) => `<td>${key === 'status'
      ? `<span class="status-pill ${statusClassName(item[key])}">${escapeHtml(item[key])}</span>`
      : escapeHtml(display(item[key]))}</td>`).join('')}
    ${actions ? `<td>${actionButtons(item)}</td>` : ''}
  </tr>`).join('');
  const actionHeader = actions ? '<th>Actions</th>' : '';
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers}${actionHeader}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function actionButtons(item) {
  if (item.status === 'Pending' && item.user_id && item.request_date) {
    return `<div class="table-action-row"><button class="mini-button" data-action="approve-admin">Approve</button><button class="mini-button danger" data-action="reject-admin">Reject</button></div>`;
  }
  const actions = [];
  if (item.status === 'New' || item.status === 'Pending') actions.push('<button class="mini-button" data-action="meeting">Set meeting</button>');
  if (item.status === 'Meeting Set' || item.status === 'Pending') actions.push('<button class="mini-button" data-action="discussed">Discussed</button>');
  if (item.status === 'Discussed') {
    actions.push('<button class="mini-button" data-action="accept">Accept</button>');
    actions.push('<button class="mini-button danger" data-action="reject">Reject</button>');
  }
  if (item.status !== 'Accepted' && item.status !== 'Rejected') actions.push('<button class="mini-button" data-action="edit">Edit</button>');
  actions.push('<button class="mini-button danger" data-action="delete">Delete</button>');
  return `<div class="table-action-row">${actions.join('')}</div>`;
}

function inputMarkup([name, label, type, required, options]) {
  const req = required ? ' required' : '';
  const id = `field-${name}`;
  if (type === 'textarea') return `<label for="${id}">${escapeHtml(label)}<textarea class="field-input" id="${id}" name="${name}" rows="3"${req}></textarea></label>`;
  if (type === 'select') {
    return `<label for="${id}">${escapeHtml(label)}<select class="field-input" id="${id}" name="${name}"${req}>${options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  return `<label for="${id}">${escapeHtml(label)}<input class="field-input" id="${id}" name="${name}" type="${type}"${type === 'number' ? ' min="0" step="0.01"' : ''}${req}></label>`;
}

function openForm({ title, fields, action, id }) {
  dialogContent.innerHTML = `<h2>${escapeHtml(title)}</h2><form id="record-form" data-resource="${escapeHtml(action)}" ${id ? `data-record-id="${escapeHtml(id)}"` : ''}>
    <div class="dashboard-form-grid">${fields.map(inputMarkup).join('')}</div>
    <div class="button-row"><button class="button button-primary" type="submit">Save</button><button class="button button-outline" type="button" data-action="close-dialog">Cancel</button></div>
  </form>`;
  dialog.showModal();
}

async function renderDashboard() {
  const data = await api('/api/admin/dashboard');
  panel.innerHTML = `<h1>Dashboard</h1><p class="dashboard-subtitle">Your project and business overview.</p>
    <div class="metric-grid">
      ${metric('New inquiries', data.newInquiries)}
      ${metric('Ongoing projects', data.ongoingProjects)}
      ${metric('Pending quotations', data.pendingQuotations)}
      ${metric('Open billing', data.pendingBills)}
      ${metric('Revenue received', money(data.totalRevenue))}
      ${metric('Revenue pending', money(data.pendingRevenue))}
      ${metric('Admin requests', data.pendingAdminRequests)}
    </div>
    <div class="dashboard-grid">
      <section class="panel-card"><h2>Recent inquiries</h2>${tableMarkup([['client_name', 'Client'], ['project_type', 'Project'], ['status', 'Status']], data.recentInquiries)}</section>
      <section class="panel-card"><h2>Upcoming schedule</h2>${tableMarkup([['title', 'Title'], ['project_name', 'Project'], ['scheduled_date', 'Date']], data.upcomingSchedules)}</section>
      <section class="panel-card"><h2>Recently completed</h2>${tableMarkup([['project_name', 'Project'], ['client_name', 'Client'], ['end_date', 'End date']], data.completedProjects)}</section>
    </div>`;
}

async function renderResource(resourceName) {
  if (resourceName === 'reports') return renderReports();
  if (resourceName === 'settings') return renderSettings();
  const definition = definitions[resourceName];
  const { items } = await api(`/api/admin/${resourceName}`);
  lastTable = items;
  const allowCreate = resourceName !== 'admin-requests';
  const filters = resourceName === 'inquiries'
    ? `<select id="status-filter" class="filter-select"><option value="">All statuses</option>${['New', 'Meeting Set', 'Pending', 'Discussed', 'Accepted', 'Rejected'].map((status) => `<option>${status}</option>`).join('')}</select>`
    : '';
  panel.innerHTML = `<div class="dashboard-toolbar"><div><h1>${escapeHtml(definition.title)}</h1><p class="dashboard-subtitle">${items.length} record${items.length === 1 ? '' : 's'}</p></div><div class="button-row">${filters}${allowCreate ? '<button class="button button-primary" data-action="create">+ Add new</button>' : ''}</div></div>
    <div id="resource-table">${tableMarkup(definition.columns, items, { actions: true })}</div>`;
}

async function renderReports() {
  const report = await api('/api/admin/reports');
  panel.innerHTML = `<h1>Reports</h1><p class="dashboard-subtitle">An at-a-glance summary of activity and finances.</p>
    <div class="metric-grid">
      ${metric('Total inquiries', report.totalInquiries)}${metric('New inquiries', report.newInquiries)}
      ${metric('Total projects', report.totalProjects)}${metric('Ongoing projects', report.ongoingProjects)}
      ${metric('Completed projects', report.completedProjects)}${metric('Schedules', report.totalSchedules)}
      ${metric('Upcoming schedules', report.upcomingSchedules)}${metric('Clients', report.totalClients)}
      ${metric('Paid billing', money(report.totalPaid))}${metric('Pending billing', money(report.totalPending))}
    </div>
    <div class="dashboard-grid">
      <section class="panel-card"><h2>Recent billing</h2>${tableMarkup([['client_name', 'Client'], ['project_name', 'Project'], ['amount', 'Amount'], ['status', 'Status']], report.recentBillings)}</section>
      <section class="panel-card"><h2>Recent projects</h2>${tableMarkup([['project_name', 'Project'], ['client_name', 'Client'], ['start_date', 'Start date'], ['status', 'Status']], report.recentProjects)}</section>
    </div>`;
}

async function renderSettings() {
  const { user } = await api('/api/settings');
  panel.innerHTML = `<h1>Account settings</h1><p class="dashboard-subtitle">Manage your sign-in details.</p>
    <section class="panel-card dashboard-form"><h2>Change email</h2><form id="email-form" class="form-card">
      <label>Email address<input class="field-input" type="email" name="email" required value="${escapeHtml(user.email)}"></label>
      <label>Current password<input class="field-input" type="password" name="password" required autocomplete="current-password"></label>
      <button class="button button-primary" type="submit">Update email</button>
    </form></section>
    <section class="panel-card dashboard-form"><h2>Change password</h2><form id="password-form" class="form-card">
      <label>Current password<input class="field-input" type="password" name="currentPassword" required autocomplete="current-password"></label>
      <label>New password<input class="field-input" type="password" name="newPassword" minlength="8" required autocomplete="new-password"></label>
      <label>Confirm new password<input class="field-input" type="password" name="confirmPassword" minlength="8" required autocomplete="new-password"></label>
      <button class="button button-primary" type="submit">Update password</button>
    </form></section>`;
}

function renderClientRecords(data, section) {
  const recordSections = {
    'client-projects': {
      title: 'My projects',
      description: 'Your construction projects and their current status.',
      records: data.projects,
      columns: [['project_name', 'Project'], ['location', 'Location'], ['status', 'Status'], ['start_date', 'Start date'], ['end_date', 'End date']]
    },
    'client-schedules': {
      title: 'Scheduling',
      description: 'Upcoming appointments and project schedule updates.',
      records: data.schedules,
      columns: [['title', 'Title'], ['project_name', 'Project'], ['assigned_to', 'Assigned to'], ['scheduled_date', 'Date'], ['status', 'Status']]
    },
    'client-billings': {
      title: 'Billing',
      description: 'Invoices and payment updates for your projects.',
      records: data.billings,
      columns: [['project_name', 'Project'], ['amount', 'Amount'], ['billing_date', 'Billed'], ['due_date', 'Due'], ['status', 'Status']]
    },
    'client-inquiries': {
      title: 'Inquiries',
      description: 'Updates on inquiries submitted to AlphaVerse.',
      records: data.inquiries,
      columns: [['project_type', 'Project'], ['date_submitted', 'Submitted'], ['status', 'Status'], ['message', 'Details']]
    }
  };
  const recordSection = recordSections[section];

  panel.innerHTML = `<h1>${escapeHtml(recordSection.title)}</h1>
    <p class="dashboard-subtitle">${escapeHtml(recordSection.description)}</p>
    <section class="panel-card client-records">${tableMarkup(recordSection.columns, recordSection.records)}</section>`;
}

async function renderClient(section = 'client') {
  const data = await api('/api/client/summary');
  if (section !== 'client') {
    return renderClientRecords(data, section);
  }

  const greetingName = activeUser.fullName.split(' ')[0];
  panel.innerHTML = `<h1>Welcome, ${escapeHtml(greetingName)}</h1><p class="dashboard-subtitle">Your project updates and account information.</p>
    <div class="metric-grid">${metric('Projects', data.projects.length)}${metric('Schedules', data.schedules.length)}${metric('Open invoices', data.billings.filter((item) => item.status === 'Pending').length)}${metric('Inquiries', data.inquiries.length)}</div>
    <div class="dashboard-grid client-overview-grid">
      <section class="panel-card"><h2>Your projects</h2>${tableMarkup([['project_name', 'Project'], ['location', 'Location'], ['status', 'Status'], ['start_date', 'Start date']], data.projects.slice(0, 3))}<a class="client-view-link" href="#client-projects">View all projects →</a></section>
      <section class="panel-card"><h2>Billing updates</h2>${tableMarkup([['project_name', 'Project'], ['amount', 'Amount'], ['due_date', 'Due'], ['status', 'Status']], data.billings.slice(0, 3))}<a class="client-view-link" href="#client-billings">View billing →</a></section>
      <section class="panel-card"><h2>Upcoming schedule</h2>${tableMarkup([['title', 'Title'], ['project_name', 'Project'], ['scheduled_date', 'Date'], ['status', 'Status']], data.schedules.slice(0, 3))}<a class="client-view-link" href="#client-schedules">View schedule →</a></section>
      <section class="panel-card"><h2>Your inquiries</h2>${tableMarkup([['project_type', 'Project'], ['date_submitted', 'Submitted'], ['status', 'Status']], data.inquiries.slice(0, 3))}<a class="client-view-link" href="#client-inquiries">View inquiries →</a></section>
    </div>`;
}

async function renderPage() {
  const hash = location.hash.replace('#', '') || 'dashboard';
  const clientPages = ['client', 'client-projects', 'client-schedules', 'client-billings', 'client-inquiries', 'settings'];
  const page = activeUser.role === 'admin'
    ? (hash === 'client' ? 'dashboard' : hash)
    : clientPages.includes(hash)
      ? hash
      : 'client';
  navMarkup(activeUser.role, page);
  if (activeUser.role === 'admin') {
    return page === 'dashboard' ? renderDashboard() : renderResource(page);
  }
  return page === 'settings' ? renderSettings() : renderClient(page);
}

document.querySelector('#dashboard-nav')?.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    event.preventDefault();
    location.hash = event.target.closest('a').hash;
  }
});

window.addEventListener('hashchange', () => renderPage().catch((error) => notify(error.message, 'error')));

panel?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const resourceName = location.hash.slice(1) || 'dashboard';
  const definition = definitions[resourceName];
  const row = button.closest('tr');
  const id = row?.dataset.id;
  try {
    if (action === 'create') {
      openForm({ title: `Add ${definition.title.toLowerCase()}`, fields: definition.fields, action: resourceName });
      return;
    }
    if (action === 'close-dialog') return dialog.close();
    if (!id) return;
    if (action === 'delete') {
      if (!confirm('Delete this record? This cannot be undone.')) return;
      await api(`/api/admin/${resourceName}/${id}`, { method: 'DELETE' });
      notify('Record deleted.');
    } else if (action === 'meeting') {
      openForm({
        title: 'Schedule a meeting',
        fields: [
          ['meetingDate', 'Meeting date and time', 'datetime-local', true],
          ['projectBudget', 'Project budget (₱)', 'number'],
          ['advancePaymentPercent', 'Advance payment percent', 'number'],
          ['meetingNotes', 'Meeting notes', 'textarea']
        ],
        action: 'meeting',
        id
      });
    } else if (action === 'accept') {
      if (!confirm('Accept this inquiry and create a project, schedule, billing entry, and client record?')) return;
      const response = await api(`/api/admin/inquiries/${id}/accept`, { method: 'POST', body: '{}' });
      notify(response.emailSent ? 'Inquiry accepted and project records created.' : 'Inquiry accepted and project records created, but the email could not be sent.');
    } else if (action === 'reject') {
      const reason = prompt('Optional reason to include in the email:');
      if (reason === null) return;
      const response = await api(`/api/admin/inquiries/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      notify(response.emailSent ? 'Inquiry rejected and client notified.' : 'Inquiry rejected, but the email could not be sent.');
    } else if (action === 'discussed') {
      await api(`/api/admin/inquiries/${id}/discussed`, { method: 'POST', body: '{}' });
      notify('Inquiry marked as discussed.');
    } else if (action === 'approve-admin' || action === 'reject-admin') {
      const status = action === 'approve-admin' ? 'Approved' : 'Rejected';
      if (!confirm(`${status} this administrator access request?`)) return;
      await api(`/api/admin/admin-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify(`Administrator request ${status.toLowerCase()}.`);
    } else if (action === 'edit') {
      const item = lastTable.find((entry) => String(entry.id) === id);
      openForm({
        title: `Edit ${definition.title.toLowerCase()}`,
        fields: definition.fields,
        action: resourceName,
        id
      });
      const form = dialog.querySelector('#record-form');
      for (const [field] of definition.fields) {
        const input = form.elements.namedItem(field);
        const key = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
        if (input && item[key] !== undefined && item[key] !== null) {
          input.value = field.toLowerCase().includes('date')
            ? (field === 'scheduledDate' ? new Date(item[key]).toISOString().slice(0, 16) : String(item[key]).slice(0, 10))
            : item[key];
        }
      }
    }
    if (action !== 'meeting' && action !== 'edit') await renderPage();
  } catch (error) {
    notify(error.message, 'error');
  }
});

panel?.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'email-form') {
      await api('/api/settings/email', { method: 'PATCH', body: JSON.stringify(values) });
      notify('Email address updated.');
      await renderPage();
      return;
    }
    if (form.id === 'password-form') {
      if (values.newPassword !== values.confirmPassword) throw new Error('New passwords do not match.');
      delete values.confirmPassword;
      await api('/api/settings/password', { method: 'PATCH', body: JSON.stringify(values) });
      notify('Password updated.');
      await renderPage();
      return;
    }
    notify('The form could not be submitted.', 'error');
  } catch (error) {
    notify(error.message, 'error');
  }
});

dialogContent?.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-dialog"]')) dialog.close();
});

dialogContent?.addEventListener('submit', async (event) => {
  const form = event.target.closest('#record-form');
  if (!form) return;
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  for (const key of ['budget', 'amount', 'projectBudget', 'advancePaymentPercent']) {
    if (key in body) body[key] = Number(body[key] || 0);
  }
  for (const key of ['startDate', 'endDate', 'dueDate', 'meetingDate']) {
    if (key in body && !body[key]) body[key] = null;
  }
  const resource = form.dataset.resource;
  const id = form.dataset.recordId;
  try {
    if (resource === 'meeting') {
      const response = await api(`/api/admin/inquiries/${id}/meeting`, { method: 'PATCH', body: JSON.stringify(body) });
      notify(response.emailSent ? 'Meeting scheduled and client notified.' : 'Meeting scheduled, but the email could not be sent.');
    } else {
      await api(id ? `/api/admin/${resource}/${id}` : `/api/admin/${resource}`, {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(body)
      });
      notify(id ? 'Record updated.' : 'Record created.');
    }
    dialog.close();
    await renderPage();
  } catch (error) {
    notify(error.message, 'error');
  }
});

panel?.addEventListener('change', async (event) => {
  if (event.target.id === 'status-filter') {
    const status = event.target.value;
    const { items } = await api('/api/admin/inquiries');
    const filtered = status ? items.filter((item) => item.status === status) : items;
    panel.querySelector('#resource-table').innerHTML = tableMarkup(definitions.inquiries.columns, filtered, { actions: true });
    return;
  }
});

document.querySelector('#export-button')?.addEventListener('click', () => {
  if (!lastTable?.length) {
    notify('There are no records to export.', 'error');
    return;
  }
  const headers = Object.keys(lastTable[0]);
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.map(quote).join(','), ...lastTable.map((item) => headers.map((key) => quote(item[key])).join(','))].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `${(location.hash.slice(1) || 'dashboard')}-export.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});

document.querySelector('#logout-button')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    location.href = '/login.html';
  }
});

async function initializeDashboard() {
  try {
    const { user } = await api('/api/auth/me');
    activeUser = user;
    document.querySelector('#account-name').textContent = user.fullName;
    document.querySelector('#backup-link').hidden = user.role !== 'admin';
    document.querySelector('#export-button').hidden = user.role !== 'admin';
    await renderPage();
  } catch {
    location.replace('/login.html');
  }
}

initializeDashboard();
