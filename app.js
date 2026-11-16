const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config/security');
const userRoutes = require('./routes/users');
const appointmentRoutes = require('./routes/appointments');
const reactionRoutes = require('./routes/reactions');
const reviewsRouter = require('./routes/reviews');
const notificationRoutes = require('./routes/notifications');
const Appointment = require('./models/Appointment');
const { createNotification } = require('./services/notifications');
const patientRecordRoutes = require('./routes/patientRecords');
const waitlistRoutes = require('./routes/waitlist');
const medicationRoutes = require('./routes/medications');
const { expireWaitlistOffers } = require('./services/waitlist');
const { expirePastPendingAppointments } = require('./services/appointmentLifecycle');
const { sendAppointmentReminderEmail, retryFailedAppointmentReminderEmails } = require('./services/emailReminders');
const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true, 
}));
app.use(cookieParser());

app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/doctorBooking')
  .then(() => console.log('MongoDB connecté'))
  .catch((err) => console.error('Erreur de connexion MongoDB:', err));

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true, 
  },
});

io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';
  const token = cookie.match(/(?:^|;\s*)medibook_session=([^;]+)/)?.[1];
  if (!token) return next(new Error('Authentification requise.'));
  jwt.verify(token, jwtSecret, (error, user) => {
    if (error) return next(new Error('Jeton invalide.'));
    socket.data.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('joinConversation', async (conversationId) => {
    const userId = String(socket.data.user.id);
    const ids = typeof conversationId === 'string' ? conversationId.replace(/^conv_/, '').split('_') : [];
    if (ids.length !== 2 || !ids.includes(userId) || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return;
    const hasAppointment = await Appointment.exists({
      $or: [
        { doctorId: ids[0], patientId: ids[1] },
        { doctorId: ids[1], patientId: ids[0] },
      ],
    });
    if (hasAppointment) socket.join(conversationId);
  });

  socket.on('leaveConversation', (conversationId) => {
    const ids = typeof conversationId === 'string' ? conversationId.replace(/^conv_/, '').split('_') : [];
    if (ids.length === 2 && ids.includes(String(socket.data.user.id))) socket.leave(conversationId);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const chatRoutes = require('./routes/chat')(io);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/reactions', reactionRoutes);
app.use('/api/reviews', reviewsRouter);
app.use('/api/notifications', notificationRoutes);
app.use('/api/patients', patientRecordRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/medications', medicationRoutes);

// Persist in-app reminders for accepted appointments, once per recipient and reminder window.
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const appointments = await Appointment.find({
      status: 'accepted',
      date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000) },
    })
      .select('_id doctorId patientId date time')
      .populate('patientId', 'firstName email reminderPreferences')
      .populate('doctorId', 'firstName lastName');

    for (const appointment of appointments) {
      const datePart = new Date(appointment.date).toISOString().slice(0, 10);
      const appointmentDateTime = new Date(`${datePart}T${appointment.time}:00`);
      const minutesUntil = (appointmentDateTime.getTime() - now.getTime()) / 60000;
      const patientPreferences = appointment.patientId?.reminderPreferences || {};
      const patientChannels = {
        inAppEnabled: patientPreferences.inAppEnabled !== false,
        emailEnabled: patientPreferences.emailEnabled !== false,
        before24h: patientPreferences.before24h !== false,
        before2h: patientPreferences.before2h !== false,
      };
      const in24HourWindow = minutesUntil > 23 * 60 && minutesUntil <= 24 * 60;
      const in2HourWindow = minutesUntil > 110 && minutesUntil <= 120;
      const in1HourWindow = minutesUntil > 59 && minutesUntil <= 60;

      const patientReminder = in24HourWindow && patientChannels.before24h
        ? { key: '24h', title: 'Rappel de rendez-vous', message: `Votre rendez-vous est prévu demain à ${appointment.time}.` }
        : in2HourWindow && patientChannels.before2h
          ? { key: '2h', title: 'Rendez-vous bientôt', message: `Votre rendez-vous commence dans environ deux heures (${appointment.time}).` }
          : null;
      if (patientReminder && patientChannels.inAppEnabled && appointment.patientId?._id) {
        await createNotification({
          userId: appointment.patientId._id,
          appointmentId: appointment._id,
          type: 'reminder',
          title: patientReminder.title,
          message: patientReminder.message,
          dedupeKey: `appointment:${appointment._id}:reminder:${patientReminder.key}:${appointment.patientId._id}`,
        });
      }

      const doctorReminder = in24HourWindow
        ? { key: '24h', title: 'Rappel de rendez-vous', message: `Votre rendez-vous est prévu demain à ${appointment.time}.` }
        : in1HourWindow
          ? { key: '1h', title: 'Rendez-vous bientôt', message: `Votre rendez-vous commence dans environ une heure (${appointment.time}).` }
          : null;
      if (doctorReminder && appointment.doctorId?._id) {
        await createNotification({
          userId: appointment.doctorId._id,
          appointmentId: appointment._id,
          type: 'reminder',
          title: doctorReminder.title,
          message: doctorReminder.message,
          dedupeKey: `appointment:${appointment._id}:reminder:${doctorReminder.key}:${appointment.doctorId._id}`,
        });
      }

      const emailReminderKey = in24HourWindow && patientChannels.before24h
        ? '24h'
        : in2HourWindow && patientChannels.before2h
          ? '2h'
          : null;
      if (emailReminderKey && patientChannels.emailEnabled && appointment.patientId?.email) {
        await sendAppointmentReminderEmail({
          appointment,
          patient: appointment.patientId,
          doctor: appointment.doctorId,
          reminderKey: emailReminderKey,
        });
      }
    }

    await retryFailedAppointmentReminderEmails();
  } catch (error) {
    console.error('Unable to create appointment reminders:', error.message);
  }
});

cron.schedule('* * * * *', async () => {
  try {
    await expireWaitlistOffers();
  } catch (error) {
    console.error('Unable to rotate expired waitlist offers:', error.message);
  }
});

cron.schedule('* * * * *', async () => {
  try {
    await expirePastPendingAppointments();
  } catch (error) {
    console.error('Unable to expire past pending appointments:', error.message);
  }
});

server.listen(PORT, () => console.log(`Serveur en cours d'exécution sur le port ${PORT}`));
