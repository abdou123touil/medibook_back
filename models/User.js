const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['client', 'doctor'], required: true },

    // Fields completed in ProfileCompletion.tsx
    firstName: { type: String },
    lastName: { type: String },
    phoneNumber: { type: String },
    profileImage: { type: String }, // Profile picture
    cinNumber: { type: String }, // CIN Number
    cinFrontImage: { type: String }, // CIN front image
    cinBackImage: { type: String }, // CIN back image

    // Doctor-specific fields (only filled if role = 'doctor')
    speciality: { type: String },
    description: { type: String },
    availability: { type: Map, of: [String] },

    // Reviews for doctors
    reviews: [{
        patientName: String,
        rating: Number,
        comment: String,
        date: Date,
        helpful: { type: Number, default: 0 },
    }],
});

module.exports = mongoose.model('User', userSchema);
