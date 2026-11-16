const Notification = require('../models/Notification');

async function createNotification({ userId, appointmentId, type = 'appointment', title, message, dedupeKey, action, waitlistEntryId, slotDate, slotTime, doctorId }) {
  if (!userId) return;
  try {
    await Notification.create({ userId, appointmentId, type, title, message, dedupeKey, action, waitlistEntryId, slotDate, slotTime, doctorId });
  } catch (error) {
    // A duplicate key means this event or reminder has already been stored.
    if (error.code !== 11000) {
      console.error('Unable to create notification:', error.message);
    }
  }
}

async function notifyAppointmentParticipants(appointment, { title, message, type = 'appointment', dedupeKey }) {
  const appointmentId = appointment._id;
  const doctorId = appointment.doctorId?._id || appointment.doctorId;
  const patientId = appointment.patientId?._id || appointment.patientId;
  await Promise.all([
    createNotification({ userId: doctorId, appointmentId, type, title, message, dedupeKey: `${dedupeKey}:doctor` }),
    createNotification({ userId: patientId, appointmentId, type, title, message, dedupeKey: `${dedupeKey}:patient` }),
  ]);
}

module.exports = { createNotification, notifyAppointmentParticipants };
