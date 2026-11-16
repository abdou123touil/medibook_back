function getBookingSlotError({ availability, date, time, blockedPeriod, activeWaitlistOffer, patientId, existingAppointment }) {
  if (blockedPeriod) return 'blocked';
  const times = availability instanceof Map
    ? availability.get(date)
    : availability && typeof availability === 'object' ? availability[date] : [];
  if (!Array.isArray(times) || !times.includes(time)) return 'unavailable';
  if (activeWaitlistOffer && String(activeWaitlistOffer.patientId) !== String(patientId)) return 'waitlist_reserved';
  if (existingAppointment) return 'already_booked';
  return null;
}

function getCancellationError({ reason, status, isParticipant }) {
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) return 'invalid_reason';
  if (!isParticipant) return 'unauthorized';
  if (status === 'cancelled') return 'already_cancelled';
  if (status === 'completed') return 'already_completed';
  return null;
}

function getAppointmentTransitionError(status, action) {
  const expectedStatus = action === 'accept' ? 'pending' : action === 'complete' ? 'accepted' : null;
  return expectedStatus && status !== expectedStatus ? 'invalid_status' : null;
}

module.exports = { getBookingSlotError, getCancellationError, getAppointmentTransitionError };
