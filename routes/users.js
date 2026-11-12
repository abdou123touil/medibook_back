const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();
const JWT_SECRET = 'abdou123touil';

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Inscription
router.post('/register', upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'cinFront', maxCount: 1 },
  { name: 'cinBack', maxCount: 1 }
]), async (req, res) => {
  try {
    let { firstName, lastName, cinNumber, address, phoneNumber, email, password, role, speciality, hospitalName, availability } = req.body;

    // Convert `availability` from string to JSON (for doctors)
    if (availability) {
      try {
        availability = JSON.parse(availability);
        if (typeof availability !== 'object' || Array.isArray(availability)) {
          return res.status(400).json({ error: 'La disponibilité doit être un objet avec des dates comme clés et des tableaux d\'heures comme valeurs.' });
        }
        for (const [date, times] of Object.entries(availability)) {
          if (!Array.isArray(times)) {
            return res.status(400).json({ error: 'Les valeurs de disponibilité doivent être des tableaux d\'heures.' });
          }
          for (const time of times) {
            if (!/^\d{2}:\d{2}$/.test(time)) {
              return res.status(400).json({ error: 'Format d\'heure invalide. Utilisez HH:mm.' });
            }
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Format JSON invalide pour la disponibilité.' });
      }
    } else {
      availability = {};
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user object
    const user = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role,
      cinNumber,
      address,
      phoneNumber,
      speciality: role === 'doctor' ? speciality : null,
      hospitalName: role === 'doctor' ? hospitalName : null,
      availability: role === 'doctor' ? availability : {},
      requiresConfirmation: role === 'doctor' ? false : null,
      profileImage: req.files['profileImage'] ? req.files['profileImage'][0].buffer.toString('base64') : null,
      cinFrontImage: req.files['cinFront'] ? req.files['cinFront'][0].buffer.toString('base64') : null,
      cinBackImage: req.files['cinBack'] ? req.files['cinBack'][0].buffer.toString('base64') : null
    });

    await user.save();

    res.status(201).json({
      message: 'Utilisateur enregistré avec succès.',
      user: { id: user._id, firstName, lastName, email, role }
    });
  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    res.status(500).json({ error: error.message });
  }
});

// Connexion
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Mot de passe incorrect.' });
    }

    // Génération du token
    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Si l'utilisateur est un médecin, on récupère ses rendez-vous à venir
    let appointments = [];
    if (user.role === 'doctor') {
      appointments = await Appointment.find({
        doctorId: user._id,
      }).populate('patientId', 'firstName lastName');
    }

    // Si l'utilisateur est un patient, on récupère ses rendez-vous
    if (user.role === 'client') {
      appointments = await Appointment.find({
        patientId: user._id,
      }).populate('doctorId', 'firstName lastName speciality');
    }

    // Log pour vérifier availability
    console.log('User availability on login:', Object.fromEntries(user.availability || new Map()));

    res.status(200).json({
      message: 'Connexion réussie.',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        availability: Object.fromEntries(user.availability || new Map()),
      },
      appointments,
    });
  } catch (error) {
    console.error('Erreur lors de la connexion:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer le profil de l'utilisateur connecté
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }
    res.status(200).json(user);
  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mettre à jour le profil de l'utilisateur
router.put('/profile', authenticateToken, upload.fields([
  { name: 'profileImage', maxCount: 1 }
]), async (req, res) => {
  try {
    const { firstName, lastName, phoneNumber, address, email, speciality, hospitalName, lat, lng, requiresConfirmation } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    // Vérifier si l'email est modifié et s'il est unique
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
      }
      user.email = email;
    }

    // Mettre à jour les champs
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.phoneNumber = phoneNumber || user.phoneNumber;
    user.address = address || user.address;
    user.location = {
      lat: lat ? parseFloat(lat) : user.location?.lat,
      lng: lng ? parseFloat(lng) : user.location?.lng
    };
    if (user.role === 'doctor') {
      user.speciality = speciality || user.speciality;
      user.hospitalName = hospitalName || user.hospitalName;
      user.requiresConfirmation = requiresConfirmation !== undefined ? requiresConfirmation === 'true' : user.requiresConfirmation;
    }
    if (req.files?.['profileImage']) {
      user.profileImage = req.files['profileImage'][0].buffer.toString('base64');
    }

    await user.save();

    res.status(200).json({
      message: 'Profil mis à jour avec succès.',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        address: user.address,
        location: user.location,
        role: user.role,
        speciality: user.speciality,
        hospitalName: user.hospitalName,
        profileImage: user.profileImage,
        requiresConfirmation: user.requiresConfirmation
      }
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du profil:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mettre à jour la disponibilité
router.put('/update-availability', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let { availability } = req.body;

    // Valider availability
    if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
      return res.status(400).json({ error: 'La disponibilité doit être un objet avec des dates comme clés et des tableaux d\'heures comme valeurs.' });
    }

    // Nettoyer availability pour supprimer les clés invalides
    const cleanedAvailability = {};
    for (const [date, times] of Object.entries(availability)) {
      if (date !== '$*' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const dateObj = new Date(date);
        if (!isNaN(dateObj.getTime())) {
          cleanedAvailability[date] = Array.isArray(times) ? times.filter(time => /^\d{2}:\d{2}$/.test(time)) : [];
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { availability: cleanedAvailability },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    res.json({ message: 'Disponibilités mises à jour.', availability: user.availability });
  } catch (error) {
    console.error('Erreur lors de la mise à jour des disponibilités:', error);
    res.status(400).json({ error: error.message || 'Erreur lors de la mise à jour des disponibilités.' });
  }
});

// Récupérer la disponibilité
router.get('/get-availability', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.query.userId);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }
    res.json({ availability: Object.fromEntries(user.availability || new Map()), requiresConfirmation: user.requiresConfirmation });
  } catch (error) {
    console.error('Erreur lors de la récupération de la disponibilité:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les créneaux disponibles pour un médecin
router.get('/doctors/:doctorId/available-slots', async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate et endDate sont requis.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const appointments = await Appointment.find({
      doctorId,
      date: { $gte: startDate, $lte: endDate },
      status: { $in: ['pending', 'accepted'] },
    });

    const availableSlots = {};
    for (const [date, times] of doctor.availability.entries()) {
      if (date >= startDate && date <= endDate) {
        const bookedTimes = appointments
          .filter(apt => apt.date.toISOString().split('T')[0] === date)
          .map(apt => apt.time);
        availableSlots[date] = times.filter(time => !bookedTimes.includes(time));
      }
    }

    res.json({
      availableSlots,
      requiresConfirmation: doctor.requiresConfirmation,
      message: 'Créneaux disponibles récupérés avec succès.',
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des créneaux disponibles:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer tous les médecins
router.get('/doctors', async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor' }, '-password');
    res.json(doctors);
  } catch (error) {
    console.error('Erreur lors de la récupération des médecins:', error);
    res.status(500).json({ error: error.message });
  }
});

// Réinitialiser le mot de passe
router.post('/reset-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    // Valider les champs
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "L'ancien et le nouveau mot de passe sont requis." });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
    }

    // Trouver l'utilisateur
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    // Vérifier l'ancien mot de passe
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "L'ancien mot de passe est incorrect." });
    }

    // Hacher le nouveau mot de passe
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Mettre à jour le mot de passe
    user.password = hashedNewPassword;
    await user.save();

    res.status(200).json({ message: 'Mot de passe réinitialisé avec succès.' });
  } catch (error) {
    console.error('Erreur lors de la réinitialisation du mot de passe:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

module.exports = router;