async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || 'The request could not be completed.');
  return body;
}

function showFormMessage(form, message, kind = 'error') {
  const element = form.querySelector('.form-message');
  if (!element) return;
  element.textContent = message;
  element.className = `form-message ${kind}`;
}

document.querySelector('.menu-toggle')?.addEventListener('click', (event) => {
  const button = event.currentTarget;
  const nav = document.querySelector('.site-nav');
  const isOpen = nav.classList.toggle('is-open');
  button.setAttribute('aria-expanded', String(isOpen));
});

document.querySelectorAll('.gallery-thumbs button').forEach((button) => {
  button.addEventListener('click', () => {
    const gallery = button.closest('.project-gallery');
    const main = gallery.querySelector('.gallery-main');
    main.src = button.dataset.image;
    gallery.querySelectorAll('.gallery-thumbs button').forEach((thumb) => thumb.classList.remove('active'));
    button.classList.add('active');
  });
});

document.querySelector('#inquiry-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await apiRequest('/api/inquiries', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    const message = result.emailNotified
      ? 'Thank you. Your inquiry has been received, and our team will be in touch.'
      : 'Your inquiry has been saved. Our email notification is delayed, but the team can still review it.';
    showFormMessage(form, message, 'success');
    form.reset();
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#register-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await apiRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    location.href = `/verify.html?email=${encodeURIComponent(values.email)}`;
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#verify-email')?.setAttribute(
  'value',
  new URLSearchParams(location.search).get('email') || ''
);

document.querySelector('#verify-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await apiRequest('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    if (result.user.status === 'active') {
      location.href = '/dashboard.html';
    } else {
      location.href = `/login.html?notice=${encodeURIComponent(result.message)}`;
    }
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#resend-verification')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const form = document.querySelector('#verify-form');
  const email = form.elements.namedItem('email').value;
  if (!email || !form.elements.namedItem('email').reportValidity()) return;
  button.disabled = true;
  try {
    const result = await apiRequest('/api/auth/register/resend-code', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    showFormMessage(form, result.message, 'success');
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    button.disabled = false;
  }
});

const loginForm = document.querySelector('#login-form');
if (loginForm) {
  const notice = new URLSearchParams(location.search).get('notice');
  if (notice) showFormMessage(loginForm, notice, 'success');
}

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    location.href = '/dashboard.html';
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

const resetRequestForm = document.querySelector('#password-reset-request');
resetRequestForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await apiRequest('/api/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    showFormMessage(form, result.message, 'success');
    document.querySelector('#password-reset-complete').hidden = false;
  } catch (error) {
    showFormMessage(form, error.message);
  } finally {
    submit.disabled = false;
  }
});

const resetCompleteForm = document.querySelector('#password-reset-complete');
resetCompleteForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    values.email = document.querySelector('#reset-email').value;
    await apiRequest('/api/auth/password-reset/complete', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    location.href = `/login.html?notice=${encodeURIComponent('Password reset successfully. Sign in with your new password.')}`;
  } catch (error) {
    showFormMessage(resetRequestForm, error.message);
  } finally {
    submit.disabled = false;
  }
});
