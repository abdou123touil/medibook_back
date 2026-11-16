const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/security');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(\S+)$/i) : null;
  const token = match?.[1];

  if (!token) {
    return res.status(401).json({ error: 'Accès non autorisé. Token manquant.' });
  }

  jwt.verify(token, jwtSecret, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token invalide.' });
    }
    req.user = user;
    next();
  });
};

module.exports = authenticateToken;
