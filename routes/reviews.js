const express = require('express');
const mongoose = require('mongoose');
const Review = require('../models/Review');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');
const router = express.Router();

// GET: Récupérer tous les avis pour un médecin
router.get('/doctor/:doctorId', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: 'ID du médecin invalide.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const reviews = await Review.find({ doctorId })
      .populate('patientId', 'firstName lastName')
      .sort({ date: -1 });

    res.status(200).json(reviews);
  } catch (error) {
    console.error('Erreur lors de la récupération des avis:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST: Ajouter un nouvel avis pour un médecin
router.post('/doctor/:doctorId', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { rating, comment } = req.body;
    const patientId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: 'ID du médecin invalide.' });
    }

    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'client') {
      return res.status(403).json({ error: 'Seuls les patients peuvent soumettre des avis.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const appointment = await Appointment.findOne({
      doctorId,
      patientId,
      status: 'completed',
    });
    if (!appointment) {
      return res.status(403).json({ error: 'Vous devez avoir un rendez-vous complété pour soumettre un avis.' });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'La note doit être comprise entre 1 et 5.' });
    }

    if (!comment || comment.trim().length === 0) {
      return res.status(400).json({ error: 'Un commentaire est requis.' });
    }

    const review = new Review({
      doctorId,
      patientId,
      patientName: `${patient.firstName} ${patient.lastName}`,
      rating,
      comment,
      date: new Date(),
    });

    await review.save();

    const populatedReview = await Review.findById(review._id)
      .populate('patientId', 'firstName lastName');

    res.status(201).json(populatedReview);
  } catch (error) {
    console.error("Erreur lors de la soumission de l'avis:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;