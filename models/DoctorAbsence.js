const mongoose = require('mongoose');

const doctorAbsenceSchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  reason: { type: String, trim: true, maxlength: 300, default: '' },
  removedAvailability: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
  cancelledAt: { type: Date, default: null },
}, { timestamps: true });

doctorAbsenceSchema.index({ doctorId: 1, status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('DoctorAbsence', doctorAbsenceSchema);
