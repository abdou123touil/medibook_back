const express = require('express');
const Appointment = require('../models/Appointment');
const User = require('../models/User'); // Make sure the path is correct

const router = express.Router();

// Créer un rendez-vous
router.post('/', async (req, res) => {
    try {
        const { doctorId, patientId, date, time, symptoms } = req.body;

        const appointment = new Appointment({
            doctorId,
            patientId,
            date,
            time,
            symptoms,
        });

        await appointment.save();
        res.status(201).json({ message: 'Rendez-vous créé avec succès.', appointment });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obtenir les rendez-vous d'un médecin
router.get('/doctor/:doctorId', async (req, res) => {
    try {
        const { doctorId } = req.params;
        const appointments = await Appointment.find({ doctorId }).populate('patientId', 'firstName lastName');
        console.log(appointments)
        res.status(200).json(appointments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obtenir les rendez-vous d'un patient
router.get('/patient/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const appointments = await Appointment.find({ patientId }).populate('doctorId', 'firstName lastName speciality');
        res.status(200).json(appointments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/doctors/availability', async (req, res) => {
    try {
        const { availability } = req.body;
        const doctorId = req.body.doctorId;


        res.status(200).json({ message: "Disponibilités mises à jour.", availability });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/doctor/:doctorId/next', async (req, res) => {
    try {
        const { doctorId } = req.params;

        const today = new Date();

        const startOfDay = new Date(today.setHours(0, 0, 0, 0));
        const endOfDay = new Date(today.setHours(23, 59, 59, 999));



        // Query for today's appointments
        const appointments = await Appointment.find({
            doctorId,
            date: { $gte: startOfDay.toISOString(), $lte: endOfDay.toISOString() },
        }).populate('patientId', 'firstName lastName');


        if (appointments.length === 0) {
            return res.status(404).json({ message: "Aucun rendez-vous aujourd'hui." });
        }

        res.status(200).json(appointments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.patch('/:appointmentId', async (req, res) => {
    try {
        const { appointmentId } = req.params;
        const { status } = req.body;

        // Validate status
        if (!['completed', 'cancelled'].includes(status)) {
            return res.status(400).json({ message: 'Statut invalide' });
        }

        // Find the appointment and update the status
        const updatedAppointment = await Appointment.findByIdAndUpdate(
            appointmentId,
            { status },
            { new: true } // Return the updated document
        );

        if (!updatedAppointment) {
            return res.status(404).json({ message: 'Rendez-vous non trouvé' });
        }

        res.status(200).json(updatedAppointment); // Return updated appointment
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST route for submitting a review after an appointment
router.post('/doctor/:doctorId/review', async (req, res) => {
    try {
        const { doctorId } = req.params;
        const { patientName, rating, comment, helpful } = req.body;

        // Find the doctor
        const doctor = await User.findById(doctorId);

        if (!doctor) {
            return res.status(404).json({ error: 'Médecin non trouvé.' });
        }

        // Create the review
        const review = {
            patientName,
            rating,
            comment,
            date: new Date(),
            helpful: helpful || 0,
        };

        // Add the review to the doctor's reviews array
        doctor.reviews.push(review);
        await doctor.save();

        res.status(201).json({ message: 'Avis ajouté avec succès.', review });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// GET route for fetching reviews for a doctor
router.get('/doctor/:doctorId/reviews', async (req, res) => {
    try {
        const { doctorId } = req.params;

        // Fetch the reviews from the User model for the doctor
        const doctor = await User.findById(doctorId).select('reviews');

        if (!doctor || !doctor.reviews || doctor.reviews.length === 0) {
            return res.status(404).json({ error: 'Aucun avis trouvé pour ce médecin.' });
        }

        res.status(200).json(doctor.reviews);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



module.exports = router;
