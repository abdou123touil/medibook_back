const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Appointment = require('../models/Appointment');
const AppointmentDetails = require('../models/AppointmentDetails');
const Teleconsultation = require('../models/teleconsultation');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');
const { notifyAppointmentParticipants, createNotification } = require('../services/notifications');
const WaitlistEntry = require('../models/WaitlistEntry');
const Notification = require('../models/Notification');
const { offerNextWaitlistPatient } = require('../services/waitlist');
const router = express.Router();

// Créer un rendez-vous
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { doctorId, date, time, symptoms, isTeleconsultation } = req.body;
    const patientId = req.user.id;

    if (!doctorId || !date || !time || !symptoms) {
      return res.status(400).json({ error: 'doctorId, date, time et symptoms sont requis.' });
    }

    const patient = await User.findById(patientId);
    if (!patient || patient.role !== 'client') {
      return res.status(403).json({ error: 'Seuls les patients peuvent créer des rendez-vous.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const appointmentDate = new Date(date);
    if (isNaN(appointmentDate.getTime())) {
      return res.status(400).json({ error: 'Format de date invalide.' });
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "Format d'heure invalide. Utilisez HH:mm." });
    }

    const dateKey = appointmentDate.toISOString().split('T')[0];
    const availableSlots = doctor.availability.get(dateKey) || [];
    if (!availableSlots.includes(time)) {
      return res.status(400).json({ error: 'Ce créneau n\'est pas disponible.' });
    }

    const activeWaitlistOffer = await WaitlistEntry.findOne({
      doctorId,
      date: dateKey,
      offeredTime: time,
      status: { $in: ['offered', 'booking'] },
      offeredUntil: { $gt: new Date() },
    });
    if (activeWaitlistOffer && activeWaitlistOffer.patientId.toString() !== patientId) {
      return res.status(409).json({ error: 'Ce créneau est temporairement réservé à un patient de la liste d’attente.' });
    }

    const existingAppointment = await Appointment.findOne({
      doctorId,
      date: appointmentDate,
      time,
      status: { $in: ['pending', 'accepted'] },
    });
    if (existingAppointment) {
      return res.status(400).json({ error: 'Ce créneau est déjà réservé.' });
    }

    const status = doctor.requiresConfirmation ? 'pending' : 'accepted';

    const appointment = new Appointment({
      doctorId,
      patientId,
      date: appointmentDate,
      time,
      symptoms,
      status,
      isTeleconsultation: !!isTeleconsultation,
    });

    // Si téléconsultation, créer une entrée dans Teleconsultation et mettre à jour Appointment
    if (isTeleconsultation) {
      const roomId = `medibook-${appointment._id}`;
      const jitsiUrl = `https://meet.jit.si/${roomId}`;
      const teleconsultation = new Teleconsultation({
        appointmentId: appointment._id,
        patientId,
        doctorId,
        roomId,
        jitsiUrl,
        status: 'planned',
        scheduledAt: appointmentDate,
      });
      await teleconsultation.save();
      console.log(`Téléconsultation créée: ${jitsiUrl}`);

      // Mettre à jour le sous-document teleconsultation dans Appointment
      appointment.teleconsultation = {
        jitsiUrl,
        status: 'planned',
      };
    }

    await appointment.save();

    if (activeWaitlistOffer) {
      activeWaitlistOffer.status = 'booked';
      activeWaitlistOffer.appointmentId = appointment._id;
      activeWaitlistOffer.offeredUntil = null;
      await activeWaitlistOffer.save();
      await Notification.updateMany({ waitlistEntryId: activeWaitlistOffer._id }, { $set: { action: null } });
    }

    await notifyAppointmentParticipants(appointment, {
      title: 'Nouveau rendez-vous',
      message: doctor.requiresConfirmation
        ? 'Une demande de rendez-vous attend votre confirmation.'
        : 'Un nouveau rendez-vous a été réservé.',
      dedupeKey: `appointment:${appointment._id}:created`,
    });

    const populatedAppointment = await Appointment.findById(appointment._id)
      .populate('doctorId', 'firstName lastName speciality')
      .populate('patientId', 'firstName lastName');

    res.status(201).json({
      message: doctor.requiresConfirmation
        ? 'Rendez-vous soumis. En attente de confirmation du médecin.'
        : 'Rendez-vous réservé avec succès.',
      appointment: populatedAppointment,
    });
  } catch (error) {
    console.error('Erreur lors de la création du rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les rendez-vous d'un patient
router.get('/patient/:patientId', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: 'ID du patient invalide.' });
    }

    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'client' || user._id.toString() !== patientId) {
      return res.status(403).json({ error: 'Accès non autorisé.' });
    }

    const appointments = await Appointment.find({ patientId })
      .populate('doctorId', 'firstName lastName speciality')
      .sort({ date: 1 });

    res.status(200).json({
      message: 'Rendez-vous récupérés avec succès.',
      appointments,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les rendez-vous d'un médecin
router.get('/doctor/:doctorId', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const appointments = await Appointment.find({ doctorId })
      .populate('patientId', 'firstName lastName')
      .sort({ date: 1 });

    res.status(200).json({
      message: 'Rendez-vous récupérés avec succès.',
      appointments,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accepter un rendez-vous
router.put('/:appointmentId/accept', authenticateToken, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const doctorId = req.user.id;

    const user = await User.findById(doctorId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Seuls les médecins peuvent accepter des rendez-vous.' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé.' });
    }

    if (appointment.doctorId.toString() !== doctorId) {
      return res.status(403).json({ error: 'Ce rendez-vous ne vous est pas attribué.' });
    }

    if (appointment.status !== 'pending') {
      return res.status(400).json({ error: "Ce rendez-vous ne peut pas être accepté car il n'est pas en attente." });
    }

    appointment.status = 'accepted';
    if (appointment.isTeleconsultation && appointment.teleconsultation) {
      appointment.teleconsultation.status = 'planned';
    }
    await appointment.save();

    await createNotification({
      userId: appointment.patientId,
      appointmentId: appointment._id,
      type: 'appointment',
      title: 'Rendez-vous confirmé',
      message: 'Le médecin a confirmé votre rendez-vous.',
      dedupeKey: `appointment:${appointment._id}:accepted:patient`,
    });

    // Mettre à jour la téléconsultation associée
    if (appointment.isTeleconsultation) {
      await Teleconsultation.updateOne(
        { appointmentId },
        { status: 'planned' }
      );
    }

    const populatedAppointment = await Appointment.findById(appointmentId)
      .populate('doctorId', 'firstName lastName speciality')
      .populate('patientId', 'firstName lastName');

    res.status(200).json({
      message: 'Rendez-vous accepté avec succès.',
      appointment: populatedAppointment,
    });
  } catch (error) {
    console.error("Erreur lors de l'acceptation du rendez-vous:", error);
    res.status(500).json({ error: error.message });
  }
});

// Annuler un rendez-vous
router.put('/:appointmentId/cancel', authenticateToken, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const userId = req.user.id;

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé.' });
    }

    if (appointment.patientId.toString() !== userId && appointment.doctorId.toString() !== userId) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à annuler ce rendez-vous." });
    }

    if (appointment.status === 'cancelled') {
      return res.status(400).json({ error: 'Ce rendez-vous est déjà annulé.' });
    }
    if (appointment.status === 'completed') {
      return res.status(400).json({ error: 'Ce rendez-vous est déjà terminé.' });
    }

    appointment.status = 'cancelled';
    if (appointment.isTeleconsultation && appointment.teleconsultation) {
      appointment.teleconsultation.status = 'cancelled';
    }
    await appointment.save();

    await offerNextWaitlistPatient(
      appointment.doctorId,
      appointment.date.toISOString().slice(0, 10),
      appointment.time,
      appointment._id
    );

    const cancelledByPatient = appointment.patientId.toString() === userId;
    await createNotification({
      userId: cancelledByPatient ? appointment.doctorId : appointment.patientId,
      appointmentId: appointment._id,
      type: 'appointment',
      title: 'Rendez-vous annulé',
      message: cancelledByPatient
        ? `Le patient a annulé le rendez-vous du ${appointment.date.toISOString().slice(0, 10)} à ${appointment.time}.`
        : `Le médecin a annulé votre rendez-vous du ${appointment.date.toISOString().slice(0, 10)} à ${appointment.time}.`,
      dedupeKey: `appointment:${appointment._id}:cancelled:${cancelledByPatient ? 'doctor' : 'patient'}`,
    });

    // Mettre à jour la téléconsultation associée
    if (appointment.isTeleconsultation) {
      await Teleconsultation.updateOne(
        { appointmentId },
        { status: 'cancelled' }
      );
    }

    const populatedAppointment = await Appointment.findById(appointmentId)
      .populate('doctorId', 'firstName lastName speciality')
      .populate('patientId', 'firstName lastName');

    res.status(200).json({
      message: 'Rendez-vous annulé avec succès.',
      appointment: populatedAppointment,
    });
  } catch (error) {
    console.error("Erreur lors de l'annulation du rendez-vous:", error);
    res.status(500).json({ error: error.message });
  }
});

// Compléter un rendez-vous
router.put('/:appointmentId/complete', authenticateToken, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const { symptoms, diagnosis, prescription, notes, tarif } = req.body;
    const doctorId = req.user.id;

    const user = await User.findById(doctorId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Seuls les médecins peuvent compléter des rendez-vous.' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé.' });
    }

    if (appointment.doctorId.toString() !== doctorId) {
      return res.status(403).json({ error: 'Ce rendez-vous ne vous est pas attribué.' });
    }

    if (appointment.status !== 'accepted') {
      return res.status(400).json({ error: "Ce rendez-vous ne peut pas être complété car il n'est pas accepté." });
    }

    appointment.status = 'completed';
    if (appointment.isTeleconsultation && appointment.teleconsultation) {
      appointment.teleconsultation.status = 'completed';
    }
    await appointment.save();

    await createNotification({
      userId: appointment.patientId,
      appointmentId: appointment._id,
      type: 'appointment',
      title: 'Consultation terminée',
      message: 'Votre consultation est terminée. Le médecin peut ajouter le compte rendu à votre fiche.',
      dedupeKey: `appointment:${appointment._id}:completed:patient`,
    });

    // Mettre à jour la téléconsultation associée
    if (appointment.isTeleconsultation) {
      await Teleconsultation.updateOne(
        { appointmentId },
        { status: 'completed' }
      );
    }

    const populatedAppointment = await Appointment.findById(appointmentId)
      .populate('doctorId', 'firstName lastName speciality')
      .populate('patientId', 'firstName lastName');

    res.status(200).json({
      message: 'Rendez-vous complété avec succès.',
      appointment: populatedAppointment,
    });
  } catch (error) {
    console.error('Erreur lors de la complétion du rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les rendez-vous d'un utilisateur
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    let appointments;
    if (user.role === 'doctor') {
      appointments = await Appointment.find({ doctorId: userId })
        .populate('patientId', 'firstName lastName')
        .sort({ date: 1 });
    } else {
      appointments = await Appointment.find({ patientId: userId })
        .populate('doctorId', 'firstName lastName speciality')
        .sort({ date: 1 });
    }

    res.status(200).json({
      message: 'Rendez-vous récupérés avec succès.',
      appointments,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les rendez-vous d'un médecin pour une plage de dates
router.get('/doctor/:doctorId/next', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate et endDate sont requis.' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Format de date invalide.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }

    const doctor = await User.findById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(404).json({ error: 'Médecin non trouvé.' });
    }

    const appointments = await Appointment.find({
      doctorId,
      date: { $gte: start, $lte: end },
      status: { $in: ['pending', 'accepted'] },
    })
      .populate('patientId', 'firstName lastName')
      .sort({ date: 1 });

    res.status(200).json({
      message: 'Rendez-vous récupérés avec succès.',
      appointments,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les statistiques d'un médecin
router.get('/doctor/:doctorId/stats', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { timeRange, startDate, endDate, statusFilter } = req.query;

    if (!['day', 'week', 'month', 'quarter', 'year', 'custom'].includes(timeRange)) {
      return res.status(400).json({ error: 'timeRange doit être "day", "week", "month", "quarter", "year" ou "custom".' });
    }

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: 'ID du médecin invalide.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }
    if (user.role !== 'doctor' || user._id.toString() !== doctorId) {
      return res.status(403).json({ error: 'Accès non autorisé.' });
    }

    const now = new Date();
    let start, end = now, groupFormat;
    if (timeRange === 'day') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'week') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'month') {
      start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'quarter') {
      start = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      groupFormat = '%Y-%m';
    } else if (timeRange === 'year') {
      start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      groupFormat = '%Y-%m';
    } else if (timeRange === 'custom') {
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate et endDate sont requis pour timeRange=custom.' });
      }
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({ error: 'startDate invalide.' });
      }
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({ error: 'endDate invalide.' });
      }
      // Inclure toute la journée sélectionnée, même si le sélecteur envoie minuit.
      end.setHours(23, 59, 59, 999);
      start.setHours(0, 0, 0, 0);
      groupFormat = '%Y-%m-%d';
    }

    const matchFilter = {
      doctorId: new mongoose.Types.ObjectId(doctorId),
      status: { $in: ['pending', 'accepted', 'completed', 'cancelled'] },
      date: {
        $gte: start,
        $lte: end,
      },
    };

    if (statusFilter && statusFilter !== 'all') {
      matchFilter.status = statusFilter;
    }

    const stats = await Appointment.aggregate([
      {
        $match: matchFilter,
      },
      {
        $lookup: {
          from: 'appointmentdetails',
          localField: '_id',
          foreignField: 'appointmentId',
          as: 'details',
        },
      },
      {
        $unwind: {
          path: '$details',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: groupFormat, date: { $toDate: '$date' } },
          },
          patients: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$details.tarif', 0] } },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          date: '$_id',
          patients: 1,
          revenue: 1,
          _id: 0,
        },
      },
    ]);

    const incompleteDetailsCount = await Appointment.aggregate([
      {
        $match: {
          doctorId: new mongoose.Types.ObjectId(doctorId),
          status: 'completed',
        },
      },
      {
        $lookup: {
          from: 'appointmentdetails',
          localField: '_id',
          foreignField: 'appointmentId',
          as: 'details',
        },
      },
      {
        $match: {
          details: { $size: 0 },
        },
      },
      {
        $count: 'count',
      },
    ]);

    const totalAppointments = await Appointment.countDocuments({
      doctorId: new mongoose.Types.ObjectId(doctorId),
      date: {
        $gte: start,
        $lte: end,
      },
    });

    const noShows = await Appointment.countDocuments({
      doctorId: new mongoose.Types.ObjectId(doctorId),
      $or: [
        { status: 'cancelled' },
        {
          status: 'pending',
          date: { $lt: new Date() },
        },
      ],
      date: {
        $gte: start,
        $lte: end,
      },
    });

    const noShowRate = totalAppointments > 0 ? (noShows / totalAppointments) * 100 : 0;

    const recurrentPatients = await Appointment.aggregate([
      {
        $match: {
          doctorId: new mongoose.Types.ObjectId(doctorId),
          date: {
            $gte: start,
            $lte: end,
          },
        },
      },
      {
        $group: {
          _id: '$patientId',
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
      {
        $count: 'recurrentCount',
      },
    ]);

    const peakHours = await Appointment.aggregate([
      {
        $match: {
          doctorId: new mongoose.Types.ObjectId(doctorId),
          date: {
            $gte: start,
            $lte: end,
          },
        },
      },
      {
        $group: {
          _id: '$time',
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
      {
        $limit: 3,
      },
      {
        $project: {
          time: '$_id',
          count: 1,
          _id: 0,
        },
      },
    ]);

    const statusDistribution = await Appointment.aggregate([
      {
        $match: {
          doctorId: new mongoose.Types.ObjectId(doctorId),
          date: {
            $gte: start,
            $lte: end,
          },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          name: '$_id',
          value: '$count',
          _id: 0,
        },
      },
    ]);
   

    const totalExpenses = await Appointment.aggregate([
      {
        $match: {
          doctorId: new mongoose.Types.ObjectId(doctorId),
          status: 'completed',
        },
      },
      {
        $lookup: {
          from: 'appointmentdetails',
          localField: '_id',
          foreignField: 'appointmentId',
          as: 'details',
        },
      },
      {
        $unwind: {
          path: '$details',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ['$details.tarif', 0] } },
        },
      },
    ]);

    res.status(200).json({
      message: 'Statistiques récupérées avec succès.',
      stats,
      incompleteDetailsCount: incompleteDetailsCount[0]?.count || 0,
      noShowRate: parseFloat(noShowRate.toFixed(2)),
      recurrentPatients: recurrentPatients[0]?.recurrentCount || 0,
      peakHours,
      statusDistribution,
      totalAppointments,
      totalExpenses: totalExpenses[0]?.total || 0,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les statistiques d'un patient
router.get('/patient/:patientId/stats', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { timeRange, startDate, endDate, statusFilter } = req.query;

    console.log(`Requête stats pour patientId: ${patientId}, timeRange: ${timeRange}, statusFilter: ${statusFilter}`);

    if (!['day', 'week', 'month', 'quarter', 'year', 'custom'].includes(timeRange)) {
      return res.status(400).json({ error: 'timeRange doit être "day", "week", "month", "quarter", "year" ou "custom".' });
    }

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: 'ID du patient invalide.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    }
    if (user.role !== 'client' || user._id.toString() !== patientId) {
      return res.status(403).json({ error: 'Accès non autorisé.' });
    }

    const now = new Date();
    let start, end = now, groupFormat;
    if (timeRange === 'day') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'week') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'month') {
      start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      groupFormat = '%Y-%m-%d';
    } else if (timeRange === 'quarter') {
      start = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      groupFormat = '%Y-%m';
    } else if (timeRange === 'year') {
      start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      groupFormat = '%Y-%m';
    } else if (timeRange === 'custom') {
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate et endDate sont requis pour timeRange=custom.' });
      }
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({ error: 'startDate invalide.' });
      }
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({ error: 'endDate invalide.' });
      }
      // Inclure toute la journée sélectionnée, même si le sélecteur envoie minuit.
      end.setHours(23, 59, 59, 999);
      start.setHours(0, 0, 0, 0);
      groupFormat = '%Y-%m-%d';
    }

    const matchFilter = {
      patientId: new mongoose.Types.ObjectId(patientId),
      status: { $in: ['pending', 'accepted', 'completed', 'cancelled'] },
      date: {
        $gte: start,
        $lte: end,
      },
    };

    if (statusFilter && statusFilter !== 'all') {
      matchFilter.status = statusFilter;
    }

    console.log("Filtre de requête MongoDB:", matchFilter);

    const stats = await Appointment.aggregate([
      {
        $match: matchFilter,
      },
      {
        $lookup: {
          from: 'appointmentdetails',
          localField: '_id',
          foreignField: 'appointmentId',
          as: 'details',
        },
      },
      {
        $unwind: {
          path: '$details',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: groupFormat, date: { $toDate: '$date' } },
          },
          appointments: { $sum: 1 },
          expenses: { $sum: { $ifNull: ['$details.tarif', 0] } },
        },
      },
      {
        $sort: { _id: 1 },
      },
      {
        $project: {
          date: '$_id',
          appointments: 1,
          expenses: 1,
          _id: 0,
        },
      },
    ]);

    console.log("Stats agrégées:", stats);

    const totalAppointments = await Appointment.countDocuments({
      patientId: new mongoose.Types.ObjectId(patientId),
    });

    const totalExpenses = await Appointment.aggregate([
      {
        $match: {
          patientId: new mongoose.Types.ObjectId(patientId),
          status: 'completed',
        },
      },
      {
        $lookup: {
          from: 'appointmentdetails',
          localField: '_id',
          foreignField: 'appointmentId',
          as: 'details',
        },
      },
      {
        $unwind: {
          path: '$details',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ['$details.tarif', 0] } },
        },
      },
    ]);

    const upcomingAppointments = await Appointment.countDocuments({
      patientId: new mongoose.Types.ObjectId(patientId),
      status: { $in: ['pending', 'accepted'] },
      date: { $gte: new Date().toISOString() },
    });

    const completedAppointments = await Appointment.countDocuments({
      patientId: new mongoose.Types.ObjectId(patientId),
      status: 'completed',
    });
    const completionRate = totalAppointments > 0 ? (completedAppointments / totalAppointments) * 100 : 0;

    const statusDistribution = await Appointment.aggregate([
      {
        $match: {
          patientId: new mongoose.Types.ObjectId(patientId),
          date: {
            $gte: start,
            $lte: end,
          },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          name: '$_id',
          value: '$count',
          _id: 0,
        },
      },
    ]);

    console.log("Résultat final:", {
      stats,
      totalAppointments,
      totalExpenses: totalExpenses[0]?.total || 0,
      upcomingAppointments,
      completionRate: parseFloat(completionRate.toFixed(2)),
      statusDistribution,
    });

    res.status(200).json({
      message: 'Statistiques récupérées avec succès.',
      stats,
      totalAppointments,
      totalExpenses: totalExpenses[0]?.total || 0,
      upcomingAppointments,
      completionRate: parseFloat(completionRate.toFixed(2)),
      statusDistribution,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer les détails d'un rendez-vous
router.get('/appointment-details/:appointmentId', authenticateToken, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user || (user.role !== 'doctor' && user.role !== 'client')) {
      return res.status(403).json({ error: 'Accès non autorisé.' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé.' });
    }

    if (
      appointment.doctorId.toString() !== userId &&
      appointment.patientId.toString() !== userId
    ) {
      return res.status(403).json({ error: 'Ce rendez-vous ne vous est pas attribué.' });
    }

    const appointmentDetails = await AppointmentDetails.findOne({ appointmentId });
    const teleconsultation = await Teleconsultation.findOne({ appointmentId });

    res.status(200).json({
      message: 'Détails du rendez-vous récupérés avec succès.',
      appointmentDetail: appointmentDetails,
      teleconsultation,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des détails du rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Créer les détails d'un rendez-vous
router.post('/appointment-details', authenticateToken, async (req, res) => {
  try {
    const { appointmentId, tarif, medicaments, cause } = req.body;
    const doctorId = req.user.id;

    if (!appointmentId || !tarif || !medicaments || !cause) {
      return res.status(400).json({ error: 'appointmentId, tarif, medicaments et cause sont requis.' });
    }
    if (!Array.isArray(medicaments) || medicaments.length === 0) {
      return res.status(400).json({ error: 'medicaments doit être un tableau non vide.' });
    }
    if (typeof tarif !== 'number' || tarif <= 0) {
      return res.status(400).json({ error: 'tarif doit être un nombre positif.' });
    }

    const user = await User.findById(doctorId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Seuls les médecins peuvent ajouter des détails de rendez-vous.' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'Rendez-vous non trouvé.' });
    }

    if (appointment.doctorId.toString() !== doctorId) {
      return res.status(403).json({ error: 'Ce rendez-vous ne vous est pas attribué.' });
    }

    if (appointment.status !== 'completed') {
      return res.status(400).json({ error: 'Le rendez-vous doit être terminé pour ajouter des détails.' });
    }

    const existingDetails = await AppointmentDetails.findOne({ appointmentId });
    if (existingDetails) {
      return res.status(400).json({ error: 'Les détails de ce rendez-vous existent déjà.' });
    }

    const appointmentDetails = new AppointmentDetails({
      appointmentId,
      tarif,
      medicaments,
      cause,
    });

    await appointmentDetails.save();

    res.status(201).json({
      message: 'Détails du rendez-vous ajoutés avec succès.',
      appointmentDetail: appointmentDetails,
    });
  } catch (error) {
    console.error('Erreur lors de l\'ajout des détails du rendez-vous:', error);
    res.status(500).json({ error: error.message });
  }
});

// Soumettre un avis sur un médecin
router.post('/doctor/:doctorId/review', authenticateToken, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { rating, comment } = req.body;
    const patientId = req.user.id;

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

    doctor.reviews = doctor.reviews || [];
    doctor.reviews.push({
      patientName: `${patient.firstName} ${patient.lastName}`,
      rating,
      comment,
      date: new Date(),
    });

    await doctor.save();

    res.status(201).json({
      message: 'Avis soumis avec succès.',
      review: doctor.reviews[doctor.reviews.length - 1],
    });
  } catch (error) {
    console.error("Erreur lors de la soumission de l'avis:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
