function toAvailabilityObject(availability) {
  if (availability instanceof Map) return Object.fromEntries(availability.entries());
  if (availability && typeof availability === 'object' && !Array.isArray(availability)) return { ...availability };
  return {};
}

function removeAvailabilityInRange(availability, startDate, endDate) {
  const remaining = toAvailabilityObject(availability);
  const removed = {};
  for (const date of Object.keys(remaining)) {
    if (date >= startDate && date <= endDate) {
      removed[date] = remaining[date];
      delete remaining[date];
    }
  }
  return { remaining, removed };
}

function restoreAvailability(availability, removedAvailability, bookedSlots = new Set()) {
  const restored = toAvailabilityObject(availability);
  for (const [date, times] of Object.entries(removedAvailability || {})) {
    const conflictFree = (Array.isArray(times) ? times : []).filter((time) => !bookedSlots.has(`${date}:${time}`));
    const existing = Array.isArray(restored[date]) ? restored[date] : [];
    restored[date] = [...new Set([...existing, ...conflictFree])].sort();
  }
  return restored;
}

module.exports = { toAvailabilityObject, removeAvailabilityInRange, restoreAvailability };
