const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { groupAccess, includes } = require('../access');
const { record } = require('../db');
const { removeEventData } = require('../cleanup');
const { check, shortText, longText, imageUrl, idList, pagination, patchOf, parse } = require('../http');

const groups = Router();
const groupFields = z.object({
  name: shortText,
  description: longText,
  iconUrl: imageUrl,
  coverImageUrl: imageUrl,
  visibility: z.enum(['public', 'private', 'secret']),
  allowMemberPosts: z.boolean().optional(),
  allowMemberEvents: z.boolean().optional(),
  adminIds: idList.optional(),
  memberIds: idList.optional()
}).strict();

function groupView(doc, actorId) {
  const { adminIds, memberIds, ...fields } = record(doc);
  return {
    ...fields,
    memberCount: memberIds.length,
    ...(includes(memberIds, actorId) ? { adminIds, memberIds } : {})
  };
}

groups.post('/', write(async ({ req, store, actorId }) => {
  const { memberIds = [], adminIds = [], ...fields } = parse(groupFields, req.body);
  const admins = [...new Set([actorId, ...adminIds])];
  const members = [...new Set([...admins, ...memberIds])];
  await store.ensureUsers(members);
  const doc = await store.insert('groups', {
    allowMemberPosts: true,
    allowMemberEvents: false,
    ...fields,
    adminIds: admins,
    memberIds: members
  });

  await store.insert('threads', {
    groupId: doc._id,
    title: 'Discussion du groupe',
    authorId: actorId
  });
  return created(groupView(doc, actorId));
}));

groups.get('/', read(async ({ req, store, actorId }) => {
  const input = parse(pagination, req.query);
  const filters = [{ visibility: { $in: ['public', 'private'] } }];
  if (actorId) filters.push({ memberIds: actorId });
  return ok(await store.list('groups', { $or: filters }, input, ['name', 'description'], doc => groupView(doc, actorId)));
}, 'optional'));

groups.get('/:groupId', read(async ctx => {
  const { doc } = await groupAccess(ctx, ctx.param('groupId'));
  return ok(groupView(doc, ctx.actorId));
}, 'optional'));

groups.patch('/:groupId', write(async ctx => {
  const { req, store, actorId } = ctx;
  const _id = ctx.param('groupId');
  const { doc } = await groupAccess(ctx, _id, { admin: true, lock: true });
  const input = parse(patchOf(groupFields), req.body);
  const adminIds = input.adminIds ?? doc.adminIds;
  check(adminIds.length > 0, 422, 'ADMIN_REQUIRED', 'Le groupe doit avoir au moins un administrateur.');
  const memberIds = [...new Set([...adminIds, ...(input.memberIds ?? doc.memberIds)])];
  const visibility = input.visibility ?? doc.visibility;
  if (input.memberIds || input.adminIds) await store.ensureUsers(memberIds);

  if (visibility !== 'public' && (doc.visibility !== visibility || input.memberIds || input.adminIds)) {
    const publicEvent = await store.one('events', { groupId: _id, visibility: 'public' });
    check(!publicEvent, 409, 'GROUP_HAS_PUBLIC_EVENTS', 'Rendez privés les événements du groupe avant de restreindre sa visibilité.');

    const organizerRemoved = await store.one('events', {
      groupId: _id, $expr: { $not: [{ $setIsSubset: ['$organizerIds', memberIds] }] }
    });
    check(!organizerRemoved, 409, 'GROUP_EVENT_ORGANIZER', 'Un organisateur d’un événement du groupe doit rester membre.');

    await store.collection('events').updateMany({
      groupId: _id, $expr: { $not: [{ $setIsSubset: ['$participantIds', memberIds] }] }
    }, [{ $set: { participantIds: { $setIntersection: ['$participantIds', memberIds] }, updatedAt: '$$NOW' } }], store.options);
  }
  return ok(groupView(await store.update('groups', { _id }, { ...input, adminIds, memberIds }), actorId));
}));

groups.delete('/:groupId', write(async ctx => {
  const _id = ctx.param('groupId');
  const { store } = ctx;
  await groupAccess(ctx, _id, { admin: true, lock: true });
  const childEvents = await store.find('events', { groupId: _id }, { projection: { _id: 1 } }).toArray();
  await removeEventData(store, childEvents.map(doc => doc._id));
  for (const name of ['messageComments', 'messages', 'threads']) {
    await store.removeMany(name, { groupId: _id });
  }
  await store.remove('groups', { _id });
  return deleted();
}));

module.exports = { groups };
