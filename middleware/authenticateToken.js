const jwt = require('jsonwebtoken');

const JWT_SECRET = 'abdou123touil';  // Vous pouvez aussi charger cette clé depuis une variable d'environnement.

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Accès non autorisé. Token manquant.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token invalide.' });
        req.user = user; // Ajouter les données du token au req pour les routes suivantes
        next();
    });
}

module.exports = authenticateToken;
