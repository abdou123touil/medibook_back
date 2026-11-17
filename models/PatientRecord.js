const mongoose = require('mongoose');

const consultationSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  consultationDate: { type: Date, required: true },
  price: { type: Number, min: 0, default: 70 },
  amountPaid: { type: Number, min: 0, default: 0 },
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'not_applicable'], default: 'unpaid' },
  paymentMethod: { type: String, enum: ['cash', 'card', 'transfer', 'other', null], default: null },
  paymentUpdatedAt: { type: Date, default: null },
  symptoms: { type: String, default: '', maxlength: 2000 },
  diagnosis: { type: String, default: '', maxlength: 2000 },
  treatment: { type: String, default: '', maxlength: 4000 },
  // Mixed keeps older string-only prescriptions readable while allowing structured regimens.
  prescriptions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  notes: { type: String, default: '', maxlength: 4000 },
  followUpAt: { type: Date, default: null },
  followUpAppointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
}, { timestamps: true });

const attachmentSchema = new mongoose.Schema({
  fileName: { type: String, required: true, maxlength: 180 },
  mimeType: { type: String, required: true, enum: ['application/pdf', 'image/jpeg', 'image/png'] },
  size: { type: Number, required: true, max: 5 * 1024 * 1024 },
  uploadedAt: { type: Date, default: Date.now },
  data: { type: Buffer, required: true, select: false },
}, { timestamps: false });

const patientRecordSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  allergies: { type: String, default: '', maxlength: 4000 },
  medicalHistory: { type: String, default: '', maxlength: 8000 },
  currentMedications: { type: String, default: '', maxlength: 4000 },
  consultations: { type: [consultationSchema], default: [] },
  attachments: { type: [attachmentSchema], default: [] },
}, { timestamps: true });

patientRecordSchema.index({ doctorId: 1, patientId: 1 }, { unique: true });

module.exports = mongoose.model('PatientRecord', patientRecordSchema);
