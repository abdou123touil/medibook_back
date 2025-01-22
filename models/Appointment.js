const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    time: { type: String, required: true },
    symptoms: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
});

module.exports = mongoose.model('Appointment', appointmentSchema);
