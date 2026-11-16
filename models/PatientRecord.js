const mongoose = require('mongoose');

const consultationSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  consultationDate: { type: Date, required: true },
  symptoms: { type: String, default: '', maxlength: 2000 },
  diagnosis: { type: String, default: '', maxlength: 2000 },
  treatment: { type: String, default: '', maxlength: 4000 },
  prescriptions: { type: [String], default: [] },
  notes: { type: String, default: '', maxlength: 4000 },
  followUpAt: { type: Date, default: null },
  followUpAppointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
}, { timestamps: true });

const patientRecordSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  allergies: { type: String, default: '', maxlength: 4000 },
  medicalHistory: { type: String, default: '', maxlength: 8000 },
  currentMedications: { type: String, default: '', maxlength: 4000 },
  consultations: { type: [consultationSchema], default: [] },
}, { timestamps: true });

patientRecordSchema.index({ doctorId: 1, patientId: 1 }, { unique: true });

module.exports = mongoose.model('PatientRecord', patientRecordSchema);
