function getAvailabilityEntries(availability) {
  if (availability instanceof Map) return [...availability.entries()];
  if (availability && typeof availability === 'object' && !Array.isArray(availability)) {
    return Object.entries(availability);
  }
  return [];
}

function getDateKey(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function buildAvailableSlots({ availability, appointments, activeOffers, blockedPeriods, startDate, endDate }) {
  const slots = {};
  for (const [date, times] of getAvailabilityEntries(availability)) {
    if (date < startDate || date > endDate) continue;
    if (blockedPeriods.some((period) => date >= period.startDate && date <= period.endDate)) continue;

    const bookedTimes = appointments
      .filter((appointment) => getDateKey(appointment.date) === date)
      .map((appointment) => appointment.time);
    const offeredTimes = activeOffers
      .filter((offer) => offer.date === date)
      .map((offer) => offer.offeredTime);

    slots[date] = (Array.isArray(times) ? times : [])
      .filter((time) => !bookedTimes.includes(time) && !offeredTimes.includes(time));
  }
  return slots;
}

module.exports = { buildAvailableSlots };
