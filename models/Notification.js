const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
  type: { type: String, enum: ['appointment', 'reminder', 'alert'], required: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 500 },
  dedupeKey: { type: String, unique: true, sparse: true },
  action: { type: String, enum: ['confirm_waitlist'], default: null },
  waitlistEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'WaitlistEntry', default: null },
  slotDate: { type: String, default: null },
  slotTime: { type: String, default: null },
  readAt: { type: Date, default: null },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
