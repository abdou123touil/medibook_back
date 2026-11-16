const mongoose = require('mongoose');

const waitlistEntrySchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  symptoms: { type: String, default: '', maxlength: 2000 },
  status: { type: String, enum: ['waiting', 'offered', 'booking', 'booked', 'expired', 'cancelled'], default: 'waiting', index: true },
  offeredTime: { type: String, default: null },
  offeredUntil: { type: Date, default: null },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
}, { timestamps: true });

waitlistEntrySchema.index({ doctorId: 1, patientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('WaitlistEntry', waitlistEntrySchema);
