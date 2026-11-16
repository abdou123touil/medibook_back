const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Appointment = require('../models/Appointment');
const Teleconsultation = require('../models/teleconsultation');
const DoctorAbsence = require('../models/DoctorAbsence');
const WaitlistEntry = require('../models/WaitlistEntry');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');
const { createNotification } = require('../services/notifications');
const { buildAvailableSlots } = require('../services/availableSlots');
const { removeAvailabilityInRange, restoreAvailability } = require('../services/doctorAbsenceRules');
const { isDoctorOwner } = require('../services/accessControl');
const { jwtSecret } = require('../config/security');

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      return callback(new Error('Les pièces jointes doivent être des images.'));
    }
    callback(null, true);
  },
});
const registrationUpload = (req, res, next) => upload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'cinFront', maxCount: 1 },
  { name: 'cinBack', maxCount: 1 },
])(req, res, (error) => {
  if (error) return res.status(400).json({ error: error.message || 'Fichier image invalide.' });
  next();
});

// Inscription
router.post('/register', registrationUpload, async (req, res) => {
  try {
    let { firstName, lastName, cinNumber, address, phoneNumber, email, password, role, speciality, hospitalName, availability, lat, lng } = req.body;

    firstName = typeof firstName === 'string' ? firstName.trim() : '';
    lastName = typeof lastName === 'string' ? lastName.trim() : '';
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    cinNumber = typeof cinNumber === 'string' ? cinNumber.trim() : '';
    address = typeof address === 'string' ? address.trim() : '';
    if (firstName.length < 2 || lastName.length < 2 || cinNumber.length < 4 || address.length < 5) {
      return res.status(400).json({ error: 'Renseignez un prénom, un nom, un CIN et une adresse valides.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (!['client', 'doctor'].includes(role)) {
      return res.status(400).json({ error: 'Type de compte invalide.' });
    }
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Sélectionnez un emplacement valide sur la carte.' });
    }
    if (role === 'doctor' && (typeof speciality !== 'string' || speciality.trim().length < 3 || typeof hospitalName !== 'string' || hospitalName.trim().length < 3)) {
      return res.status(400).json({ error: 'La spécialité et le cabinet sont obligatoires pour un médecin.' });
    }

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
          const parsedDate = new Date(`${date}T00:00:00.000Z`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
            return res.status(400).json({ error: 'Format de date invalide dans les disponibilités.' });
          }
          for (const time of times) {
            if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
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
      location: { lat: latitude, lng: longitude },
      speciality: role === 'doctor' ? speciality.trim() : undefined,
      hospitalName: role === 'doctor' ? hospitalName.trim() : undefined,
      availability: role === 'doctor' ? availability : {},
      requiresConfirmation: role === 'doctor' ? false : null,
      profileImage: req.files['profileImage'] ? req.files['profileImage'][0].buffer.toString('base64') : null,
      cinFrontImage: req.files['cinFront'] ? req.files['cinFront'][0].buffer.toString('base64') : null,
      cinBackImage: req.files['cinBack'] ? req.files['cinBack'][0].buffer.toString('base64') : null
    });

    await user.save();

    const token = jwt.sign({ id: user._id, role: user.role, email: user.email }, jwtSecret, { expiresIn: '24h' });
    res.status(201).json({
      message: 'Utilisateur enregistré avec succès.',
      token,
      user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role }
    });
  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    if (error.code === 11000) return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée.' });
    if (error.name === 'ValidationError' || error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Impossible de créer le compte pour le moment.' });
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
      jwtSecret,
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
    const user = await User.findById(req.user.id).select(
      'firstName lastName email role phoneNumber address location profileImage speciality description hospitalName availability requiresConfirmation'
    );
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
    const doctor = await User.findById(userId).select('_id role');
    if (!isDoctorOwner(doctor, userId)) {
      return res.status(403).json({ error: 'Cette action est réservée aux médecins.' });
    }
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

    const activeAbsences = await DoctorAbsence.find({ doctorId: userId, status: 'active' }).select('startDate endDate');
    const attemptedBlockedDate = Object.entries(cleanedAvailability).find(([date, times]) =>
      times.length > 0 && activeAbsences.some((absence) => date >= absence.startDate && date <= absence.endDate)
    );
    if (attemptedBlockedDate) {
      return res.status(409).json({ error: `La date ${attemptedBlockedDate[0]} est encore bloquée. Annulez d’abord le blocage.` });
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

router.post('/doctor-absence', authenticateToken, async (req, res) => {
  try {
    const doctor = await User.findById(req.user.id).select('_id role firstName lastName availability');
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(403).json({ error: 'Cette action est réservée aux médecins.' });
    }

    const { startDate, endDate } = req.body;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    const isValidDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
      return res.status(400).json({ error: 'Sélectionnez une période valide.' });
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    if (startDate < todayKey || endDate < todayKey) {
      return res.status(400).json({ error: 'La période doit inclure au moins une date à venir.' });
    }

    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    const overlappingAbsence = await DoctorAbsence.findOne({
      doctorId: doctor._id,
      status: 'active',
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    });
    if (overlappingAbsence) {
      return res.status(409).json({ error: 'Cette période chevauche une absence déjà enregistrée.' });
    }
    const appointments = await Appointment.find({
      doctorId: doctor._id,
      date: { $gte: start, $lte: end },
      status: { $in: ['pending', 'accepted'] },
    }).select('_id patientId date time status isTeleconsultation');

    const { remaining: availableDates, removed: removedAvailability } = removeAvailabilityInRange(
      doctor.availability,
      startDate,
      endDate
    );
    doctor.availability = availableDates;
    await doctor.save();

    const absence = await DoctorAbsence.create({
      doctorId: doctor._id,
      startDate,
      endDate,
      reason,
      removedAvailability,
    });

    const reasonForPatients = reason ? ` Motif : ${reason}` : '';
    let cancelledCount = 0;
    for (const appointment of appointments) {
      const date = appointment.date.toISOString().slice(0, 10);
      const updatedAppointment = await Appointment.findOneAndUpdate(
        { _id: appointment._id, status: { $in: ['pending', 'accepted'] } },
        {
          $set: {
            status: 'cancelled',
            cancellationReason: reason || `Absence du médecin du ${startDate} au ${endDate}.`,
            cancelledBy: 'doctor',
            ...(appointment.isTeleconsultation ? { 'teleconsultation.status': 'cancelled' } : {}),
          },
        },
        { new: true }
      );
      if (!updatedAppointment) continue;
      cancelledCount += 1;
      await Teleconsultation.updateOne({ appointmentId: appointment._id }, { $set: { status: 'cancelled' } });
      await createNotification({
        userId: appointment.patientId,
        appointmentId: appointment._id,
        doctorId: doctor._id,
        type: 'appointment',
        title: 'Rendez-vous annulé : absence du médecin',
        message: `Dr. ${doctor.firstName} ${doctor.lastName} ne pourra pas assurer votre rendez-vous du ${date} à ${appointment.time}. Choisissez un nouveau créneau ou gardez l’annulation.${reasonForPatients}`.slice(0, 500),
        dedupeKey: `appointment:${appointment._id}:doctor-absence`,
        action: 'reschedule_appointment',
      });
    }

    res.json({
      message: 'Période d’absence enregistrée.',
      absence,
      availability: availableDates,
      cancelledAppointments: cancelledCount,
    });
  } catch (error) {
    console.error('Impossible d’enregistrer l’absence du médecin:', error);
    res.status(500).json({ error: 'Impossible d’enregistrer cette période d’absence.' });
  }
});

router.get('/doctor-absences', authenticateToken, async (req, res) => {
  try {
    const doctor = await User.findById(req.user.id).select('_id role');
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(403).json({ error: 'Cette action est réservée aux médecins.' });
    }
    const absences = await DoctorAbsence.find({ doctorId: doctor._id, status: 'active' })
      .sort({ startDate: 1 })
      .lean();
    res.json({ absences });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les périodes bloquées.' });
  }
});

router.put('/doctor-absence/:absenceId/cancel', authenticateToken, async (req, res) => {
  try {
    const doctor = await User.findById(req.user.id).select('_id role availability');
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(403).json({ error: 'Cette action est réservée aux médecins.' });
    }
    const absence = await DoctorAbsence.findOne({
      _id: req.params.absenceId,
      doctorId: doctor._id,
      status: 'active',
    });
    if (!absence) return res.status(404).json({ error: 'Période bloquée introuvable ou déjà annulée.' });

    const start = new Date(`${absence.startDate}T00:00:00.000Z`);
    const end = new Date(`${absence.endDate}T23:59:59.999Z`);
    const activeAppointments = await Appointment.find({
      doctorId: doctor._id,
      date: { $gte: start, $lte: end },
      status: { $in: ['pending', 'accepted'] },
    }).select('date time');
    const bookedSlots = new Set(activeAppointments.map((appointment) =>
      `${appointment.date.toISOString().slice(0, 10)}:${appointment.time}`
    ));

    const restoredAvailability = restoreAvailability(
      doctor.availability,
      absence.removedAvailability,
      bookedSlots
    );
    doctor.availability = restoredAvailability;
    await doctor.save();
    absence.status = 'cancelled';
    absence.cancelledAt = new Date();
    await absence.save();

    res.json({ message: 'Blocage annulé et créneaux restaurés.', availability: restoredAvailability });
  } catch (error) {
    console.error('Impossible d’annuler le blocage:', error);
    res.status(500).json({ error: 'Impossible d’annuler cette période bloquée.' });
  }
});

// Récupérer la disponibilité
router.get('/get-availability', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('_id role availability requiresConfirmation');
    if (!isDoctorOwner(user, req.user.id)) {
      return res.status(403).json({ error: 'Cette action est réservée aux médecins.' });
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
    const activeOffers = await WaitlistEntry.find({
      doctorId,
      status: { $in: ['offered', 'booking'] },
      offeredUntil: { $gt: new Date() },
    }).select('date offeredTime');
    const blockedPeriods = await DoctorAbsence.find({
      doctorId,
      status: 'active',
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    }).select('startDate endDate').lean();

    const availableSlots = buildAvailableSlots({
      availability: doctor.availability,
      appointments,
      activeOffers,
      blockedPeriods,
      startDate,
      endDate,
    });

    res.json({
      availableSlots,
      blockedPeriods,
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
    const doctors = await User.find(
      { role: 'doctor' },
      'firstName lastName speciality description hospitalName location requiresConfirmation'
    );
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
