const express = require('express');
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
require('dotenv').config();
const { OpenAI } = require('openai');

// Configuration de l'API AIML
const baseURL = 'https://api.aimlapi.com/v1';
const apiKey = process.env.AIML_API_KEY;

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

    socket.on('botMessage', async (data) => {
      const { message, userId, conversationId } = data;
      console.log('Received botMessage:', { message, userId, conversationId });

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
        io.to(conversationId).emit('newMessage', botMessage);
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
        io.to(conversationId).emit('newMessage', errorMessage);
      }
    });

    socket.on('markAsRead', async ({ conversationId, userId }) => {
      try {
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

      console.log('AIML API response:', completion);
      return completion.choices[0].message.content.trim() || 'Désolé, je ne peux pas répondre à cela pour le moment.';
    } catch (err) {
      console.error('Error calling AIML API:', err.message, err.stack);
      throw err;
    }
  }

  // Route pour récupérer les conversations d'un utilisateur
  router.get('/user/:userId', async (req, res) => {
    try {
      const conversations = await Chat.aggregate([
        {
          $match: {
            $or: [{ senderId: req.params.userId }, { receiverId: req.params.userId }],
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
                      { $eq: ['$receiverId', req.params.userId] },
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
          participants: [conv.sender[0], conv.receiver[0]],
        }))
      );
    } catch (err) {
      console.error('Error fetching conversations:', err);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  });

  // Route pour récupérer les messages d'une conversation
  router.get('/conversation/:userId1/:userId2', async (req, res) => {
    try {
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
  router.post('/', async (req, res) => {
    const { senderId, receiverId, content, appointmentId } = req.body;

    console.log('Received POST /api/chat body:', { senderId, receiverId, content, appointmentId });

    if (!senderId || !receiverId || !content) {
      console.error('Missing required fields:', { senderId, receiverId, content });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      // Convertir explicitement en chaînes pour éviter les problèmes avec ObjectId
      const senderIdStr = String(senderId);
      const receiverIdStr = String(receiverId);
      const conversationId = getConversationId(senderIdStr, receiverIdStr);

      const newMessage = new Chat({
        senderId: new mongoose.Types.ObjectId(senderId),
        receiverId: new mongoose.Types.ObjectId(receiverId),
        content,
        appointmentId: appointmentId || null,
        conversationId,
      });

      console.log('New message before save:', newMessage);

      const savedMessage = await newMessage.save();
      console.log('Saved message:', savedMessage);

      const populatedMessage = await Chat.populate(savedMessage, [
        { path: 'senderId', select: 'firstName lastName' },
        { path: 'receiverId', select: 'firstName lastName' },
      ]);

      console.log('Populated message:', populatedMessage);

      // Vérifier les clients dans la salle
      const clientsInRoom = io.sockets.adapter.rooms.get(conversationId);
      console.log(`Clients in room ${conversationId}:`, clientsInRoom ? Array.from(clientsInRoom) : 'None');

      console.log(`Emitting newMessage to conversation ${conversationId}:`, populatedMessage);
      io.to(conversationId).emit('newMessage', populatedMessage);

      // Éviter d'émettre deux fois au même client
      if (appointmentId) {
        const appointmentClients = io.sockets.adapter.rooms.get(appointmentId);
        console.log(`Clients in appointment room ${appointmentId}:`, appointmentClients ? Array.from(appointmentClients) : 'None');
        if (appointmentClients && !clientsInRoom?.has(appointmentClients)) {
          console.log(`Emitting newMessage to appointment ${appointmentId}:`, populatedMessage);
          io.to(appointmentId).emit('newMessage', populatedMessage);
        } else {
          console.log(`Skipping duplicate emission to appointment ${appointmentId}`);
        }
      }

      res.status(201).json(populatedMessage);
    } catch (err) {
      console.error('Error saving message:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Route pour marquer les messages comme lus
  router.patch('/:conversationId/read', async (req, res) => {
    try {
      const { userId } = req.body;
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