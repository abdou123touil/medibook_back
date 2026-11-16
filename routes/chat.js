const express = require('express');
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Appointment = require('../models/Appointment');
const authenticateToken = require('../middleware/authenticateToken');
const { isConversationParticipant } = require('../services/accessControl');
require('dotenv').config();
const { OpenAI } = require('openai');

// Configuration de l'API AIML
const baseURL = 'https://api.aimlapi.com/v1';
const apiKey = process.env.AIML_API_KEY || process.env.OPENAI_API_KEY;

const api = new OpenAI({
  apiKey,
  baseURL,
});

module.exports = function (io) {
  const router = express.Router();

  // Générer un ID de conversation cohérent
  const getConversationId = (userId1, userId2) => {
    if (!userId1 || !userId2) {
      console.error('Invalid user IDs:', { userId1, userId2 });
      throw new Error('User IDs cannot be null or undefined');
    }
    // Convertir explicitement en chaînes
    const id1 = String(userId1);
    const id2 = String(userId2);
    const sortedIds = [id1, id2].sort();
    const conversationId = `conv_${sortedIds[0]}_${sortedIds[1]}`;
    console.log(`Generated conversationId: ${conversationId} for IDs: ${userId1}, ${userId2}`);
    return conversationId;
  };

  // Gérer les messages du bot
  io.on('connection', (socket) => {
    console.log(`New client connected in chat.js: ${socket.id}`);

    socket.on('botMessage', async (data = {}) => {
      const { message, userId, conversationId } = data;
      if (String(socket.data.user.id) !== String(userId) || conversationId !== 'bot_medical_advisor' || typeof message !== 'string' || !message.trim() || message.length > 2000) return;

      try {
        const aiResponse = await callMedicalAI(message);

        const botMessage = {
          _id: `bot_${Date.now()}`,
          content: aiResponse,
          senderId: {
            _id: 'bot_medical_advisor',
            firstName: 'MediBot',
            lastName: 'IA',
          },
          receiverId: {
            _id: userId,
            firstName: '',
            lastName: '',
          },
          createdAt: new Date().toISOString(),
          conversationId: conversationId,
          readAt: null,
        };

        console.log('Emitting bot response:', botMessage);
        socket.emit('newMessage', botMessage);
      } catch (err) {
        console.error('Error processing bot message:', err.message, err.stack);
        const errorMessage = {
          _id: `bot_error_${Date.now()}`,
          content: 'Désolé, une erreur est survenue. Veuillez réessayer.',
          senderId: {
            _id: 'bot_medical_advisor',
            firstName: 'MediBot',
            lastName: 'IA',
          },
          receiverId: {
            _id: userId,
            firstName: '',
            lastName: '',
          },
          createdAt: new Date().toISOString(),
          conversationId: conversationId,
          readAt: null,
        };
        console.log('Emitting error message:', errorMessage);
        socket.emit('newMessage', errorMessage);
      }
    });

    socket.on('markAsRead', async ({ conversationId, userId } = {}) => {
      try {
        if (String(socket.data.user.id) !== String(userId)) return;
        const ids = typeof conversationId === 'string' ? conversationId.replace(/^conv_/, '').split('_') : [];
        if (ids.length !== 2 || !ids.includes(String(userId)) || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return;
        const updated = await Chat.updateMany(
          {
            conversationId,
            receiverId: userId,
            readAt: null,
          },
          { $set: { readAt: new Date() } }
        );
        console.log(`Marked ${updated.modifiedCount} messages as read for user ${userId} in conversation ${conversationId}`);
        // Émettre un événement pour informer les clients que les messages ont été lus
        const updatedMessages = await Chat.find({
          conversationId,
          receiverId: userId,
        })
          .populate('senderId', 'firstName lastName')
          .populate('receiverId', 'firstName lastName');
        io.to(conversationId).emit('messagesRead', updatedMessages);
      } catch (err) {
        console.error('Error marking messages as read:', err);
      }
    });
  });

  // Fonction pour appeler l'API AIML
  async function callMedicalAI(message) {
    try {
      const completion = await api.chat.completions.create({
        model: 'mistralai/Mistral-7B-Instruct-v0.2',
        messages: [
          {
            role: 'system',
            content: 'Vous êtes MediBot, un assistant médical IA. Répondez à la question suivante de manière précise, concise et professionnelle.',
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      });

      return completion.choices[0].message.content.trim() || 'Désolé, je ne peux pas répondre à cela pour le moment.';
    } catch (err) {
      console.error('Error calling AIML API:', err.message, err.stack);
      throw err;
    }
  }

  // Route pour récupérer les conversations d'un utilisateur
  router.get('/user/:userId', authenticateToken, async (req, res) => {
    try {
      if (String(req.user.id) !== String(req.params.userId)) return res.status(403).json({ error: 'Accès non autorisé.' });
      const authenticatedUserId = new mongoose.Types.ObjectId(req.user.id);
      const conversations = await Chat.aggregate([
        {
          $match: {
            $or: [{ senderId: authenticatedUserId }, { receiverId: authenticatedUserId }],
          },
        },
        {
          $group: {
            _id: {
              conversationId: {
                $let: {
                  vars: {
                    ids: {
                      $cond: [
                        { $lt: ['$senderId', '$receiverId'] },
                        ['$senderId', '$receiverId'],
                        ['$receiverId', '$senderId'],
                      ],
                    },
                  },
                  in: {
                    $concat: [
                      'conv_',
                      { $arrayElemAt: ['$$ids', 0] },
                      '_',
                      { $arrayElemAt: ['$$ids', 1] },
                    ],
                  },
                },
              },
            },
            lastMessage: { $last: '$$ROOT' },
            unreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$receiverId', authenticatedUserId] },
                      { $eq: ['$readAt', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { 'lastMessage.createdAt': -1 } },
        {
          $lookup: {
            from: 'users',
            localField: 'lastMessage.senderId',
            foreignField: '_id',
            as: 'sender',
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'lastMessage.receiverId',
            foreignField: '_id',
            as: 'receiver',
          },
        },
      ]);

      res.json(
        conversations.map((conv) => ({
          conversationId: conv._id.conversationId,
          lastMessage: conv.lastMessage,
          unreadCount: conv.unreadCount,
          participants: [conv.sender[0], conv.receiver[0]]
            .filter(Boolean)
            .map(({ _id, firstName, lastName }) => ({ _id, firstName, lastName })),
        }))
      );
    } catch (err) {
      console.error('Error fetching conversations:', err);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  });

  // Route pour récupérer les messages d'une conversation
  router.get('/conversation/:userId1/:userId2', authenticateToken, async (req, res) => {
    try {
      const { userId1, userId2 } = req.params;
      if (![userId1, userId2].every(mongoose.Types.ObjectId.isValid) || !isConversationParticipant(req.user.id, userId1, userId2)) {
        return res.status(403).json({ error: 'Accès non autorisé.' });
      }
      const hasAppointment = await Appointment.exists({
        $or: [
          { doctorId: userId1, patientId: userId2 },
          { doctorId: userId2, patientId: userId1 },
        ],
      });
      if (!hasAppointment) return res.status(403).json({ error: 'Aucune consultation commune.' });
      const conversationId = getConversationId(req.params.userId1, req.params.userId2);

      const messages = await Chat.find({
        $or: [
          { senderId: req.params.userId1, receiverId: req.params.userId2 },
          { senderId: req.params.userId2, receiverId: req.params.userId1 },
        ],
      })
        .sort('createdAt')
        .populate('senderId', 'firstName lastName')
        .populate('receiverId', 'firstName lastName');

      res.json(messages);
    } catch (err) {
      console.error('Error fetching messages:', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // Route pour envoyer un message
  router.post('/', authenticateToken, async (req, res) => {
    const { senderId, receiverId, content, appointmentId } = req.body;


    if (!senderId || !receiverId || typeof content !== 'string' || !content.trim() || content.length > 5000 || String(senderId) !== String(req.user.id) || !mongoose.Types.ObjectId.isValid(receiverId)) {
      console.error('Missing required fields:', { senderId, receiverId, content });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      // Convertir explicitement en chaînes pour éviter les problèmes avec ObjectId
      const senderIdStr = String(senderId);
      const receiverIdStr = String(receiverId);
      const appointmentFilter = {
        $or: [
          { doctorId: senderIdStr, patientId: receiverIdStr },
          { doctorId: receiverIdStr, patientId: senderIdStr },
        ],
      };
      if (appointmentId) {
        if (!mongoose.Types.ObjectId.isValid(appointmentId)) return res.status(400).json({ error: 'Rendez-vous invalide.' });
        appointmentFilter._id = appointmentId;
      }
      const hasAppointment = await Appointment.exists(appointmentFilter);
      if (!hasAppointment) return res.status(403).json({ error: 'Aucune consultation commune.' });
      const conversationId = getConversationId(senderIdStr, receiverIdStr);

      const newMessage = new Chat({
        senderId: new mongoose.Types.ObjectId(senderId),
        receiverId: new mongoose.Types.ObjectId(receiverId),
        content: content.trim(),
        appointmentId: appointmentId || null,
        conversationId,
      });

      const savedMessage = await newMessage.save();

      const populatedMessage = await Chat.populate(savedMessage, [
        { path: 'senderId', select: 'firstName lastName' },
        { path: 'receiverId', select: 'firstName lastName' },
      ]);

      // Vérifier les clients dans la salle
      const clientsInRoom = io.sockets.adapter.rooms.get(conversationId);
      io.to(conversationId).emit('newMessage', populatedMessage);

      // Éviter d'émettre deux fois au même client
      if (appointmentId) {
        const appointmentClients = io.sockets.adapter.rooms.get(appointmentId);
        if (appointmentClients && !clientsInRoom?.has(appointmentClients)) {
          io.to(appointmentId).emit('newMessage', populatedMessage);
        }
      }

      res.status(201).json(populatedMessage);
    } catch (err) {
      console.error('Error saving message:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Route pour marquer les messages comme lus
  router.patch('/:conversationId/read', authenticateToken, async (req, res) => {
    try {
      const userId = String(req.user.id);
      const ids = req.params.conversationId.replace(/^conv_/, '').split('_');
      if (ids.length !== 2 || !ids.includes(userId) || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
        return res.status(403).json({ error: 'Accès non autorisé.' });
      }
      const updated = await Chat.updateMany(
        {
          conversationId: req.params.conversationId,
          receiverId: userId,
          readAt: null,
        },
        { $set: { readAt: new Date() } }
      );
      console.log(`Marked ${updated.modifiedCount} messages as read for user ${userId} in conversation ${req.params.conversationId}`);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('Error marking messages as read:', err);
      res.status(500).json({ error: 'Failed to mark messages as read' });
    }
  });

  return router;
};
