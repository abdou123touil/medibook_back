const Appointment = require('../models/Appointment');
const WaitlistEntry = require('../models/WaitlistEntry');
const User = require('../models/User');
const { createNotification } = require('./notifications');
const Notification = require('../models/Notification');

async function offerNextWaitlistPatient(doctorId, date, time, cancelledAppointmentId = null) {
  const activeAppointment = await Appointment.findOne({
    doctorId,
    date: new Date(date),
    time,
    status: { $in: ['pending', 'accepted'] },
    ...(cancelledAppointmentId ? { _id: { $ne: cancelledAppointmentId } } : {}),
  });
  if (activeAppointment) return null;

  const now = new Date();
  const activeOffer = await WaitlistEntry.findOne({
    doctorId,
    date,
    offeredTime: time,
    status: { $in: ['offered', 'booking'] },
    offeredUntil: { $gt: now },
  });
  if (activeOffer) return activeOffer;

  const doctor = await User.findById(doctorId).select('firstName lastName availability');
  const scheduledTimes = doctor?.availability?.get(date) || [];
  if (!scheduledTimes.includes(time)) return null;

  const entry = await WaitlistEntry.findOneAndUpdate(
    { doctorId, date, status: 'waiting' },
    {
      $set: {
        status: 'offered',
        offeredTime: time,
        offeredUntil: new Date(now.getTime() + 15 * 60 * 1000),
      },
    },
    { new: true, sort: { createdAt: 1 } }
  );
  if (!entry) return null;

  await createNotification({
    userId: entry.patientId,
    appointmentId: cancelledAppointmentId,
    type: 'alert',
    title: 'Un créneau s’est libéré',
    message: `Le ${date} à ${time}, un créneau s’est libéré chez Dr. ${doctor.firstName} ${doctor.lastName}. Confirmez dans les 15 minutes.`,
    dedupeKey: `waitlist-offer:${entry._id}`,
    action: 'confirm_waitlist',
    waitlistEntryId: entry._id,
    slotDate: date,
    slotTime: time,
  });
  return entry;
}

async function expireWaitlistOffers() {
  const now = new Date();
  const expiredEntries = await WaitlistEntry.find({
    status: { $in: ['offered', 'booking'] },
    offeredUntil: { $lte: now },
  }).select('_id doctorId date offeredTime');

  for (const entry of expiredEntries) {
    const expired = await WaitlistEntry.findOneAndUpdate(
      { _id: entry._id, status: { $in: ['offered', 'booking'] }, offeredUntil: { $lte: now } },
      { $set: { status: 'expired' } },
      { new: true }
    );
    if (expired?.offeredTime) {
      await Notification.updateMany({ waitlistEntryId: expired._id }, { $set: { action: null } });
      await offerNextWaitlistPatient(expired.doctorId, expired.date, expired.offeredTime);
    }
  }
}

module.exports = { offerNextWaitlistPatient, expireWaitlistOffers };
