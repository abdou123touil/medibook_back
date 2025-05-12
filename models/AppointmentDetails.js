const mongoose = require('mongoose');

const appointmentDetailsSchema = new mongoose.Schema({
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
    tarif: { type: Number, required: true },
    medicaments: { type: [String], required: true },
    cause: { type: String, required: true },
});

module.exports = mongoose.model('AppointmentDetails', appointmentDetailsSchema);
