const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Appointment = require('../models/Appointment');
const AppointmentDetails = require('../models/AppointmentDetails');
const PatientRecord = require('../models/PatientRecord');
const PatientRecordAudit = require('../models/PatientRecordAudit');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Review = require('../models/Review');
const WaitlistEntry = require('../models/WaitlistEntry');
const authenticateToken = require('../middleware/authenticateToken');
const { createNotification } = require('../services/notifications');
const Notification = require('../models/Notification');
const DoctorAbsence = require('../models/DoctorAbsence');

const router = express.Router();
const medicalFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedTypes.includes(file.mimetype)) return callback(new Error('Format non pris en charge. Utilisez un PDF, JPG ou PNG.'));
    callback(null, true);
  },
});

function medicalFileUploadMiddleware(req, res, next) {
  medicalFileUpload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message || 'Fichier invalide.' });
    next();
  });
}

function hasValidMedicalFileSignature(file) {
  if (file.mimetype === 'application/pdf') return file.buffer.subarray(0, 5).toString() === '%PDF-';
  if (file.mimetype === 'image/png') return file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === 'image/jpeg') return file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  return false;
}

async function getAuthorizedPatientRecord(req) {
  if (!mongoose.Types.ObjectId.isValid(req.params.patientId)) return { status: 400, error: 'ID patient invalide.' };
  const doctor = await getDoctorForRequest(req);
  if (!doctor) return { status: 403, error: 'Réservé au médecin traitant.' };
  const patient = await User.findOne({ _id: req.params.patientId, role: 'client' }).select('_id');
  if (!patient) return { status: 404, error: 'Patient introuvable.' };
  const hasConsulted = await Appointment.exists({ doctorId: doctor._id, patientId: patient._id, status: { $in: ['accepted', 'completed'] } });
  if (!hasConsulted) return { status: 403, error: 'Aucune consultation avec ce patient.' };
  return { doctor, patient };
}

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
      price: appointment.isFollowUp ? 0 : (Number.isFinite(Number(detail.tarif)) && Number(detail.tarif) >= 0 ? Number(detail.tarif) : 70),
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

router.post('/:patientId/attachments', authenticateToken, medicalFileUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Sélectionnez un fichier.' });
    if (!hasValidMedicalFileSignature(req.file)) return res.status(400).json({ error: 'Le contenu du fichier ne correspond pas à son format déclaré.' });
    const access = await getAuthorizedPatientRecord(req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    let record = await PatientRecord.findOne({ doctorId: access.doctor._id, patientId: access.patient._id });
    if (!record) record = new PatientRecord({ doctorId: access.doctor._id, patientId: access.patient._id });
    const currentBytes = (record.attachments || []).reduce((sum, attachment) => sum + attachment.size, 0);
    if (record.attachments.length >= 20 || currentBytes + req.file.size > 12 * 1024 * 1024) {
      return res.status(413).json({ error: 'La fiche a atteint sa limite de pièces jointes.' });
    }
    const safeName = String(req.file.originalname || 'document')
      .replace(/[\\/\0-\x1f\x7f]/g, '_').slice(-180) || 'document';
    record.attachments.push({ fileName: safeName, mimeType: req.file.mimetype, size: req.file.size, data: req.file.buffer });
    await record.save();
    const attachment = record.attachments[record.attachments.length - 1];
    await PatientRecordAudit.create({ patientId: access.patient._id, doctorId: access.doctor._id, actorId: access.doctor._id, action: 'attachment_uploaded', attachmentName: safeName });
    res.status(201).json({ attachment: { id: String(attachment._id), fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size, uploadedAt: attachment.uploadedAt } });
  } catch (error) {
    console.error('Unable to upload patient attachment:', error.message);
    res.status(500).json({ error: 'Impossible d’ajouter la pièce jointe.' });
  }
});

router.get('/:patientId/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.attachmentId)) return res.status(400).json({ error: 'Pièce jointe invalide.' });
    const access = await getAuthorizedPatientRecord(req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const record = await PatientRecord.findOne({ doctorId: access.doctor._id, patientId: access.patient._id }).select('+attachments.data');
    const attachment = record?.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    const safeName = attachment.fileName.replace(/[\r\n"\\]/g, '_');
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Length': String(attachment.size),
      'Content-Disposition': `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(attachment.data);
  } catch (error) {
    console.error('Unable to download patient attachment:', error.message);
    res.status(500).json({ error: 'Impossible de télécharger la pièce jointe.' });
  }
});

router.delete('/:patientId/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.attachmentId)) return res.status(400).json({ error: 'Pièce jointe invalide.' });
    const access = await getAuthorizedPatientRecord(req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const record = await PatientRecord.findOne({ doctorId: access.doctor._id, patientId: access.patient._id });
    const attachment = record?.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    const attachmentName = attachment.fileName;
    attachment.deleteOne();
    await record.save();
    await PatientRecordAudit.create({ patientId: access.patient._id, doctorId: access.doctor._id, actorId: access.doctor._id, action: 'attachment_deleted', attachmentName });
    res.json({ success: true });
  } catch (error) {
    console.error('Unable to delete patient attachment:', error.message);
    res.status(500).json({ error: 'Impossible de supprimer la pièce jointe.' });
  }
});

router.get('/:patientId/record', authenticateToken, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: 'ID patient invalide.' });
    }

    const doctor = await getDoctorForRequest(req);
    if (!doctor) return res.status(403).json({ error: 'Réservé au médecin traitant.' });

    const patient = await User.findOne({ _id: patientId, role: 'client' }).select('_id firstName lastName dateOfBirth');
    if (!patient) return res.status(404).json({ error: 'Patient introuvable.' });

    const hasConsulted = await Appointment.exists({ doctorId: doctor._id, patientId: patient._id, status: { $in: ['accepted', 'completed'] } });
    if (!hasConsulted) return res.status(403).json({ error: 'Aucune consultation avec ce patient.' });

    const [record, appointments, auditHistory] = await Promise.all([
      PatientRecord.findOne({ doctorId: doctor._id, patientId: patient._id }).lean(),
      Appointment.find({ doctorId: doctor._id, patientId: patient._id, status: { $in: ['accepted', 'completed'] } })
        .select('_id date time status symptoms isFollowUp')
        .sort({ date: -1 })
        .lean(),
      PatientRecordAudit.find({ doctorId: doctor._id, patientId: patient._id })
        .populate('actorId', 'firstName lastName role').sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    const details = await AppointmentDetails.find({ appointmentId: { $in: appointments.map((item) => item._id) } }).lean();

    res.json({ patient, record: includeLegacyConsultations(record, appointments, details), appointments, auditHistory });
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
      .select('_id doctorId date time symptoms isFollowUp')
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

router.get('/me/export', authenticateToken, async (req, res) => {
  try {
    const patient = await User.findById(req.user.id)
      .select('firstName lastName email phoneNumber dateOfBirth address location role profileImage createdAt');
    if (!patient || patient.role !== 'client') return res.status(403).json({ error: 'Réservé au compte patient.' });

    const [appointments, records, notifications, conversations, reviews, waitlistEntries, auditHistory] = await Promise.all([
      Appointment.find({ patientId: patient._id }).populate('doctorId', 'firstName lastName speciality').sort({ date: -1, time: -1 }).lean(),
      PatientRecord.find({ patientId: patient._id }).populate('doctorId', 'firstName lastName speciality').sort({ updatedAt: -1 }).lean(),
      Notification.find({ userId: patient._id }).select('type title message action waitlistEntryId createdAt readAt appointmentId').sort({ createdAt: -1 }).lean(),
      Chat.find({ $or: [{ senderId: patient._id }, { receiverId: patient._id }] }).select('senderId receiverId appointmentId content readAt createdAt updatedAt').sort({ createdAt: 1 }).lean(),
      Review.find({ patientId: patient._id }).select('doctorId patientName rating comment date createdAt').sort({ date: -1 }).lean(),
      WaitlistEntry.find({ patientId: patient._id }).select('doctorId date symptoms status offeredTime offeredUntil appointmentId createdAt updatedAt').sort({ createdAt: -1 }).lean(),
      PatientRecordAudit.find({ patientId: patient._id }).populate('doctorId', 'firstName lastName speciality').populate('actorId', 'firstName lastName role').sort({ createdAt: -1 }).lean(),
    ]);
    const legacyDetails = appointments.length ? await AppointmentDetails.find({ appointmentId: { $in: appointments.map((item) => item._id) } }).lean() : [];
    const exportData = {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      notice: 'Medical attachment files remain available for secure individual download; this export contains their metadata.',
      profile: patient.toObject(),
      appointments,
      medicalRecords: records,
      medicalRecordChangeHistory: auditHistory,
      legacyConsultationDetails: legacyDetails,
      notifications,
      conversations,
      reviews,
      waitlistEntries,
    };
    const fileName = `medibook-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'private, no-store' });
    res.send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    console.error('Unable to export patient data:', error.message);
    res.status(500).json({ error: 'Impossible de préparer l’export de vos données.' });
  }
});

router.get('/me/attachments/:doctorId/:attachmentId', authenticateToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.doctorId) || !mongoose.Types.ObjectId.isValid(req.params.attachmentId)) {
      return res.status(400).json({ error: 'Pièce jointe invalide.' });
    }
    const patient = await User.findById(req.user.id).select('_id role');
    if (!patient || patient.role !== 'client') return res.status(403).json({ error: 'Réservé au compte patient.' });
    const record = await PatientRecord.findOne({ patientId: patient._id, doctorId: req.params.doctorId }).select('+attachments.data');
    const attachment = record?.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
    const safeName = attachment.fileName.replace(/[\r\n"\\]/g, '_');
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Length': String(attachment.size),
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(attachment.data);
  } catch (error) {
    console.error('Unable to download patient-owned attachment:', error.message);
    res.status(500).json({ error: 'Impossible de télécharger la pièce jointe.' });
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

    const hasConsulted = await Appointment.exists({ doctorId: doctor._id, patientId: patient._id, status: { $in: ['accepted', 'completed'] } });
    if (!hasConsulted) return res.status(403).json({ error: 'Aucune consultation avec ce patient.' });

    let record = await PatientRecord.findOne({ doctorId: doctor._id, patientId: patient._id });
    if (!record) record = new PatientRecord({ doctorId: doctor._id, patientId: patient._id });
    const recordWasNew = record.isNew;
    const directFields = ['allergies', 'medicalHistory', 'currentMedications'];
    const previousDirectValues = Object.fromEntries(directFields.map((field) => [field, record[field] || '']));
    const targetAppointmentId = consultation?.appointmentId ? String(consultation.appointmentId) : '';
    const previousConsultation = targetAppointmentId
      ? record.consultations.find((entry) => String(entry.appointmentId) === targetAppointmentId)
      : null;
    const previousConsultationValues = previousConsultation ? {
      price: previousConsultation.price ?? 70,
      amountPaid: previousConsultation.amountPaid ?? 0,
      paymentStatus: previousConsultation.paymentStatus || 'unpaid',
      paymentMethod: previousConsultation.paymentMethod || null,
      diagnosis: previousConsultation.diagnosis || '',
      treatment: previousConsultation.treatment || '',
      prescriptions: previousConsultation.prescriptions || [],
      notes: previousConsultation.notes || '',
      followUpAt: previousConsultation.followUpAt || null,
    } : null;

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

      let storedPrice = Number(previousConsultation?.price);
      if (!appointment.isFollowUp && (!Number.isFinite(storedPrice) || storedPrice < 0)) {
        const legacyDetails = await AppointmentDetails.findOne({ appointmentId: appointment._id }).select('tarif').lean();
        storedPrice = Number(legacyDetails?.tarif);
      }
      const hasStoredPrice = Number.isFinite(storedPrice) && storedPrice >= 0;
      let consultationPrice = appointment.isFollowUp ? 0 : (hasStoredPrice ? storedPrice : 70);
      if (!appointment.isFollowUp && consultation.price !== undefined) {
        const requestedPrice = Number(consultation.price);
        const keepingHistoricalPrice = hasStoredPrice && storedPrice < 70 && requestedPrice === storedPrice;
        if (!Number.isFinite(requestedPrice) || (requestedPrice < 70 && !keepingHistoricalPrice) || requestedPrice > 1000000) {
          return res.status(400).json({ error: 'Le tarif minimum d’une consultation est de 70 DT.' });
        }
        consultationPrice = Math.round(requestedPrice * 100) / 100;
      }

      const validPaymentMethods = ['cash', 'card', 'transfer', 'other'];
      const oldAmountPaid = Number(previousConsultation?.amountPaid) || 0;
      const requestedAmountPaid = appointment.isFollowUp
        ? 0
        : consultation.amountPaid === undefined ? oldAmountPaid : Number(consultation.amountPaid);
      if (!Number.isFinite(requestedAmountPaid) || requestedAmountPaid < 0 || requestedAmountPaid > consultationPrice) {
        return res.status(400).json({ error: 'Le montant réglé doit être compris entre 0 et le tarif de la consultation.' });
      }
      const requestedPaymentMethod = appointment.isFollowUp
        ? null
        : consultation.paymentMethod === undefined ? (previousConsultation?.paymentMethod || null) : consultation.paymentMethod || null;
      if (requestedAmountPaid > 0 && !validPaymentMethods.includes(requestedPaymentMethod)) {
        return res.status(400).json({ error: 'Choisissez un moyen de paiement pour le montant réglé.' });
      }
      const paymentStatus = appointment.isFollowUp || consultationPrice === 0
        ? 'not_applicable'
        : requestedAmountPaid >= consultationPrice ? 'paid' : requestedAmountPaid > 0 ? 'partial' : 'unpaid';
      const paymentChanged = requestedAmountPaid !== oldAmountPaid || requestedPaymentMethod !== (previousConsultation?.paymentMethod || null);
      const paymentChangedAt = paymentChanged ? new Date() : previousConsultation?.paymentUpdatedAt || null;
      const paymentTransactions = [...(previousConsultation?.paymentTransactions || [])];
      // Migrate historical totals into a single dated entry so existing payments remain reportable.
      if (paymentTransactions.length === 0 && oldAmountPaid > 0) {
        paymentTransactions.push({
          type: 'payment',
          amount: oldAmountPaid,
          method: previousConsultation?.paymentMethod || null,
          paidAt: previousConsultation?.paymentUpdatedAt || appointment.date,
        });
      }
      if (requestedAmountPaid > oldAmountPaid) {
        paymentTransactions.push({
          type: 'payment',
          amount: requestedAmountPaid - oldAmountPaid,
          method: requestedPaymentMethod,
          paidAt: paymentChangedAt || new Date(),
        });
      } else if (requestedAmountPaid < oldAmountPaid) {
        paymentTransactions.push({
          type: 'refund',
          amount: oldAmountPaid - requestedAmountPaid,
          method: previousConsultation?.paymentMethod || requestedPaymentMethod,
          paidAt: paymentChangedAt || new Date(),
        });
      }
      const paymentUpdatedAt = requestedAmountPaid > 0
        ? paymentChangedAt || new Date()
        : null;

      const values = {
        appointmentId: appointment._id,
        consultationDate: appointment.date,
        price: consultationPrice,
        amountPaid: requestedAmountPaid,
        paymentStatus,
        paymentMethod: requestedPaymentMethod,
        paymentUpdatedAt,
        paymentTransactions,
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
        previousFollowUpAppointment.cancelledAt = new Date();
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
    const changedFields = directFields.filter((field) =>
      String(previousDirectValues[field]) !== String(record[field] || '')
    );
    if (consultation && targetAppointmentId) {
      const currentConsultation = record.consultations.find((entry) => String(entry.appointmentId) === targetAppointmentId);
      const currentValues = {
        price: currentConsultation?.price ?? 70,
        amountPaid: currentConsultation?.amountPaid ?? 0,
        paymentStatus: currentConsultation?.paymentStatus || 'unpaid',
        paymentMethod: currentConsultation?.paymentMethod || null,
        diagnosis: currentConsultation?.diagnosis || '',
        treatment: currentConsultation?.treatment || '',
        prescriptions: currentConsultation?.prescriptions || [],
        notes: currentConsultation?.notes || '',
        followUpAt: currentConsultation?.followUpAt || null,
      };
      for (const field of Object.keys(currentValues)) {
        if (JSON.stringify(previousConsultationValues?.[field] ?? (field === 'prescriptions' ? [] : field === 'followUpAt' || field === 'paymentMethod' ? null : field === 'amountPaid' ? 0 : field === 'paymentStatus' ? 'unpaid' : '')) !== JSON.stringify(currentValues[field])) {
          changedFields.push(`consultation.${field}`);
        }
      }
    }
    if (changedFields.length) {
      await PatientRecordAudit.create({
        patientId: patient._id,
        doctorId: doctor._id,
        actorId: doctor._id,
        action: recordWasNew ? 'record_created' : 'record_updated',
        changedFields,
      });
    }
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
