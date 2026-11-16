const express = require('express');
const https = require('https');
const User = require('../models/User');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

function searchRxNorm(term) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://rxnav.nlm.nih.gov/REST/approximateTerm.json');
    url.searchParams.set('term', term);
    url.searchParams.set('maxEntries', '8');
    const request = https.get(url, { timeout: 6000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Medication catalog unavailable.'));
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid medication catalog response.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Medication catalog timed out.')));
    request.on('error', reject);
  });
}

router.get('/search', authenticateToken, async (req, res) => {
  const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  if (term.length < 2) return res.json({ results: [] });

  try {
    const user = await User.findById(req.user.id).select('_id role');
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ error: 'Cette recherche est réservée aux médecins.' });
    }

    const data = await searchRxNorm(term);
    const candidates = data?.approxGroup?.candidate || [];
    const uniqueNames = [...new Set(candidates.map((candidate) => candidate.name).filter((name) => typeof name === 'string' && name.trim()))];
    res.json({ results: uniqueNames.slice(0, 8) });
  } catch (error) {
    res.status(502).json({ error: 'Le catalogue de médicaments est momentanément indisponible.' });
  }
});

module.exports = router;
