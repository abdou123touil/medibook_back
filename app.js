const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();
const userRoutes = require('./routes/users');
const appointmentRoutes = require('./routes/appointments');
const reactionRoutes = require('./routes/reactions');
const reviewsRouter = require('./routes/reviews');
const notificationRoutes = require('./routes/notifications');
const Appointment = require('./models/Appointment');
const { createNotification } = require('./services/notifications');
const patientRecordRoutes = require('./routes/patientRecords');
const waitlistRoutes = require('./routes/waitlist');
const { expireWaitlistOffers } = require('./services/waitlist');
const { expirePastPendingAppointments } = require('./services/appointmentLifecycle');
const { sendAppointmentReminderEmail, retryFailedAppointmentReminderEmails } = require('./services/emailReminders');
const app = express();
const server = http.createServer(app);

const PORT = 3000;

app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true, 
}));

app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose.connect('mongodb://localhost:27017/doctorBooking')
  .then(() => console.log('MongoDB connecté'))
  .catch((err) => console.error('Erreur de connexion MongoDB:', err));

const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true, 
  },
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`Client ${socket.id} joined conversation ${conversationId}`);
    console.log(`Client ${socket.id} rooms:`, Array.from(socket.rooms));
  });

  socket.on('leaveConversation', (conversationId) => {
    socket.leave(conversationId);
    console.log(`Client ${socket.id} left conversation ${conversationId}`);
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

// Persist in-app reminders for accepted appointments, once per recipient and reminder window.
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const appointments = await Appointment.find({
      status: 'accepted',
      date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000) },
    })
      .select('_id doctorId patientId date time')
      .populate('patientId', 'firstName email')
      .populate('doctorId', 'firstName lastName');

    for (const appointment of appointments) {
      const datePart = new Date(appointment.date).toISOString().slice(0, 10);
      const appointmentDateTime = new Date(`${datePart}T${appointment.time}:00`);
      const minutesUntil = (appointmentDateTime.getTime() - now.getTime()) / 60000;
      let reminder;
      let emailReminderKey;
      if (minutesUntil > 23 * 60 && minutesUntil <= 24 * 60) {
        reminder = { key: '24h', title: 'Rappel de rendez-vous', message: `Votre rendez-vous est prévu demain à ${appointment.time}.` };
      } else if (minutesUntil > 59 && minutesUntil <= 60) {
        reminder = { key: '1h', title: 'Rendez-vous bientôt', message: `Votre rendez-vous commence dans environ une heure (${appointment.time}).` };
      }

      if (minutesUntil > 23 * 60 && minutesUntil <= 24 * 60) {
        emailReminderKey = '24h';
      } else if (minutesUntil > 110 && minutesUntil <= 120) {
        emailReminderKey = '2h';
      }

      if (reminder) {
        await Promise.all([appointment.doctorId, appointment.patientId].map((user) =>
          createNotification({
            userId: user?._id || user,
            appointmentId: appointment._id,
            type: 'reminder',
            title: reminder.title,
            message: reminder.message,
            dedupeKey: `appointment:${appointment._id}:reminder:${reminder.key}:${user?._id || user}`,
          })
        ));
      }

      if (emailReminderKey && appointment.patientId?.email) {
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
