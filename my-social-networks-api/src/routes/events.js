const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { eventAccess, groupAccess, includes } = require('../access');
const { record } = require('../db');
const { removeEventData } = require('../cleanup');
const { check, shortText, longText, imageUrl, id, idList, dateTime, pagination, patchOf, parse } = require('../http');

const events = Router();
const eventFields = z.object({
  name: shortText,
  description: longText,
  startsAt: dateTime,
  endsAt: dateTime,
  location: z.string().trim().min(1).max(500),
  coverImageUrl: imageUrl,
  visibility: z.enum(['public', 'private']),
  organizerIds: idList.optional(),
  participantIds: idList.optional()
}).strict();

const newEvent = eventFields.extend({
  groupId: id.optional(),
  inviteAllGroupMembers: z.boolean().optional()
});

const eventOptions = z.object({
  shoppingListEnabled: z.boolean().default(false),
  carpoolingEnabled: z.boolean().default(false),
  ticketingEnabled: z.boolean().default(false)
}).strict();

function eventView(doc, actorId) {
  const { participantIds, ...fields } = record(doc);
  return {
    ...fields,
    participantCount: participantIds.length,
    ...(includes(participantIds, actorId) ? { participantIds } : {})
  };
}

function verifyConfiguration(event, group) {
  check(event.endsAt > event.startsAt, 422, 'INVALID_DATES', 'La fin doit être postérieure au début.');
  check(!event.options.ticketingEnabled || event.visibility === 'public', 422, 'PUBLIC_TICKETING_ONLY',
    'Désactivez la billetterie avant de rendre l’événement privé.');
  if (!group || group.visibility === 'public') return;
  check(event.visibility === 'private', 422, 'PRIVATE_GROUP_EVENT', 'Un événement d’un groupe restreint doit être privé.');
  check(event.participantIds.every(userId => group.memberIds.includes(userId)), 422, 'GROUP_MEMBERS_ONLY',
    'Les organisateurs et participants doivent être membres du groupe.');
}

events.post('/', write(async ctx => {
  const { req, store, actorId } = ctx;
  const { groupId, inviteAllGroupMembers, organizerIds = [], participantIds = [], ...fields } = parse(newEvent, req.body);
  check(groupId || inviteAllGroupMembers !== true, 422, 'GROUP_REQUIRED', 'Sélectionnez un groupe pour inviter ses membres.');

  let group = null;
  if (groupId) {
    const parent = await groupAccess(ctx, groupId, { member: true, lock: true });
    group = parent.doc;
    check(parent.isAdmin || group.allowMemberEvents, 403, 'FORBIDDEN', 'La création d’événements est réservée aux administrateurs du groupe.');
  }

  const organizers = [...new Set([actorId, ...organizerIds])];
  const invitations = group && inviteAllGroupMembers !== false ? group.memberIds : [];
  const attendees = [...new Set([...organizers, ...participantIds, ...invitations])];
  const event = {
    ...fields,
    groupId: groupId ?? null,
    organizerIds: organizers,
    participantIds: attendees,
    options: eventOptions.parse({}),
    status: 'draft',
    publishedAt: null
  };
  verifyConfiguration(event, group);
  await store.ensureUsers(attendees);
  return created(eventView(await store.insert('events', event), actorId));
}));

events.get('/', read(async ctx => {
  const { store, req, actorId } = ctx;
  const input = parse(pagination.extend({
    groupId: id.optional(),
    status: z.enum(['draft', 'published']).optional()
  }), req.query);
  const filters = [{ status: 'published', visibility: 'public' }];
  if (actorId) {
    filters.push({ organizerIds: actorId }, { status: 'published', participantIds: actorId });
  }
  const filter = { $or: filters };
  if (input.groupId) {
    await groupAccess(ctx, input.groupId);
    filter.groupId = input.groupId;
  }
  if (input.status) filter.status = input.status;
  return ok(await store.list('events', filter, input, ['name', 'description', 'location'], doc => eventView(doc, actorId)));
}, 'optional'));

events.get('/:eventId', read(async ctx => {
  const { doc } = await eventAccess(ctx, ctx.param('eventId'));
  return ok(eventView(doc, ctx.actorId));
}, 'optional'));

events.patch('/:eventId', write(async ctx => {
  const { req, store, actorId } = ctx;
  const _id = ctx.param('eventId');
  const { doc, group } = await eventAccess(ctx, _id, { organizer: true, lock: true });
  const input = parse(patchOf(eventFields), req.body);
  const organizerIds = input.organizerIds ?? doc.organizerIds;
  check(organizerIds.length > 0, 422, 'ORGANIZER_REQUIRED', 'L’événement doit avoir au moins un organisateur.');
  const participantIds = [...new Set([...organizerIds, ...(input.participantIds ?? doc.participantIds)])];
  verifyConfiguration({ ...doc, ...input, participantIds }, group);
  if (input.organizerIds || input.participantIds) await store.ensureUsers(participantIds);

  const updated = await store.update('events', { _id }, { ...input, organizerIds, participantIds });
  return ok(eventView(updated, actorId));
}));

events.put('/:eventId/options', write(async ctx => {
  const _id = ctx.param('eventId');
  const { doc, group } = await eventAccess(ctx, _id, { organizer: true, lock: true });
  const options = parse(eventOptions, ctx.req.body);
  verifyConfiguration({ ...doc, options }, group);
  return ok(eventView(await ctx.store.update('events', { _id }, { options }), ctx.actorId));
}));

events.put('/:eventId/publication', write(async ctx => {
  const _id = ctx.param('eventId');
  const { doc, group } = await eventAccess(ctx, _id, { organizer: true, lock: true });
  if (doc.status === 'published') return ok(eventView(doc, ctx.actorId));

  verifyConfiguration(doc, group);
  const published = await ctx.store.update('events', { _id }, { status: 'published', publishedAt: new Date() });
  return ok(eventView(published, ctx.actorId));
}));

events.post('/:eventId/invitations/group-members', write(async ctx => {
  const _id = ctx.param('eventId');
  const { doc, group } = await eventAccess(ctx, _id, { organizer: true, lock: true });
  check(group, 422, 'GROUP_REQUIRED', 'Cet événement n’est associé à aucun groupe.');
  check(includes(group.memberIds, ctx.actorId), 403, 'FORBIDDEN', 'Vous devez être membre pour inviter le groupe.');
  const participantIds = [...new Set([...doc.participantIds, ...group.memberIds])];
  const updated = await ctx.store.update('events', { _id }, { participantIds });
  return ok({ eventId: _id, addedCount: participantIds.length - doc.participantIds.length, participantIds: updated.participantIds });
}));

events.get('/:eventId/share', read(async ctx => {
  const { doc, group } = await eventAccess(ctx, ctx.param('eventId'), { organizer: true });
  check(group?.visibility === 'public' && doc.visibility === 'public' && doc.status === 'published',
    409, 'SHARING_UNAVAILABLE', 'Le partage nécessite un événement public publié dans un groupe public.');
  return ok({
    url: ctx.config.publicBaseUrl + '/api/v1/events/' + doc._id,
    title: doc.name,
    description: doc.description,
    coverImageUrl: doc.coverImageUrl
  });
}));

events.delete('/:eventId', write(async ctx => {
  const _id = ctx.param('eventId');
  await eventAccess(ctx, _id, { organizer: true, lock: true });
  await removeEventData(ctx.store, [_id]);
  return deleted();
}));

module.exports = { events };
