const mongoose = require('mongoose');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    validate: [validator.isEmail, 'Email invalide'],
  },
  password: { type: String, required: true, minlength: 6 },
  role: {
    type: String,
    enum: ['client', 'doctor'],
    default: 'client',
  },
  cinNumber: { type: String, trim: true },
  address: { type: String, trim: true },
  phoneNumber: { type: String, trim: true },
  hospitalName: { type: String, trim: true },
  location: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
  },
  profileImage: { type: String, default: null },
  cinFrontImage: { type: String, default: null },
  cinBackImage: { type: String, default: null },
  speciality: { type: String, trim: true },
  description: { type: String, trim: true },
  availability: {
    type: Map,
    of: [String],
    default: {},
    validate: {
      validator: function (value) {
        // Vérifier que toutes les clés sont des dates valides (YYYY-MM-DD)
        for (const key of value.keys()) {
          if (key === '$*' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            return false;
          }
          // Vérifier que la clé est une date valide
          const date = new Date(key);
          if (isNaN(date.getTime())) {
            return false;
          }
        }
        // Vérifier que les valeurs sont des horaires valides (HH:mm)
        for (const times of value.values()) {
          for (const time of times) {
            if (!/^\d{2}:\d{2}$/.test(time)) {
              return false;
            }
          }
        }
        return true;
      },
      message: 'Availability doit contenir des clés de date valides (YYYY-MM-DD) et des horaires valides (HH:mm).',
    },
  },
  requiresConfirmation: {
    type: Boolean,
    default: false,
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
});

module.exports = mongoose.model('User', userSchema);
