const express = require('express');
const ReviewReaction = require('../models/ReviewReaction');
const router = express.Router();

// Function to count reactions by type for a given review
const countReactions = async (reviewId) => {
    const reactions = await ReviewReaction.find({ reviewId });

    return {
        [reviewId]: reactions.reduce((acc, reaction) => {
            acc[reaction.type] = (acc[reaction.type] || 0) + 1;
            return acc;
        }, {})
    };
};

// ✅ Route: Add or Remove Reaction (Toggles Reaction)
router.post('/react', async (req, res) => {
    try {
        const { reviewId, userId, type } = req.body;

        // Check if user has an existing reaction
        const existingReaction = await ReviewReaction.findOne({ reviewId, userId });

        if (existingReaction) {
            if (existingReaction.type === type) {
                // If same reaction exists, remove it (toggle off)
                await ReviewReaction.deleteOne({ _id: existingReaction._id });
            } else {
                return res.status(400).json({ message: 'Use /update-reaction to change reactions' });
            }
        } else {
            // Add new reaction
            const reaction = new ReviewReaction({ reviewId, userId, type });
            await reaction.save();
        }

        // Get updated reaction counts
        const reactionCounts = await countReactions(reviewId);

        res.status(200).json({ message: 'Reaction updated', reactionCounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ New Route: Update Reaction Type (If User Wants to Change It)
router.put('/update-reaction', async (req, res) => {
    try {
        const { reviewId, userId, newType } = req.body;

        const existingReaction = await ReviewReaction.findOne({ reviewId, userId });

        if (!existingReaction) {
            return res.status(400).json({ message: 'No existing reaction to update' });
        }

        // Update reaction type
        existingReaction.type = newType;
        await existingReaction.save();

        // Get updated reaction counts
        const reactionCounts = await countReactions(reviewId);

        res.status(200).json({ message: 'Reaction updated', reactionCounts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Get all reactions for a review
router.get('/review/:reviewId', async (req, res) => {
    try {
        const { reviewId } = req.params;
        const reactionCounts = await countReactions(reviewId);
        res.status(200).json(reactionCounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Get a user's reaction for a review
router.get('/user-reaction', async (req, res) => {
    try {
        const { userId, reviewId } = req.query;
        const reaction = await ReviewReaction.findOne({ userId, reviewId });

        res.status(200).json({ reaction: reaction ? reaction.type : null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
