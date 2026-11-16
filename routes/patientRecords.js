const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const AppointmentDetails = require('../models/AppointmentDetails');
const PatientRecord = require('../models/PatientRecord');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');
const { createNotification } = require('../services/notifications');

const router = express.Router();

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
  const doctor = await User.findById(req.user.id).select('_id role');
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
          ? consultation.prescriptions.map((item) => String(item).trim()).filter(Boolean).slice(0, 30)
          : [],
        notes: String(consultation.notes || '').slice(0, 4000),
      };
      const existingIndex = record.consultations.findIndex(
        (entry) => entry.appointmentId.toString() === appointment._id.toString()
      );
      if (existingIndex >= 0) Object.assign(record.consultations[existingIndex], values);
      else {
        record.consultations.push(values);
        consultationWasAdded = true;
      }
      savedAppointmentId = appointment._id;
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
    res.json({ record });
  } catch (error) {
    console.error('Unable to save patient record:', error.message);
    res.status(500).json({ error: 'Impossible d’enregistrer la fiche patient.' });
  }
});

module.exports = router;
