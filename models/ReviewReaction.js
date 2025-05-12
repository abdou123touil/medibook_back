const mongoose = require('mongoose');

const reviewReactionSchema = new mongoose.Schema({
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['like', 'heart','dislike'], required: true },
}, { timestamps: true });

module.exports = mongoose.model('ReviewReaction', reviewReactionSchema);
