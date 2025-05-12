const mongoose = require('mongoose');

const teleconsultationSchema = new mongoose.Schema({
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    required: true,
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  roomId: {
    type: String,
    required: true,
    unique: true, // Identifiant unique pour la salle Jitsi
  },
  jitsiUrl: {
    type: String,
    required: true, // URL complète pour rejoindre la réunion
  },
  status: {
    type: String,
    enum: ['planned', 'ongoing', 'completed', 'cancelled'],
    default: 'planned',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  scheduledAt: {
    type: Date,
    required: true, // Date/heure du rendez-vous
  },
});

module.exports = mongoose.model('Teleconsultation', teleconsultationSchema);