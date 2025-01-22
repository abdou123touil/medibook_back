const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const userRoutes = require('./routes/users');
const appointmentRoutes = require('./routes/appointments');

const app = express();
const PORT = 3000;
app.use(cors({
  origin: 'http://localhost:5173', // Remplacez par l'URL de votre frontend si elle diffère
  methods: ['GET', 'POST', 'PUT', 'DELETE','PATCH'],
  credentials: true, // Si vous avez besoin de gérer des cookies (optionnel)
}));
app.use(bodyParser.json());

// Connexion à MongoDB
mongoose.connect('mongodb://localhost:27017/doctorBooking', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connecté'))
    .catch((err) => console.error('Erreur de connexion MongoDB:', err));

// Routes
app.use('/api/users', userRoutes);
app.use('/api/appointments', appointmentRoutes);

// Démarrage du serveur
app.listen(PORT, () => console.log(`Serveur en cours d'exécution sur le port ${PORT}`));
