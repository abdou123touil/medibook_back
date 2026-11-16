const Appointment = require('../models/Appointment');
const { createNotification } = require('./notifications');

async function expirePastPendingAppointments() {
  const now = new Date();
  const pendingAppointments = await Appointment.find({
    status: 'pending',
    date: { $lte: now },
  }).select('_id doctorId patientId date time');

  for (const appointment of pendingAppointments) {
    const date = appointment.date.toISOString().slice(0, 10);
    const appointmentDateTime = new Date(`${date}T${appointment.time}:00`);
    if (appointmentDateTime >= now) continue;

    const expiredAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: 'pending' },
      { $set: {
        status: 'cancelled',
        cancellationReason: 'La demande n’a pas été confirmée avant l’heure du rendez-vous.',
        cancelledBy: 'system',
      } },
      { new: true }
    );
    if (!expiredAppointment) continue;

    await Promise.all([
      createNotification({
        userId: appointment.patientId,
        appointmentId: appointment._id,
        type: 'appointment',
        title: 'Demande expirée',
        message: `Votre demande du ${date} à ${appointment.time} a expiré car elle n’a pas été confirmée à temps.`,
        dedupeKey: `appointment:${appointment._id}:expired:patient`,
      }),
      createNotification({
        userId: appointment.doctorId,
        appointmentId: appointment._id,
        type: 'appointment',
        title: 'Demande expirée',
        message: `La demande de rendez-vous du ${date} à ${appointment.time} a expiré.`,
        dedupeKey: `appointment:${appointment._id}:expired:doctor`,
      }),
    ]);
  }
}

module.exports = { expirePastPendingAppointments };
