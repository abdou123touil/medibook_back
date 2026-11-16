const nodemailer = require('nodemailer');
const EmailReminder = require('../models/EmailReminder');

const smtpHost = process.env.SMTP_HOST;
const smtpUser = process.env.SMTP_USER;
const smtpPassword = process.env.SMTP_PASSWORD;
const smtpPort = Number.parseInt(process.env.SMTP_PORT || '587', 10);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const smtpFrom = process.env.SMTP_FROM || smtpUser;

const transporter = smtpHost && smtpUser && smtpPassword
  ? nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: smtpUser, pass: smtpPassword },
  })
  : null;

if (!transporter) {
  console.warn('SMTP is not configured; appointment email reminders are disabled.');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

async function sendAppointmentReminderEmail({ appointment, patient, doctor, reminderKey }) {
  if (!transporter || !smtpFrom || !patient?.email) return false;

  const reminder = await EmailReminder.findOneAndUpdate(
    { appointmentId: appointment._id, recipientId: patient._id, reminderKey },
    {
      $setOnInsert: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(0),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).catch(async (error) => {
    if (error.code !== 11000) throw error;
    return EmailReminder.findOne({ appointmentId: appointment._id, recipientId: patient._id, reminderKey });
  });

  if (!reminder || reminder.status === 'sent') return reminder?.status === 'sent';

  const now = new Date();
  const staleLock = new Date(now.getTime() - 10 * 60 * 1000);
  const claimed = await EmailReminder.findOneAndUpdate(
    {
      _id: reminder._id,
      $or: [
        { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now } },
        { status: 'sending', lockedAt: { $lte: staleLock } },
      ],
    },
    {
      $set: { status: 'sending', lockedAt: now, lastError: null },
      $inc: { attempts: 1 },
    },
    { new: true }
  );
  if (!claimed) return false;

  const date = appointment.date.toISOString().slice(0, 10);
  const timeUntil = reminderKey === '24h' ? 'demain' : 'dans environ deux heures';
  const doctorName = `Dr. ${doctor?.firstName || ''} ${doctor?.lastName || ''}`.trim();
  const patientName = patient.firstName || 'Patient';
  const subject = reminderKey === '24h' ? 'Rappel de votre rendez-vous demain' : 'Rappel de votre rendez-vous à venir';
  const text = [
    `Bonjour ${patientName},`,
    '',
    `Rappel : votre rendez-vous avec ${doctorName} est prévu ${timeUntil}, le ${date} à ${appointment.time}.`,
    '',
    'Vous recevez ce message automatiquement depuis MediBook.',
  ].join('\n');
  const html = `<p>Bonjour ${escapeHtml(patientName)},</p><p>Rappel : votre rendez-vous avec <strong>${escapeHtml(doctorName)}</strong> est prévu ${escapeHtml(timeUntil)}, le <strong>${escapeHtml(date)} à ${escapeHtml(appointment.time)}</strong>.</p><p>Vous recevez ce message automatiquement depuis MediBook.</p>`;

  try {
    await transporter.sendMail({ from: smtpFrom, to: patient.email, subject, text, html });
    await EmailReminder.updateOne(
      { _id: claimed._id, status: 'sending' },
      { $set: { status: 'sent', sentAt: new Date(), lockedAt: null, lastError: null } }
    );
    return true;
  } catch (error) {
    const retryDelayMs = Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.min(claimed.attempts, 5)));
    await EmailReminder.updateOne(
      { _id: claimed._id, status: 'sending' },
      {
        $set: {
          status: 'failed',
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + retryDelayMs),
          lastError: String(error.message || 'SMTP delivery failed').slice(0, 500),
        },
      }
    );
    console.error('Appointment reminder email failed:', error.message);
    return false;
  }
}

async function retryFailedAppointmentReminderEmails() {
  if (!transporter) return;
  const now = new Date();
  const staleLock = new Date(now.getTime() - 10 * 60 * 1000);
  const dueReminders = await EmailReminder.find({
    $or: [
      { status: 'failed', nextAttemptAt: { $lte: now } },
      { status: 'sending', lockedAt: { $lte: staleLock } },
    ],
  })
    .sort({ nextAttemptAt: 1 })
    .limit(50)
    .populate({
      path: 'appointmentId',
      select: 'status date time doctorId',
      populate: { path: 'doctorId', select: 'firstName lastName' },
    })
    .populate('recipientId', 'firstName email');

  for (const reminder of dueReminders) {
    const appointment = reminder.appointmentId;
    const patient = reminder.recipientId;
    if (!appointment || appointment.status !== 'accepted' || !patient?.email) {
      await EmailReminder.updateOne({ _id: reminder._id, status: 'failed' }, { $set: { status: 'cancelled' } });
      continue;
    }
    const appointmentDateTime = new Date(`${appointment.date.toISOString().slice(0, 10)}T${appointment.time}:00`);
    if (appointmentDateTime <= now) {
      await EmailReminder.updateOne({ _id: reminder._id, status: 'failed' }, { $set: { status: 'cancelled' } });
      continue;
    }
    await sendAppointmentReminderEmail({
      appointment,
      patient,
      doctor: appointment.doctorId,
      reminderKey: reminder.reminderKey,
    });
  }
}

module.exports = { sendAppointmentReminderEmail, retryFailedAppointmentReminderEmails };
