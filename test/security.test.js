const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const testSecret = 'test-only-secret-with-at-least-thirty-two-characters';
process.env.JWT_SECRET = testSecret;

const authenticateToken = require('../middleware/authenticateToken');
const { isDoctorOwner, isConversationParticipant } = require('../services/accessControl');

function authenticate(authorization, cookieToken, origin, method = 'GET') {
  return new Promise((resolve) => {
    const req = { headers: authorization ? { authorization } : {} };
    req.cookies = cookieToken ? { medibook_session: cookieToken } : {};
    req.method = method;
    req.get = (name) => name === 'origin' ? origin : undefined;
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; resolve({ req, res: this, nextCalled: false }); return this; },
    };
    authenticateToken(req, res, () => resolve({ req, res, nextCalled: true }));
  });
}

test('rejects JavaScript-readable authorization tokens when no session cookie exists', async () => {
  const missing = await authenticate(undefined);
  const bearer = await authenticate(`Bearer ${jwt.sign({ id: 'user-1' }, testSecret)}`);
  const basic = await authenticate(`Basic ${jwt.sign({ id: 'user-1' }, testSecret)}`);
  assert.equal(missing.res.statusCode, 401);
  assert.equal(bearer.res.statusCode, 401);
  assert.equal(basic.res.statusCode, 401);
  assert.equal(missing.nextCalled, false);
});

test('rejects invalidly signed tokens', async () => {
  const token = jwt.sign({ id: 'user-1' }, 'a-different-secret-with-more-than-32-characters');
  const result = await authenticate(undefined, token);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.nextCalled, false);
});

test('attaches the verified identity to the request', async () => {
  const token = jwt.sign({ id: 'doctor-1', role: 'doctor' }, testSecret);
  const result = await authenticate(undefined, token);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user.id, 'doctor-1');
});

test('accepts an HttpOnly-cookie session and rejects cross-origin cookie writes', async () => {
  const token = jwt.sign({ id: 'doctor-1', role: 'doctor' }, testSecret);
  const read = await authenticate(undefined, token);
  const crossOriginWrite = await authenticate(undefined, token, 'https://untrusted.example', 'POST');
  assert.equal(read.nextCalled, true);
  assert.equal(crossOriginWrite.res.statusCode, 403);
  assert.equal(crossOriginWrite.nextCalled, false);
});

test('doctor data access is limited to the owning doctor account', () => {
  assert.equal(isDoctorOwner({ _id: 'doctor-1', role: 'doctor' }, 'doctor-1'), true);
  assert.equal(isDoctorOwner({ _id: 'doctor-1', role: 'doctor' }, 'doctor-2'), false);
  assert.equal(isDoctorOwner({ _id: 'patient-1', role: 'client' }, 'patient-1'), false);
});

test('conversation access requires the caller to be one of two distinct participants', () => {
  assert.equal(isConversationParticipant('user-1', 'user-1', 'user-2'), true);
  assert.equal(isConversationParticipant('user-3', 'user-1', 'user-2'), false);
  assert.equal(isConversationParticipant('user-1', 'user-1', 'user-1'), false);
});
