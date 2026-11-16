const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/security');

const authenticateToken = (req, res, next) => {
  const cookieToken = req.cookies?.medibook_session;
  const token = cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'Accès non autorisé. Token manquant.' });
  }

  if (cookieToken && token === cookieToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const expectedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
    const requestOrigin = req.get('origin');
    if (requestOrigin && requestOrigin !== expectedOrigin) {
      return res.status(403).json({ error: 'Origine de la requête non autorisée.' });
    }
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
