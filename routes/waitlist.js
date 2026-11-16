const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const WaitlistEntry = require('../models/WaitlistEntry');
const Notification = require('../models/Notification');
const authenticateToken = require('../middleware/authenticateToken');
const { notifyAppointmentParticipants } = require('../services/notifications');
const { offerNextWaitlistPatient } = require('../services/waitlist');

const router = express.Router();

router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const patient = await User.findById(req.user.id).select('_id role');
    if (!patient || patient.role !== 'client') return res.status(403).json({ error: 'Réservé au compte patient.' });
    const entries = await WaitlistEntry.find({ patientId: patient._id, status: { $in: ['waiting', 'offered'] } })
      .populate('doctorId', 'firstName lastName speciality')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger la liste d’attente.' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const patient = await User.findById(req.user.id).select('_id role');
    if (!patient || patient.role !== 'client') return res.status(403).json({ error: 'Seuls les patients peuvent rejoindre la liste d’attente.' });

    const { doctorId, date, symptoms } = req.body;
    if (!mongoose.Types.ObjectId.isValid(doctorId) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'Médecin ou date invalide.' });
    }
    const requestedDate = new Date(`${date}T23:59:59`);
    if (Number.isNaN(requestedDate.getTime()) || requestedDate < new Date()) {
      return res.status(400).json({ error: 'Choisissez une date future valide.' });
    }

    const doctor = await User.findOne({ _id: doctorId, role: 'doctor' }).select('_id availability');
    if (!doctor) return res.status(404).json({ error: 'Médecin introuvable.' });
    const daySlots = doctor.availability.get(date) || [];
    if (daySlots.length === 0) return res.status(400).json({ error: 'Ce médecin n’a pas de disponibilité prévue à cette date.' });

    const existing = await WaitlistEntry.findOne({ doctorId, patientId: patient._id, date });
    if (existing && ['waiting', 'offered', 'booking', 'booked'].includes(existing.status)) {
      return res.status(409).json({ error: 'Vous êtes déjà inscrit pour cette date.' });
    }

    const entry = existing
      ? await WaitlistEntry.findOneAndUpdate(
        { _id: existing._id, status: { $in: ['expired', 'cancelled'] } },
        { $set: { status: 'waiting', symptoms: String(symptoms || '').slice(0, 2000), offeredTime: null, offeredUntil: null, appointmentId: null } },
        { new: true }
      )
      : await WaitlistEntry.create({
        doctorId,
        patientId: patient._id,
        date,
        symptoms: String(symptoms || '').slice(0, 2000),
      });
    if (!entry) return res.status(409).json({ error: 'Votre inscription a changé. Actualisez puis réessayez.' });
    res.status(201).json({ message: 'Vous êtes inscrit sur la liste d’attente.', entry });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Vous êtes déjà inscrit pour cette date.' });
    res.status(500).json({ error: 'Impossible de rejoindre la liste d’attente.' });
  }
});

router.delete('/:entryId', authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.entryId)) return res.status(400).json({ error: 'Inscription invalide.' });
    const entry = await WaitlistEntry.findOne({ _id: req.params.entryId, patientId: req.user.id, status: { $in: ['waiting', 'offered'] } });
    if (!entry) return res.status(404).json({ error: 'Inscription introuvable.' });
    const wasOffered = entry.status === 'offered';
    const { doctorId, date, offeredTime } = entry;
    entry.status = 'cancelled';
    await entry.save();
    await Notification.updateMany({ waitlistEntryId: entry._id }, { $set: { action: null } });
    if (wasOffered && offeredTime) await offerNextWaitlistPatient(doctorId, date, offeredTime);
    res.json({ message: 'Inscription annulée.' });
  } catch (error) {
    res.status(500).json({ error: 'Impossible d’annuler l’inscription.' });
  }
});

router.post('/:entryId/confirm', authenticateToken, async (req, res) => {
  let entry;
  try {
    const patient = await User.findById(req.user.id).select('_id role');
    if (!patient || patient.role !== 'client') return res.status(403).json({ error: 'Réservé au compte patient.' });
    if (!mongoose.Types.ObjectId.isValid(req.params.entryId)) return res.status(400).json({ error: 'Proposition invalide.' });

    const now = new Date();
    entry = await WaitlistEntry.findOneAndUpdate(
      { _id: req.params.entryId, patientId: patient._id, status: 'offered', offeredUntil: { $gt: now } },
      { $set: { status: 'booking' } },
      { new: true }
    );
    if (!entry) {
      const expiredEntry = await WaitlistEntry.findOneAndUpdate(
        { _id: req.params.entryId, patientId: patient._id, status: 'offered', offeredUntil: { $lte: now } },
        { $set: { status: 'expired' } },
        { new: true }
      );
      if (expiredEntry) await Notification.updateMany({ waitlistEntryId: expiredEntry._id }, { $set: { action: null } });
      if (expiredEntry?.offeredTime) await offerNextWaitlistPatient(expiredEntry.doctorId, expiredEntry.date, expiredEntry.offeredTime);
      return res.status(410).json({ error: 'Le délai de confirmation est expiré. Le créneau a été proposé au patient suivant.' });
    }

    const doctor = await User.findOne({ _id: entry.doctorId, role: 'doctor' });
    if (!doctor || !(doctor.availability.get(entry.date) || []).includes(entry.offeredTime)) {
      entry.status = 'expired';
      await entry.save();
      await Notification.updateMany({ waitlistEntryId: entry._id }, { $set: { action: null } });
      await offerNextWaitlistPatient(entry.doctorId, entry.date, entry.offeredTime);
      return res.status(409).json({ error: 'Ce créneau n’est plus disponible.' });
    }

    const appointmentDate = new Date(entry.date);
    const existingAppointment = await Appointment.findOne({
      doctorId: entry.doctorId,
      date: appointmentDate,
      time: entry.offeredTime,
      status: { $in: ['pending', 'accepted'] },
    });
    if (existingAppointment) {
      entry.status = 'expired';
      await entry.save();
      await Notification.updateMany({ waitlistEntryId: entry._id }, { $set: { action: null } });
      await offerNextWaitlistPatient(entry.doctorId, entry.date, entry.offeredTime);
      return res.status(409).json({ error: 'Ce créneau vient d’être réservé par un autre patient.' });
    }

    const appointment = await Appointment.create({
      doctorId: entry.doctorId,
      patientId: patient._id,
      date: appointmentDate,
      time: entry.offeredTime,
      symptoms: entry.symptoms || 'Consultation demandée depuis la liste d’attente',
      status: doctor.requiresConfirmation ? 'pending' : 'accepted',
    });
    entry.status = 'booked';
    entry.appointmentId = appointment._id;
    entry.offeredUntil = null;
    await entry.save();
    await Notification.updateMany({ waitlistEntryId: entry._id }, { $set: { action: null } });

    await notifyAppointmentParticipants(appointment, {
      title: 'Créneau confirmé',
      message: `Votre rendez-vous du ${entry.date} à ${entry.offeredTime} a été créé.`,
      dedupeKey: `appointment:${appointment._id}:waitlist-booked`,
    });
    const populatedAppointment = await Appointment.findById(appointment._id)
      .populate('doctorId', 'firstName lastName speciality')
      .populate('patientId', 'firstName lastName');
    res.status(201).json({ message: 'Créneau réservé avec succès.', appointment: populatedAppointment });
  } catch (error) {
    if (entry && entry.status === 'booking') {
      entry.status = 'offered';
      await entry.save().catch(() => {});
    }
    console.error('Unable to confirm waitlist offer:', error.message);
    res.status(500).json({ error: 'Impossible de confirmer ce créneau.' });
  }
});

module.exports = router;
