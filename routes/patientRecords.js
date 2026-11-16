const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const AppointmentDetails = require('../models/AppointmentDetails');
const PatientRecord = require('../models/PatientRecord');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');
const { createNotification } = require('../services/notifications');
const Notification = require('../models/Notification');
const DoctorAbsence = require('../models/DoctorAbsence');

const router = express.Router();

function prescriptionText(value) {
  if (typeof value === 'string') return value.trim() === '[object Object]' ? '' : value.trim();
  if (typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['name', 'medication', 'medicament', 'drugName', 'medicationName', 'genericName', 'displayName', 'label', 'value', 'text']) {
    const text = prescriptionText(value[key]);
    if (text) return text;
  }
  return '';
}

function includeLegacyConsultations(record, appointments, details) {
  const consultations = [...(record?.consultations || [])];
  const knownAppointments = new Set(consultations.map((entry) => String(entry.appointmentId)));
  const detailsByAppointment = new Map(details.map((entry) => [String(entry.appointmentId), entry]));
  for (const appointment of appointments) {
    const appointmentId = String(appointment._id);
    const detail = detailsByAppointment.get(appointmentId);
    if (!detail || knownAppointments.has(appointmentId)) continue;
    consultations.push({
      appointmentId,
      consultationDate: appointment.date,
      symptoms: appointment.symptoms || '',
      diagnosis: '',
      treatment: '',
      prescriptions: detail.medicaments || [],
      notes: [detail.cause && `Compte rendu précédent : ${detail.cause}`, detail.tarif && `Tarif de consultation : ${detail.tarif} DT`].filter(Boolean).join('\n'),
    });
  }
  consultations.sort((a, b) => new Date(b.consultationDate).getTime() - new Date(a.consultationDate).getTime());
  return record ? { ...record, consultations } : { consultations };
}

async function getDoctorForRequest(req) {
  const doctor = await User.findById(req.user.id).select('_id role availability');
  return doctor?.role === 'doctor' ? doctor : null;
}

router.get('/:patientId/record', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: 'ID patient invalide.' });
    }

    const doctor = await getDoctorForRequest(req);
    if (!doctor) return res.status(403).json({ error: 'Réservé au médecin traitant.' });

    const patient = await User.findOne({ _id: patientId, role: 'client' }).select('_id firstName lastName');
    if (!patient) return res.status(404).json({ error: 'Patient introuvable.' });

    const hasConsulted = await Appointment.exists({ doctorId: doctor._id, patientId: patient._id });
    if (!hasConsulted) return res.status(403).json({ error: 'Aucune consultation avec ce patient.' });

    const [record, appointments] = await Promise.all([
      PatientRecord.findOne({ doctorId: doctor._id, patientId: patient._id }).lean(),
      Appointment.find({ doctorId: doctor._id, patientId: patient._id })
        .select('_id date time status symptoms')
        .sort({ date: -1 })
        .lean(),
    ]);
    const details = await AppointmentDetails.find({ appointmentId: { $in: appointments.map((item) => item._id) } }).lean();

    res.json({ patient, record: includeLegacyConsultations(record, appointments, details), appointments });
  } catch (error) {
    console.error('Unable to load patient record:', error.message);
    res.status(500).json({ error: 'Impossible de charger la fiche patient.' });
  }
});

router.get('/me/records', authenticateToken, async (req, res) => {
  try {
    const patient = await User.findById(req.user.id).select('_id role');
    if (!patient || patient.role !== 'client') {
      return res.status(403).json({ error: 'Réservé au compte patient.' });
    }
    const savedRecords = await PatientRecord.find({ patientId: patient._id })
      .populate('doctorId', 'firstName lastName speciality')
      .sort({ updatedAt: -1 })
      .lean();
    const appointments = await Appointment.find({ patientId: patient._id, status: 'completed' })
      .select('_id doctorId date time symptoms')
      .populate('doctorId', 'firstName lastName speciality')
      .lean();
    const details = await AppointmentDetails.find({ appointmentId: { $in: appointments.map((item) => item._id) } }).lean();
    const appointmentGroups = new Map();
    for (const appointment of appointments) {
      const doctorId = String(appointment.doctorId?._id || appointment.doctorId);
      appointmentGroups.set(doctorId, [...(appointmentGroups.get(doctorId) || []), appointment]);
    }
    const detailGroups = new Map();
    for (const detail of details) {
      const appointment = appointments.find((item) => String(item._id) === String(detail.appointmentId));
      if (!appointment) continue;
      const doctorId = String(appointment.doctorId?._id || appointment.doctorId);
      detailGroups.set(doctorId, [...(detailGroups.get(doctorId) || []), detail]);
    }
    const recordsByDoctor = new Map(savedRecords.map((record) => [String(record.doctorId._id), record]));
    const doctorIds = new Set([...appointmentGroups.keys(), ...recordsByDoctor.keys()]);
    const records = [...doctorIds].map((doctorId) => {
      const record = recordsByDoctor.get(doctorId);
      return includeLegacyConsultations(record, appointmentGroups.get(doctorId) || [], detailGroups.get(doctorId) || []);
    });
    // Keep existing records' populated doctor data in the response; legacy-only records are added below.
    records.forEach((record, index) => {
      if (!record.doctorId) {
        const source = appointments.find((item) => String(item.doctorId?._id || item.doctorId) === [...doctorIds][index]);
        record.doctorId = source?.doctorId || null;
      }
    });
    res.json({ records });
  } catch (error) {
    console.error('Unable to load patient records:', error.message);
    res.status(500).json({ error: 'Impossible de charger l’historique médical.' });
  }
});

router.put('/:patientId/record', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { allergies, medicalHistory, currentMedications, consultation } = req.body;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: 'ID patient invalide.' });
    }

    const doctor = await getDoctorForRequest(req);
    if (!doctor) return res.status(403).json({ error: 'Réservé au médecin traitant.' });

    const patient = await User.findOne({ _id: patientId, role: 'client' }).select('_id');
    if (!patient) return res.status(404).json({ error: 'Patient introuvable.' });

    const hasConsulted = await Appointment.exists({ doctorId: doctor._id, patientId: patient._id });
    if (!hasConsulted) return res.status(403).json({ error: 'Aucune consultation avec ce patient.' });

    let record = await PatientRecord.findOne({ doctorId: doctor._id, patientId: patient._id });
    if (!record) record = new PatientRecord({ doctorId: doctor._id, patientId: patient._id });

    if (allergies !== undefined) record.allergies = String(allergies).slice(0, 4000);
    if (medicalHistory !== undefined) record.medicalHistory = String(medicalHistory).slice(0, 8000);
    if (currentMedications !== undefined) record.currentMedications = String(currentMedications).slice(0, 4000);

    let consultationWasAdded = false;
    let savedAppointmentId = null;
    if (consultation !== undefined) {
      if (!consultation.appointmentId || !mongoose.Types.ObjectId.isValid(consultation.appointmentId)) {
        return res.status(400).json({ error: 'Consultation invalide.' });
      }
      const appointment = await Appointment.findOne({
        _id: consultation.appointmentId,
        doctorId: doctor._id,
        patientId: patient._id,
      });
      if (!appointment) return res.status(403).json({ error: 'Cette consultation ne vous appartient pas.' });
      if (!['accepted', 'completed'].includes(appointment.status)) {
        return res.status(400).json({ error: 'La fiche de consultation est disponible pour les rendez-vous acceptés ou terminés.' });
      }

      const values = {
        appointmentId: appointment._id,
        consultationDate: appointment.date,
        symptoms: appointment.symptoms || '',
        diagnosis: String(consultation.diagnosis || '').slice(0, 2000),
        treatment: String(consultation.treatment || '').slice(0, 4000),
        prescriptions: Array.isArray(consultation.prescriptions)
          ? consultation.prescriptions.map((item) => {
            if (typeof item === 'string') return prescriptionText(item).slice(0, 300) || null;
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
            const prescription = {
              name: prescriptionText(item.name || item.medication || item.medicament || item.drugName || item.medicationName || item.genericName).slice(0, 200),
              dosage: prescriptionText(item.dosage).slice(0, 100),
              route: prescriptionText(item.route).slice(0, 100),
              frequency: prescriptionText(item.frequency).slice(0, 150),
              duration: prescriptionText(item.duration).slice(0, 100),
              quantity: prescriptionText(item.quantity).slice(0, 100),
              instructions: prescriptionText(item.instructions).slice(0, 500),
            };
            return prescription.name ? prescription : null;
          }).filter(Boolean).slice(0, 30)
          : [],
        notes: String(consultation.notes || '').slice(0, 4000),
        followUpAt: consultation.followUpAt ? new Date(consultation.followUpAt) : null,
      };
      const followUpDate = typeof consultation.followUpDate === 'string' ? consultation.followUpDate : '';
      const followUpTime = typeof consultation.followUpTime === 'string' ? consultation.followUpTime : '';
      if (consultation.followUpAt && Number.isNaN(values.followUpAt.getTime())) {
        return res.status(400).json({ error: 'La date de suivi est invalide.' });
      }
      if (consultation.followUpAt && (!/^\d{4}-\d{2}-\d{2}$/.test(followUpDate) || !/^\d{2}:\d{2}$/.test(followUpTime))) {
        return res.status(400).json({ error: 'Choisissez un créneau de suivi valide.' });
      }
      const existingIndex = record.consultations.findIndex(
        (entry) => entry.appointmentId.toString() === appointment._id.toString()
      );
      const previousFollowUp = existingIndex >= 0 ? record.consultations[existingIndex].followUpAt : null;
      const previousFollowUpAppointmentId = existingIndex >= 0 ? record.consultations[existingIndex].followUpAppointmentId : null;
      const previousFollowUpAppointment = previousFollowUpAppointmentId
        ? await Appointment.findOne({ _id: previousFollowUpAppointmentId, doctorId: doctor._id, patientId: patient._id })
        : null;
      let followUpSlotChanged = false;
      if (values.followUpAt) {
        const existingDateKey = previousFollowUpAppointment?.date?.toISOString().slice(0, 10);
        const sameExistingSlot = previousFollowUpAppointment
          && previousFollowUpAppointment.status !== 'cancelled'
          && existingDateKey === followUpDate
          && previousFollowUpAppointment.time === followUpTime;
        followUpSlotChanged = !sameExistingSlot;
        if (followUpSlotChanged) {
          const availabilityForDate = doctor.availability instanceof Map
            ? doctor.availability.get(followUpDate)
            : doctor.availability?.[followUpDate];
          if (!Array.isArray(availabilityForDate) || !availabilityForDate.includes(followUpTime)) {
            return res.status(409).json({ error: 'Ce créneau de suivi n’est plus disponible. Choisissez-en un autre.' });
          }
          const blockedPeriod = await DoctorAbsence.findOne({
            doctorId: doctor._id,
            status: 'active',
            startDate: { $lte: followUpDate },
            endDate: { $gte: followUpDate },
          });
          if (blockedPeriod) return res.status(409).json({ error: 'Cette période est bloquée. Choisissez un autre créneau.' });
          const dayStart = new Date(`${followUpDate}T00:00:00.000Z`);
          const dayEnd = new Date(`${followUpDate}T23:59:59.999Z`);
          const occupied = await Appointment.findOne({
            doctorId: doctor._id,
            date: { $gte: dayStart, $lte: dayEnd },
            time: followUpTime,
            status: { $in: ['pending', 'accepted'] },
          });
          if (occupied) return res.status(409).json({ error: 'Ce créneau vient d’être réservé. Choisissez-en un autre.' });
        }
      }
      if (existingIndex >= 0) Object.assign(record.consultations[existingIndex], values);
      else {
        record.consultations.push(values);
        consultationWasAdded = true;
      }
      savedAppointmentId = appointment._id;
      const previousFollowUpTime = previousFollowUp ? new Date(previousFollowUp).getTime() : null;
      const nextFollowUpTime = values.followUpAt ? values.followUpAt.getTime() : null;
      if (previousFollowUpTime !== nextFollowUpTime) {
        await Notification.updateMany(
          { appointmentId: appointment._id, dedupeKey: { $regex: `^follow-up:${appointment._id}:` }, readAt: null },
          { $set: { readAt: new Date() } }
        );
      }
      if (!values.followUpAt && previousFollowUpAppointment && ['pending', 'accepted'].includes(previousFollowUpAppointment.status)) {
        previousFollowUpAppointment.status = 'cancelled';
        previousFollowUpAppointment.cancelledBy = 'doctor';
        previousFollowUpAppointment.cancellationReason = 'Le suivi recommandé a été retiré par le médecin.';
        await previousFollowUpAppointment.save();
        record.consultations[existingIndex].followUpAppointmentId = null;
        await createNotification({
          userId: patient._id,
          appointmentId: previousFollowUpAppointment._id,
          type: 'appointment',
          title: 'Rendez-vous de suivi annulé',
          message: 'Le médecin a annulé le rendez-vous de suivi précédemment programmé.',
          dedupeKey: `follow-up:${savedAppointmentId}:cancelled:${previousFollowUpAppointment._id}`,
        });
      } else if (values.followUpAt && followUpSlotChanged) {
        const date = new Date(`${followUpDate}T00:00:00.000Z`);
        let followUpAppointment = previousFollowUpAppointment && ['pending', 'accepted'].includes(previousFollowUpAppointment.status)
          ? previousFollowUpAppointment
          : null;
        if (followUpAppointment) {
          followUpAppointment.date = date;
          followUpAppointment.time = followUpTime;
          followUpAppointment.symptoms = 'Suivi médical';
          await followUpAppointment.save();
        } else {
          followUpAppointment = await Appointment.create({
            doctorId: doctor._id,
            patientId: patient._id,
            date,
            time: followUpTime,
            symptoms: 'Suivi médical',
            status: 'accepted',
            isFollowUp: true,
            followUpOfAppointmentId: appointment._id,
          });
        }
        record.consultations[existingIndex >= 0 ? existingIndex : record.consultations.length - 1].followUpAppointmentId = followUpAppointment._id;
      }
      await record.save();
    }

    await record.save();
    if (consultationWasAdded) {
      await createNotification({
        userId: patient._id,
        appointmentId: savedAppointmentId,
        type: 'appointment',
        title: 'Compte rendu disponible',
        message: 'Le médecin a ajouté un compte rendu à votre dossier médical.',
        dedupeKey: `appointment:${savedAppointmentId}:record-added:patient`,
      });
    }
    const savedConsultation = consultation && record.consultations.find(
      (entry) => entry.appointmentId.toString() === String(savedAppointmentId)
    );
    if (savedConsultation?.followUpAt && savedConsultation.followUpAt > new Date()) {
      await createNotification({
        userId: patient._id,
        appointmentId: savedAppointmentId,
        type: 'reminder',
        title: 'Suivi médical recommandé',
        message: 'Un rendez-vous de suivi a été programmé par votre médecin.',
        dedupeKey: `follow-up:${savedAppointmentId}:scheduled:${savedConsultation.followUpAt.toISOString()}`,
      });
    }
    res.json({ record });
  } catch (error) {
    console.error('Unable to save patient record:', error.message);
    res.status(500).json({ error: 'Impossible d’enregistrer la fiche patient.' });
  }
});

module.exports = router;
