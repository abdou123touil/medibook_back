const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ notifications });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les notifications.' });
  }
});

router.patch('/:notificationId/read', authenticateToken, async (req, res) => {
  try {
    const { notificationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ error: 'Notification invalide.' });
    }
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, userId: req.user.id },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification introuvable.' });
    res.json({ notification });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de marquer la notification comme lue.' });
  }
});

router.patch('/:notificationId/action-complete', authenticateToken, async (req, res) => {
  try {
    const { notificationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ error: 'Notification invalide.' });
    }
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, userId: req.user.id, action: 'reschedule_appointment' },
      { $set: { action: null, readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Action introuvable ou déjà traitée.' });
    res.json({ notification });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de traiter cette action.' });
  }
});

module.exports = router;
