const { check } = require('./http');

function includes(ids, actorId) {
  return actorId !== null && ids.includes(actorId);
}

function isTicketShopOpen(event) {
  return event.status === 'published' && event.visibility === 'public' && event.options.ticketingEnabled;
}

function maintain(allowed) {
  check(allowed, 403, 'FORBIDDEN', 'Vous ne pouvez pas modifier cette ressource.');
}

async function groupAccess(ctx, groupId, { member = false, admin = false, lock = false } = {}) {
  const { store, actorId } = ctx;
  const doc = await store.require('groups', { _id: groupId }, 'Groupe');
  const isMember = includes(doc.memberIds, actorId);
  const isAdmin = includes(doc.adminIds, actorId);
  check(doc.visibility !== 'secret' || isMember, 404, 'NOT_FOUND', 'Groupe introuvable.');
  check(!member || isMember, 403, 'FORBIDDEN', 'Cet espace est réservé aux membres du groupe.');
  check(!admin || isAdmin, 403, 'FORBIDDEN', 'Cette action est réservée aux administrateurs du groupe.');
  if (lock) await store.lock('groups', groupId);
  return { doc, isMember, isAdmin };
}

async function eventAccess(ctx, eventId, { participant = false, organizer = false, lock = false } = {}) {
  const { store, actorId } = ctx;
  const doc = await store.require('events', { _id: eventId }, 'Événement');
  const isOrganizer = includes(doc.organizerIds, actorId);
  const isParticipant = includes(doc.participantIds, actorId);
  const visible = isOrganizer || (doc.status === 'published' && (doc.visibility === 'public' || isParticipant));
  check(visible, 404, 'NOT_FOUND', 'Événement introuvable.');
  check(!organizer || isOrganizer, 403, 'FORBIDDEN', 'Cette action est réservée aux organisateurs.');
  check(!participant || isParticipant, 403, 'FORBIDDEN', 'Cet espace est réservé aux participants.');

  let group = null;
  if (doc.groupId) {
    const parent = await groupAccess(ctx, doc.groupId, { lock });
    group = parent.doc;
    check(group.visibility === 'public' || parent.isMember, 404, 'NOT_FOUND', 'Événement introuvable.');
  }
  if (lock) await store.lock('events', eventId);

  return { doc, group, isOrganizer, isParticipant };
}

module.exports = { includes, maintain, groupAccess, eventAccess, isTicketShopOpen };
