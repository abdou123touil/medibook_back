const mongoose = require('mongoose');

const emailReminderSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reminderKey: { type: String, enum: ['24h', '2h'], required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lockedAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  lastError: { type: String, maxlength: 500, default: null },
}, { timestamps: true });

emailReminderSchema.index({ appointmentId: 1, recipientId: 1, reminderKey: 1 }, { unique: true });
emailReminderSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model('EmailReminder', emailReminderSchema);
