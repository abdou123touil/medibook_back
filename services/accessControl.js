function isDoctorOwner(user, requestedDoctorId) {
  return Boolean(
    user &&
      user.role === 'doctor' &&
      String(user._id || user.id) === String(requestedDoctorId)
  );
}

function isConversationParticipant(userId, participantOneId, participantTwoId) {
  const actor = String(userId);
  const first = String(participantOneId);
  const second = String(participantTwoId);
  return first !== second && (actor === first || actor === second);
}

module.exports = { isDoctorOwner, isConversationParticipant };
