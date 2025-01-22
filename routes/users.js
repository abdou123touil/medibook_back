const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const User = require('../models/User');

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
    let { firstName, lastName, email, password, role, phoneNumber, speciality, description, availability } = req.body;

    // Convert `availability` from string to JSON (since form-data sends it as a string)
    if (availability) {
      try {
        availability = JSON.parse(availability);
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for availability' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role,
      phoneNumber,
      speciality,
      description,
      availability,
      profileImage: req.files['profileImage'] ? req.files['profileImage'][0].path : null,
      cinFront: req.files['cinFront'] ? req.files['cinFront'][0].path : null,
      cinBack: req.files['cinBack'] ? req.files['cinBack'][0].path : null
    });

    await user.save();

    res.status(201).json({
      message: 'Utilisateur enregistré avec succès.',
      user: { id: user._id, firstName, lastName, email, role }
    });

  } catch (error) {
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
        { expiresIn: '24h' } // Le token expire dans 24 heures
    );

    res.status(200).json({
      message: 'Connexion réussie.',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Mettre à jour la disponibilité
router.put('/update-availability', async (req, res) => {
  try {
    const { userId, availability } = req.body;

    // Trouver l'utilisateur par son ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    // Mettre à jour la disponibilité
    user.availability = availability;

    await user.save();
    res.status(200).json({ message: 'Disponibilité mise à jour avec succès.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/get-availability', async (req, res) => {
  try {
    const { userId } = req.query; // Get the userId from query params

    // Find the user (doctor) by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    // Return the availability for the doctor
    res.status(200).json({ availability: user.availability });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
router.get('/doctors', async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor' }, '-password'); // Exclure le mot de passe
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;
