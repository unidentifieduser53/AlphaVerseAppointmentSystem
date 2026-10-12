const { Resend } = require('resend');

let resendClient;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured.');
  }
  if (!process.env.EMAIL_FROM) {
    throw new Error('EMAIL_FROM is not configured.');
  }
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

async function sendEmail({ to, subject, html }) {
  const { data, error } = await getResend().emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html
  });
  if (error) throw new Error(`Resend email delivery failed: ${error.message}`);
  return data;
}

function emailFrame(content) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;color:#2c1a00">
    <header style="background:#bd5900;padding:22px;color:#fff"><strong>AlphaVerse Construction</strong></header>
    <main style="background:#f5f0e8;padding:28px">${content}</main>
  </div>`;
}

async function sendVerificationCode(to, name, code) {
  return sendEmail({
    to,
    subject: 'AlphaVerse Construction — Verify your email',
    html: emailFrame(`<p>Hello ${escapeHtml(name)},</p>
      <p>Your verification code is:</p>
      <p style="font-size:30px;font-weight:bold;letter-spacing:8px">${escapeHtml(code)}</p>
      <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`)
  });
}

async function sendPasswordResetCode(to, name, code) {
  return sendEmail({
    to,
    subject: 'AlphaVerse Construction — Reset your password',
    html: emailFrame(`<p>Hello ${escapeHtml(name)},</p>
      <p>Your password reset code is:</p>
      <p style="font-size:30px;font-weight:bold;letter-spacing:8px">${escapeHtml(code)}</p>
      <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`)
  });
}

async function sendInquiryNotice(inquiry) {
  const to = process.env.INQUIRY_NOTIFICATION_EMAIL;
  if (!to) throw new Error('INQUIRY_NOTIFICATION_EMAIL is not configured.');
  return sendEmail({
    to,
    subject: `New inquiry from ${inquiry.clientName}`,
    html: emailFrame(`<p>A new inquiry was submitted.</p>
      <p><strong>Name:</strong> ${escapeHtml(inquiry.clientName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(inquiry.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(inquiry.contactNumber)}</p>
      <p><strong>Project type:</strong> ${escapeHtml(inquiry.projectType)}</p>
      <p><strong>Message:</strong><br>${escapeHtml(inquiry.message).replace(/\n/g, '<br>')}</p>`)
  });
}

async function sendInquiryUpdate({ to, name, subject, lines }) {
  return sendEmail({
    to,
    subject,
    html: emailFrame(`<p>Hello ${escapeHtml(name)},</p>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}`)
  });
}

module.exports = { sendEmail, sendInquiryNotice, sendInquiryUpdate, sendPasswordResetCode, sendVerificationCode };
