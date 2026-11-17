const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const { ApiError, check } = require('./http');

const deriveKey = promisify(scrypt);
const issuer = 'my-social-networks-api';
const missingHash = Buffer.alloc(64);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await deriveKey(password, salt, 64);
  return salt + ':' + hash.toString('hex');
}

async function matchesPassword(password, stored) {
  const [salt, hash] = stored ? stored.split(':') : ['0'.repeat(32), null];
  const expected = hash ? Buffer.from(hash, 'hex') : missingHash;
  const candidate = await deriveKey(password, salt, 64);
  return timingSafeEqual(candidate, expected) && Boolean(stored);
}

function issueToken(userId, secret) {
  return jwt.sign({}, secret, { algorithm: 'HS256', subject: userId, issuer, expiresIn: '2h' });
}

function authenticate(req, mode, secret) {
  if (mode === 'none') return null;

  const authorization = req.get('authorization');
  if (!authorization && mode === 'optional') return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization || '');
  check(match, 401, 'UNAUTHORIZED', 'Un jeton Bearer valide est requis.');

  try {
    const payload = jwt.verify(match[1], secret, { algorithms: ['HS256'], issuer });
    if (typeof payload.sub === 'string') return payload.sub;
  } catch {
    throw new ApiError(401, 'INVALID_TOKEN', 'Le jeton est invalide ou expiré.');
  }
  throw new ApiError(401, 'INVALID_TOKEN', 'Le jeton est invalide ou expiré.');
}

module.exports = { hashPassword, matchesPassword, issueToken, authenticate };
