const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { groupAccess, eventAccess, maintain } = require('../access');
const { record } = require('../db');
const { check, id, shortText, longText, pagination, parse } = require('../http');
const { mountComments } = require('./comments');

const threads = Router();
const parents = { groupId: id.optional(), eventId: id.optional() };
const threadFields = z.object({ title: shortText }).strict();
const messageFields = z.object({ content: longText }).strict();

async function scopeAccess(ctx, parents, lock) {
  const { groupId, eventId } = parents;
  check(Boolean(groupId) !== Boolean(eventId), 422, 'ONE_PARENT_REQUIRED', 'Indiquez exactement un groupe ou un événement.');
  if (groupId) {
    const { doc, isAdmin } = await groupAccess(ctx, groupId, { member: true, lock });
    return { scope: { groupId }, moderate: isAdmin, canPost: isAdmin || doc.allowMemberPosts };
  }
  const { isOrganizer } = await eventAccess(ctx, eventId, { participant: true, lock });
  return { scope: { eventId }, moderate: isOrganizer, canPost: true };
}

async function loadThread(ctx, lock = false) {
  const doc = await ctx.store.require('threads', { _id: ctx.param('threadId') }, 'Fil de discussion');
  const access = await scopeAccess(ctx, doc, lock);
  return { doc, ...access };
}

async function loadMessage(ctx, lock = false) {
  const { doc, scope, moderate } = await loadThread(ctx, lock);
  const msg = await ctx.store.require('messages', {
    threadId: doc._id, _id: ctx.param('messageId')
  }, 'Message');
  return { doc: msg, moderate, scope: { ...scope, threadId: doc._id, messageId: msg._id } };
}

threads.get('/', read(async ctx => {
  const input = parse(pagination.extend(parents), ctx.req.query);
  const { scope } = await scopeAccess(ctx, input, false);
  return ok(await ctx.store.list('threads', scope, input, ['title']));
}));

threads.post('/', write(async ctx => {
  const input = parse(threadFields.extend(parents), ctx.req.body);
  const { scope, canPost } = await scopeAccess(ctx, input, true);
  check(canPost, 403, 'MEMBER_POSTS_DISABLED', 'Les publications des membres sont désactivées.');
  return created(record(await ctx.store.insert('threads', { ...scope, title: input.title, authorId: ctx.actorId })));
}));

threads.get('/:threadId', read(async ctx => {
  const { doc } = await loadThread(ctx);
  return ok(record(doc));
}));

threads.patch('/:threadId', write(async ctx => {
  const { doc, moderate } = await loadThread(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  const input = parse(threadFields, ctx.req.body);
  return ok(record(await ctx.store.update('threads', { _id: doc._id }, input)));
}));

threads.delete('/:threadId', write(async ctx => {
  const { doc, moderate } = await loadThread(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  await ctx.store.removeMany('messageComments', { threadId: doc._id });
  await ctx.store.removeMany('messages', { threadId: doc._id });
  await ctx.store.remove('threads', { _id: doc._id });
  return deleted();
}));

threads.get('/:threadId/messages', read(async ctx => {
  const { doc } = await loadThread(ctx);
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('messages', { threadId: doc._id }, input, ['content']));
}));

threads.post('/:threadId/messages', write(async ctx => {
  const { doc, scope, canPost } = await loadThread(ctx, true);
  check(canPost, 403, 'MEMBER_POSTS_DISABLED', 'Les publications des membres sont désactivées.');
  const input = parse(messageFields, ctx.req.body);
  const msg = await ctx.store.insert('messages', { ...scope, ...input, threadId: doc._id, authorId: ctx.actorId });
  return created(record(msg));
}));

threads.get('/:threadId/messages/:messageId', read(async ctx => {
  const { doc } = await loadMessage(ctx);
  return ok(record(doc));
}));

threads.patch('/:threadId/messages/:messageId', write(async ctx => {
  const { doc, moderate } = await loadMessage(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  const input = parse(messageFields, ctx.req.body);
  return ok(record(await ctx.store.update('messages', { _id: doc._id }, input)));
}));

threads.delete('/:threadId/messages/:messageId', write(async ctx => {
  const { doc, moderate } = await loadMessage(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  await ctx.store.removeMany('messageComments', { messageId: doc._id });
  await ctx.store.remove('messages', { _id: doc._id });
  return deleted();
}));

mountComments(threads, {
  path: '/:threadId/messages/:messageId/comments',
  collection: 'messageComments',
  load: loadMessage
});

module.exports = { threads };
