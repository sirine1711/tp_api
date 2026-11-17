const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { hashPassword, matchesPassword, issueToken } = require('../auth');
const { read, write, ok, created, deleted } = require('../endpoint');
const { check, shortText, email, imageUrl, pagination, patchOf, parse } = require('../http');

const users = Router();
const auth = Router();
const password = z.string().min(10).max(128);
const userFields = z.object({
  firstName: shortText,
  lastName: shortText,
  email,
  password,
  avatarUrl: imageUrl.nullable().optional()
}).strict();

const limitAccounts = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Trop de tentatives. Réessayez dans quelques minutes.' } }
});

function userProfile(doc, includeEmail = false) {
  return {
    id: doc._id,
    firstName: doc.firstName,
    lastName: doc.lastName,
    avatarUrl: doc.avatarUrl,
    ...(includeEmail ? { email: doc.email } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

users.post('/', limitAccounts, write(async ({ req, store }) => {
  const { password, ...fields } = parse(userFields, req.body);
  const passwordHash = await hashPassword(password);
  const doc = await store.insert('users', { avatarUrl: null, ...fields, passwordHash });
  return created(userProfile(doc, true));
}, 'none'));

auth.post('/login', limitAccounts, read(async ({ req, store, config }) => {
  const login = parse(z.object({ email, password: z.string().min(1).max(128) }).strict(), req.body);
  const doc = await store.one('users', { email: login.email });
  const valid = await matchesPassword(login.password, doc?.passwordHash);
  check(valid, 401, 'BAD_CREDENTIALS', 'Identifiants incorrects.');
  return ok({ token: issueToken(doc._id, config.jwtSecret), user: userProfile(doc, true) });
}, 'none'));

users.get('/', read(async ({ req, store }) => {
  const input = parse(pagination, req.query);
  return ok(await store.list('users', {}, input, ['firstName', 'lastName'], doc => userProfile(doc)));
}));

users.get('/:userId', read(async ({ param, store, actorId }) => {
  const _id = param('userId');
  const doc = await store.require('users', { _id }, 'Utilisateur');
  return ok(userProfile(doc, actorId === _id));
}));

users.patch('/:userId', write(async ({ req, param, store, actorId }) => {
  const _id = param('userId');
  check(actorId === _id, 403, 'FORBIDDEN', 'Seul le titulaire peut modifier ce compte.');
  const { password, ...fields } = parse(patchOf(userFields), req.body);
  if (password) fields.passwordHash = await hashPassword(password);
  return ok(userProfile(await store.update('users', { _id }, fields), true));
}));

users.delete('/:userId', write(async ({ param, store, actorId }) => {
  const _id = param('userId');
  check(actorId === _id, 403, 'FORBIDDEN', 'Seul le titulaire peut supprimer ce compte.');
  const group = await store.one('groups', { adminIds: _id });
  const event = await store.one('events', { organizerIds: _id });
  check(!group && !event, 409, 'ACTIVE_ROLE', 'Retirez votre rôle d’administrateur ou d’organisateur avant de supprimer ce compte.');

  await store.collection('groups').updateMany({ memberIds: _id }, {
    $pull: { memberIds: _id },
    $currentDate: { updatedAt: true }
  }, store.options);
  await store.collection('events').updateMany({ participantIds: _id }, {
    $pull: { participantIds: _id },
    $currentDate: { updatedAt: true }
  }, store.options);
  await store.remove('users', { _id });
  return deleted();
}));

module.exports = { users, auth };
