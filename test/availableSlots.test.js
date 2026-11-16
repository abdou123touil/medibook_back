const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAvailableSlots } = require('../services/availableSlots');
const {
  getBookingSlotError,
  getCancellationError,
  getAppointmentTransitionError,
} = require('../services/appointmentRules');
const { removeAvailabilityInRange, restoreAvailability } = require('../services/doctorAbsenceRules');

const range = { startDate: '2026-11-16', endDate: '2026-11-30' };

test('returns free slots for a plain object availability', () => {
  const result = buildAvailableSlots({
    ...range,
    availability: { '2026-11-17': ['09:00', '10:00'] },
    appointments: [], activeOffers: [], blockedPeriods: [],
  });
  assert.deepEqual(result, { '2026-11-17': ['09:00', '10:00'] });
});

test('supports Map availability and excludes booked and temporarily offered times', () => {
  const result = buildAvailableSlots({
    ...range,
    availability: new Map([['2026-11-17', ['09:00', '10:00', '11:00']]]),
    appointments: [{ date: new Date('2026-11-17T00:00:00.000Z'), time: '09:00' }],
    activeOffers: [{ date: '2026-11-17', offeredTime: '10:00' }],
    blockedPeriods: [],
  });
  assert.deepEqual(result, { '2026-11-17': ['11:00'] });
});

test('hides dates inside blocked periods and dates outside the requested range', () => {
  const result = buildAvailableSlots({
    startDate: '2026-11-16', endDate: '2026-11-30',
    availability: {
      '2026-11-15': ['09:00'],
      '2026-11-20': ['09:00'],
      '2026-12-01': ['09:00'],
    },
    appointments: [], activeOffers: [],
    blockedPeriods: [{ startDate: '2026-11-19', endDate: '2026-11-21' }],
  });
  assert.deepEqual(result, {});
});

test('ignores malformed availability values and invalid appointment dates safely', () => {
  const result = buildAvailableSlots({
    ...range,
    availability: { '2026-11-17': null },
    appointments: [{ date: 'not-a-date', time: '09:00' }],
    activeOffers: [], blockedPeriods: [],
  });
  assert.deepEqual(result, { '2026-11-17': [] });
});

test('rejects booking during an active doctor absence, even if the slot remains in availability', () => {
  assert.equal(getBookingSlotError({
    availability: new Map([['2026-11-17', ['09:00']]]),
    date: '2026-11-17', time: '09:00', blockedPeriod: { status: 'active' },
  }), 'blocked');
});

test('rejects booking when the requested time is not available', () => {
  assert.equal(getBookingSlotError({
    availability: { '2026-11-17': ['09:00'] },
    date: '2026-11-17', time: '10:00',
  }), 'unavailable');
});

test('reserves a waitlist offer for its patient only', () => {
  const offer = { patientId: 'patient-1' };
  const input = { availability: { '2026-11-17': ['09:00'] }, date: '2026-11-17', time: '09:00', activeWaitlistOffer: offer };
  assert.equal(getBookingSlotError({ ...input, patientId: 'patient-2' }), 'waitlist_reserved');
  assert.equal(getBookingSlotError({ ...input, patientId: 'patient-1' }), null);
});

test('rejects a slot that already has a pending or accepted appointment', () => {
  assert.equal(getBookingSlotError({
    availability: { '2026-11-17': ['09:00'] },
    date: '2026-11-17', time: '09:00', existingAppointment: { status: 'pending' },
  }), 'already_booked');
});

test('requires a cancellation reason between 5 and 500 non-whitespace characters', () => {
  assert.equal(getCancellationError({ reason: '  abc ', status: 'pending', isParticipant: true }), 'invalid_reason');
  assert.equal(getCancellationError({ reason: 'x'.repeat(501), status: 'pending', isParticipant: true }), 'invalid_reason');
  assert.equal(getCancellationError({ reason: '  Motif valide  ', status: 'pending', isParticipant: true }), null);
});

test('only appointment participants may cancel, and completed or cancelled appointments cannot be cancelled again', () => {
  const reason = 'Empêchement personnel';
  assert.equal(getCancellationError({ reason, status: 'pending', isParticipant: false }), 'unauthorized');
  assert.equal(getCancellationError({ reason, status: 'cancelled', isParticipant: true }), 'already_cancelled');
  assert.equal(getCancellationError({ reason, status: 'completed', isParticipant: true }), 'already_completed');
  assert.equal(getCancellationError({ reason, status: 'accepted', isParticipant: true }), null);
});

test('only pending appointments can be accepted and only accepted appointments can be completed', () => {
  assert.equal(getAppointmentTransitionError('pending', 'accept'), null);
  assert.equal(getAppointmentTransitionError('accepted', 'accept'), 'invalid_status');
  assert.equal(getAppointmentTransitionError('accepted', 'complete'), null);
  assert.equal(getAppointmentTransitionError('pending', 'complete'), 'invalid_status');
  assert.equal(getAppointmentTransitionError('cancelled', 'complete'), 'invalid_status');
});

test('removes only availability dates covered by a doctor absence, for both Map and object data', () => {
  const mapResult = removeAvailabilityInRange(
    new Map([['2026-11-17', ['09:00']], ['2026-12-02', ['10:00']]]),
    '2026-11-16',
    '2026-11-30'
  );
  assert.deepEqual(mapResult, {
    remaining: { '2026-12-02': ['10:00'] },
    removed: { '2026-11-17': ['09:00'] },
  });

  const objectResult = removeAvailabilityInRange(
    { '2026-11-20': ['11:00'], '2026-12-02': ['10:00'] },
    '2026-11-16',
    '2026-11-30'
  );
  assert.deepEqual(objectResult.removed, { '2026-11-20': ['11:00'] });
});

test('restores absence availability without duplicates and skips conflicting booked slots', () => {
  const result = restoreAvailability(
    { '2026-11-17': ['10:00'] },
    { '2026-11-17': ['09:00', '10:00'], '2026-11-18': ['08:00'] },
    new Set(['2026-11-17:09:00'])
  );
  assert.deepEqual(result, {
    '2026-11-17': ['10:00'],
    '2026-11-18': ['08:00'],
  });
});
