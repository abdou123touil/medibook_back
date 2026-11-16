const mongoose = require('mongoose');

const patientRecordAuditSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: {
    type: String,
    enum: ['record_created', 'record_updated', 'attachment_uploaded', 'attachment_deleted'],
    required: true,
  },
  changedFields: { type: [String], default: [] },
  attachmentName: { type: String, maxlength: 180, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

patientRecordAuditSchema.index({ doctorId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('PatientRecordAudit', patientRecordAuditSchema);
