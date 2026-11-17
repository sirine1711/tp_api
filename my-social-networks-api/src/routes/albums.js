const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { eventAccess, maintain } = require('../access');
const { record } = require('../db');
const { shortText, longText, imageUrl, pagination, patchOf, parse } = require('../http');
const { mountComments } = require('./comments');

const albums = Router({ mergeParams: true });
const albumFields = z.object({ title: shortText, description: longText.optional() }).strict();
const photoFields = z.object({ imageUrl, caption: longText.optional() }).strict();

function albumAccess(ctx, lock = false) {
  return eventAccess(ctx, ctx.param('eventId'), { participant: true, lock });
}

async function loadAlbum(ctx, lock = false) {
  const { doc: event, isOrganizer } = await albumAccess(ctx, lock);
  const doc = await ctx.store.require('albums', { _id: ctx.param('albumId'), eventId: event._id }, 'Album');
  return { doc, eventId: event._id, moderate: isOrganizer };
}

async function loadPhoto(ctx, lock = false) {
  const { doc: album, eventId, moderate } = await loadAlbum(ctx, lock);
  const doc = await ctx.store.require('photos', { _id: ctx.param('photoId'), albumId: album._id }, 'Photo');
  return { doc, moderate, scope: { eventId, albumId: album._id, photoId: doc._id } };
}

albums.get('/', read(async ctx => {
  const { doc } = await albumAccess(ctx);
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('albums', { eventId: doc._id }, input, ['title', 'description']));
}));

albums.post('/', write(async ctx => {
  const { doc } = await albumAccess(ctx, true);
  const input = parse(albumFields, ctx.req.body);
  return created(record(await ctx.store.insert('albums', { eventId: doc._id, authorId: ctx.actorId, ...input })));
}));

albums.get('/:albumId', read(async ctx => {
  const { doc } = await loadAlbum(ctx);
  return ok(record(doc));
}));

albums.patch('/:albumId', write(async ctx => {
  const { doc, moderate } = await loadAlbum(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  const input = parse(patchOf(albumFields), ctx.req.body);
  return ok(record(await ctx.store.update('albums', { _id: doc._id }, input)));
}));

albums.delete('/:albumId', write(async ctx => {
  const { doc, moderate } = await loadAlbum(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  await ctx.store.removeMany('photoComments', { albumId: doc._id });
  await ctx.store.removeMany('photos', { albumId: doc._id });
  await ctx.store.remove('albums', { _id: doc._id });
  return deleted();
}));

albums.get('/:albumId/photos', read(async ctx => {
  const { doc } = await loadAlbum(ctx);
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('photos', { albumId: doc._id }, input, ['caption', 'imageUrl']));
}));

albums.post('/:albumId/photos', write(async ctx => {
  const { doc, eventId } = await loadAlbum(ctx, true);
  const input = parse(photoFields, ctx.req.body);
  return created(record(await ctx.store.insert('photos', {
    ...input,
    eventId,
    albumId: doc._id,
    authorId: ctx.actorId
  })));
}));

albums.get('/:albumId/photos/:photoId', read(async ctx => {
  const { doc } = await loadPhoto(ctx);
  return ok(record(doc));
}));

albums.patch('/:albumId/photos/:photoId', write(async ctx => {
  const { doc, moderate } = await loadPhoto(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  const input = parse(patchOf(photoFields), ctx.req.body);
  return ok(record(await ctx.store.update('photos', { _id: doc._id }, input)));
}));

albums.delete('/:albumId/photos/:photoId', write(async ctx => {
  const { doc, moderate } = await loadPhoto(ctx, true);
  maintain(moderate || doc.authorId === ctx.actorId);
  await ctx.store.removeMany('photoComments', { photoId: doc._id });
  await ctx.store.remove('photos', { _id: doc._id });
  return deleted();
}));

mountComments(albums, {
  path: '/:albumId/photos/:photoId/comments',
  collection: 'photoComments',
  load: loadPhoto
});

module.exports = { albums };
