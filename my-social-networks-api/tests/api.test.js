const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { MongoClient } = require('mongodb');
const { createApp } = require('../src/app');
const { initDb } = require('../src/db');
require('dotenv').config();

const uri = process.env.TEST_MONGODB_URI || process.env.MONGODB_URI
  || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
const config = { jwtSecret: 'test-secret-for-local-integration-tests-only', publicBaseUrl: 'http://localhost:3000' };
const password = 'DemoPass123!';

let client;
let db;
let server;
let baseUrl;
let owner;
let member;
let outsider;

async function request(method, path, { as, body, status } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(as ? { Authorization: 'Bearer ' + as.token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = response.status === 204 ? null : await response.json();
  if (status !== undefined) {
    assert.equal(response.status, status, method + ' ' + path + ' ' + JSON.stringify(data));
  }
  return { status: response.status, data };
}

async function account(firstName, email) {
  await request('POST', '/users', { body: { firstName, lastName: 'Démo', email, password }, status: 201 });
  const { data } = await request('POST', '/auth/login', { body: { email, password }, status: 200 });
  return data;
}

const coverImageUrl = 'https://example.com/photo.jpg';
const eventBody = {
  name: 'Rencontre du samedi',
  description: 'Ateliers et discussions.',
  startsAt: '2027-06-19T14:00:00+02:00',
  endsAt: '2027-06-19T18:00:00+02:00',
  location: 'Paris',
  coverImageUrl,
  visibility: 'public'
};

async function groupWith(fields = {}) {
  return (await request('POST', '/groups', { as: owner, status: 201, body: {
    name: 'Club de Paris', description: 'Le groupe du club.', visibility: 'public',
    iconUrl: coverImageUrl, coverImageUrl, memberIds: [member.user.id], ...fields
  } })).data;
}

async function createEvent(fields = {}, as = owner) {
  return (await request('POST', '/events', {
    as, status: 201, body: { ...eventBody, ...fields }
  })).data;
}

async function publish(eventId) {
  return (await request('PUT', '/events/' + eventId + '/publication', { as: owner, status: 200 })).data;
}

async function setOptions(eventId, body) {
  return request('PUT', '/events/' + eventId + '/options', { as: owner, body, status: 200 });
}

before(async () => {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db('social_networks_test_' + randomUUID().replace(/-/g, ''));
  await initDb(db);
  server = createApp(client, db, config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  owner = await account('Camille', 'camille@example.test');
  member = await account('Noah', 'noah@example.test');
  outsider = await account('Lou', 'lou@example.test');
});

after(async () => {
  try {
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    if (db) await db.dropDatabase();
  } finally {
    await client?.close();
  }
});

test('Comptes, recherche, unicité de l’email et contrôle du titulaire', async () => {
  await request('GET', '/health', { status: 200 });
  const duplicate = await request('POST', '/users', {
    body: { firstName: 'Autre', lastName: 'Démo', email: ' CAMILLE@example.test ', password },
    status: 409
  });
  assert.equal(duplicate.data.error.code, 'EMAIL_EXISTS');
  const found = await request('GET', '/users?q=Cam&limit=1', { as: member, status: 200 });
  assert.equal(found.data.items[0].id, owner.user.id);
  assert.equal(found.data.items[0].email, undefined);
  assert.equal(found.data.items[0].passwordHash, undefined);
  const literalSearch = await request('GET', '/users?q=.%2A', { as: member, status: 200 });
  assert.equal(literalSearch.data.total, 0);
  await request('GET', '/users', { status: 401 });
  await request('PATCH', '/users/' + owner.user.id, { as: member, body: { firstName: 'Autre' }, status: 403 });

  const disposable = await account('Eli', 'eli@example.test');
  const edit = await request('PATCH', '/users/' + disposable.user.id, {
    as: disposable, body: { firstName: 'Élie' }, status: 200
  });
  assert.equal(edit.data.firstName, 'Élie');
  await request('DELETE', '/users/' + disposable.user.id, { as: disposable, status: 204 });
  await request('GET', '/users/' + disposable.user.id, { as: owner, status: 404 });
  await request('GET', '/users', { as: disposable, status: 401 });
});

test('Visibilité des groupes, permissions de discussion et invitations du groupe', async () => {
  const group = await groupWith({ visibility: 'secret', allowMemberPosts: false });
  const groupPath = '/groups/' + group.id;
  await request('GET', groupPath, { as: outsider, status: 404 });
  const search = await request('GET', '/groups?q=Club&limit=100', { as: outsider, status: 200 });
  assert.ok(search.data.items.every(item => item.id !== group.id));
  await request('PATCH', groupPath, { as: owner, body: { adminIds: [] }, status: 422 });

  const threads = await request('GET', '/threads?groupId=' + group.id, { as: member, status: 200 });
  assert.equal(threads.data.total, 1);
  const messages = '/threads/' + threads.data.items[0].id + '/messages';
  await request('POST', messages, { as: member, body: { content: 'Bonjour' }, status: 403 });
  const { data: msg } = await request('POST', messages, { as: owner, body: { content: 'Bienvenue' }, status: 201 });
  await request('POST', messages + '/' + msg.id + '/comments', { as: member, body: { content: 'Merci' }, status: 201 });

  await request('POST', '/events', {
    as: member, body: { ...eventBody, groupId: group.id, visibility: 'private' }, status: 403
  });
  await request('PATCH', groupPath, { as: owner, body: { allowMemberEvents: true }, status: 200 });
  await request('POST', '/events', {
    as: owner, body: { ...eventBody, groupId: group.id }, status: 422
  });
  const draft = await createEvent({ groupId: group.id, visibility: 'private' });
  assert.deepEqual(new Set(draft.participantIds), new Set([owner.user.id, member.user.id]));
  const path = '/events/' + draft.id;
  await request('GET', path, { as: member, status: 404 });
  await publish(draft.id);
  await request('GET', path, { as: member, status: 200 });
  await request('GET', path, { as: outsider, status: 404 });
  await request('PUT', path + '/options', { as: owner, body: { ticketingEnabled: true }, status: 422 });

  await request('PATCH', groupPath, {
    as: owner, body: { memberIds: [outsider.user.id] }, status: 200
  });
  await request('GET', path, { as: member, status: 404 });
  const invited = await request('POST', path + '/invitations/group-members', { as: owner, status: 200 });
  assert.equal(invited.data.addedCount, 1);
  await request('GET', path, { as: outsider, status: 200 });
  await request('GET', path + '/share', { as: owner, status: 409 });

  await request('DELETE', groupPath, { as: owner, status: 204 });
  await request('GET', path, { as: owner, status: 404 });
  assert.equal(await db.collection('messages').countDocuments({ groupId: group.id }), 0);
  assert.equal(await db.collection('messageComments').countDocuments({ groupId: group.id }), 0);
});

test('Brouillon, options, publication, partage public et règles de modification', async () => {
  await request('POST', '/events', { as: owner, body: { ...eventBody, endsAt: eventBody.startsAt }, status: 422 });
  await request('POST', '/events', {
    as: owner, body: { ...eventBody, startsAt: '2027-06-19T14:00:00+99:00' }, status: 422
  });
  const group = await groupWith();
  const draft = await createEvent({ groupId: group.id, inviteAllGroupMembers: false });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.participantCount, 1);
  const path = '/events/' + draft.id;
  await request('GET', path, { status: 404 });
  await request('GET', path + '/shopping-list', { as: owner, status: 409 });
  await request('PATCH', path, { as: owner, body: { organizerIds: [] }, status: 422 });
  await request('DELETE', '/users/' + owner.user.id, { as: owner, status: 409 });
  await request('PATCH', path, { as: owner, body: { name: 'Atelier Démo' }, status: 200 });
  await setOptions(draft.id, { shoppingListEnabled: true, ticketingEnabled: true });
  const published = await publish(draft.id);
  assert.equal(published.status, 'published');
  assert.equal((await publish(draft.id)).publishedAt, published.publishedAt);
  const publicView = await request('GET', path, { status: 200 });
  assert.equal(publicView.data.participantIds, undefined);
  const listed = await request('GET', '/events?q=atelier&groupId=' + group.id, { status: 200 });
  assert.equal(listed.data.total, 1);
  const share = await request('GET', path + '/share', { as: owner, status: 200 });
  assert.equal(share.data.url, config.publicBaseUrl + '/api/v1' + path);
  await request('GET', path + '/share', { as: outsider, status: 403 });
  await request('PATCH', '/groups/' + group.id, { as: owner, body: { visibility: 'private' }, status: 409 });
});

test('Discussions et albums, commentaires et suppressions en cascade', async () => {
  const event = await createEvent({ participantIds: [member.user.id] });
  const group = await groupWith();
  await publish(event.id);
  await request('POST', '/threads', { as: member, body: { title: 'Sans parent' }, status: 422 });
  await request('POST', '/threads', {
    as: member, body: { title: 'Deux parents', groupId: group.id, eventId: event.id }, status: 422
  });
  const { data: thread } = await request('POST', '/threads', {
    as: member, body: { title: 'Logistique', eventId: event.id }, status: 201
  });
  assert.equal(thread.groupId, undefined);
  const threadPath = '/threads/' + thread.id;
  await request('GET', threadPath, { as: outsider, status: 403 });
  const { data: msg } = await request('POST', threadPath + '/messages', {
    as: member, body: { content: 'Rendez-vous à 14 h.' }, status: 201
  });
  const commentsPath = threadPath + '/messages/' + msg.id + '/comments';
  const { data: comment } = await request('POST', commentsPath, {
    as: owner, body: { content: 'À samedi !' }, status: 201
  });
  await request('PATCH', commentsPath + '/' + comment.id, {
    as: member, body: { content: 'Modifié par un autre membre' }, status: 403
  });
  await request('PATCH', commentsPath + '/' + comment.id, {
    as: owner, body: { content: 'Confirmé.' }, status: 200
  });
  await request('GET', commentsPath + '?q=confirm', { as: member, status: 200 });
  await request('DELETE', threadPath, { as: owner, status: 204 });
  assert.equal(await db.collection('messageComments').countDocuments({ threadId: thread.id }), 0);

  const albums = '/events/' + event.id + '/albums';
  const { data: album } = await request('POST', albums, { as: member, body: { title: 'Souvenirs' }, status: 201 });
  const albumPath = albums + '/' + album.id;
  await request('GET', albumPath, { as: outsider, status: 403 });
  const { data: photo } = await request('POST', albumPath + '/photos', {
    as: member, body: { imageUrl: coverImageUrl, caption: 'Photo de groupe' }, status: 201
  });
  const photoPath = albumPath + '/photos/' + photo.id;
  const photoComment = await request('POST', photoPath + '/comments', {
    as: member, body: { content: 'Super photo' }, status: 201
  });
  assert.equal(photoComment.data.authorId, member.user.id);
  await request('PATCH', photoPath, { as: owner, body: { caption: 'Photo de l’atelier' }, status: 200 });
  await request('DELETE', albumPath, { as: owner, status: 204 });
  assert.equal(await db.collection('photos').countDocuments({ albumId: album.id }), 0);
  assert.equal(await db.collection('photoComments').countDocuments({ albumId: album.id }), 0);
});

test('Sondages, réponses complètes et résultats agrégés', async () => {
  const event = await createEvent({ participantIds: [member.user.id] });
  await publish(event.id);
  const polls = '/events/' + event.id + '/polls';
  const body = {
    title: 'Préférences',
    questions: [
      { text: 'Quel créneau ?', options: ['Matin', 'Après-midi'] },
      { text: 'Quel atelier ?', options: ['Photo', 'Sport'] }
    ]
  };
  await request('POST', polls, { as: member, body, status: 403 });
  await request('POST', polls, { as: owner, body: { title: 'Vide', questions: [] }, status: 422 });
  const { data: poll } = await request('POST', polls, { as: owner, body, status: 201 });
  const path = polls + '/' + poll.id;
  const responses = path + '/responses/me';
  const answers = poll.questions.map(question => ({
    questionId: question.id, optionId: question.options[0].id
  }));
  await request('PUT', responses, { as: member, body: { answers: answers.slice(0, 1) }, status: 422 });
  await request('PUT', responses, { as: member, body: { answers: [answers[0], answers[0]] }, status: 422 });
  await request('PUT', responses, { as: outsider, body: { answers }, status: 403 });
  await request('PUT', responses, { as: member, body: { answers }, status: 200 });
  await request('PUT', responses, { as: member, body: { answers }, status: 200 });
  const { data: results } = await request('GET', path + '/results', { as: owner, status: 200 });
  assert.equal(results.totalResponses, 1);
  assert.deepEqual(results.questions.map(question => question.options.map(option => option.votes)), [[1, 0], [1, 0]]);
  await request('PATCH', path, { as: owner, body: { questions: body.questions }, status: 409 });
  await request('DELETE', responses, { as: member, status: 204 });
  await request('PATCH', path, { as: owner, body: { questions: body.questions }, status: 200 });
});

test('Billetterie publique, stock concurrent et unicité par événement', async () => {
  const event = await createEvent();
  const base = '/events/' + event.id;
  const types = base + '/ticket-types';
  const sales = base + '/tickets';
  await setOptions(event.id, { ticketingEnabled: true });
  const { data: first } = await request('POST', types, {
    as: owner, body: { name: 'Standard', amountCents: 1200, quantity: 1 }, status: 201
  });
  const { data: second } = await request('POST', types, {
    as: owner, body: { name: 'Soutien', amountCents: 2000, quantity: 2 }, status: 201
  });
  const purchase = (email, ticketTypeId) => ({
    ticketTypeId,
    buyer: { firstName: 'Nina', lastName: 'Démo', email,
      address: { street: '1 rue Exemple', postalCode: '75001', city: 'Paris', country: 'France' } }
  });

  await request('GET', types, { status: 404 });
  await publish(event.id);
  await request('GET', types, { status: 200 });
  const concurrent = await Promise.all([
    request('POST', sales, { body: purchase('buyer-a@example.test', first.id) }),
    request('POST', sales, { body: purchase('buyer-b@example.test', first.id) })
  ]);
  assert.deepEqual(concurrent.map(item => item.status).sort(), [201, 409]);
  assert.equal(concurrent.find(item => item.status === 409).data.error.code, 'SOLD_OUT');
  const sale = concurrent.find(item => item.status === 201).data;
  assert.equal(sale.amountCents, 1200);
  assert.ok(sale.purchaseAt);
  const repeated = await request('POST', sales, { body: purchase(sale.buyer.email.toUpperCase(), second.id), status: 409 });
  assert.equal(repeated.data.error.code, 'ALREADY_BOOKED');
  const details = sales + '/' + sale.id;
  await request('GET', details, { as: outsider, status: 403 });
  await request('GET', sales, { status: 401 });
  await request('DELETE', types + '/' + first.id, { as: owner, status: 409 });
  await request('PATCH', types + '/' + first.id, { as: owner, body: { amountCents: 1300 }, status: 200 });
  const retained = await request('GET', details, { as: owner, status: 200 });
  assert.equal(retained.data.amountCents, 1200);
  await request('DELETE', details, { as: owner, status: 204 });
  const stock = await request('GET', types + '/' + first.id, { status: 200 });
  assert.equal(stock.data.available, 1);
  await request('DELETE', '/events/' + event.id, { as: owner, status: 204 });
  assert.equal(await db.collection('ticketTypes').countDocuments({ eventId: event.id }), 0);
});

test('Shopping list unique et covoiturage réservés aux participants', async () => {
  const event = await createEvent({ participantIds: [member.user.id] });
  const base = '/events/' + event.id;
  const shopping = base + '/shopping-list';
  const rides = base + '/rides';
  await setOptions(event.id, { shoppingListEnabled: true, carpoolingEnabled: true });
  await publish(event.id);
  const body = { name: 'Jus de pomme', quantity: 3, arrivalAt: eventBody.startsAt };
  const created = await request('POST', shopping, { as: member, body, status: 201 });
  const sameItem = await request('POST', shopping, { as: owner, body: { ...body, name: ' JUS  DE POMME ' }, status: 409 });
  assert.equal(sameItem.data.error.code, 'ITEM_EXISTS');
  const { data: result } = await request('GET', shopping + '?q=pomme', { as: owner, status: 200 });
  assert.equal(result.total, 1);
  await request('PATCH', shopping + '/' + created.data.id, { as: member, body: { quantity: 4 }, status: 200 });
  const ride = {
    departureLocation: 'Gare de Lyon', departureAt: '2027-06-19T13:00:00+02:00',
    priceCents: 600, availableSeats: 3, maxDetourMinutes: 30
  };
  await request('POST', rides, { as: outsider, body: ride, status: 403 });
  const entry = await request('POST', rides, { as: member, body: ride, status: 201 });
  await request('PATCH', rides + '/' + entry.data.id, { as: member, body: { availableSeats: 2 }, status: 200 });
  await request('DELETE', rides + '/' + entry.data.id, { as: owner, status: 204 });
  await setOptions(event.id, { carpoolingEnabled: false });
  await request('GET', rides, { as: member, status: 409 });
});
