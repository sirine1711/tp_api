const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { eventAccess, maintain } = require('../access');
const { record } = require('../db');
const { check, shortText, dateTime, positiveInt, amountCents, pagination, patchOf, parse } = require('../http');

function activityList({ name, label, option, idParam, fields, searchFields, prepare = input => input }) {
  const router = Router({ mergeParams: true });

  async function access(ctx, lock = false) {
    const permissions = await eventAccess(ctx, ctx.param('eventId'), { participant: true, lock });
    check(permissions.doc.options[option], 409, 'OPTION_DISABLED', 'Cette option est désactivée pour l’événement.');
    return permissions;
  }

  async function load(ctx, lock = false) {
    const { doc: event, isOrganizer } = await access(ctx, lock);
    const doc = await ctx.store.require(name, { _id: ctx.param(idParam), eventId: event._id }, label);
    return { doc, isOrganizer };
  }

  router.get('/', read(async ctx => {
    const { doc } = await access(ctx);
    const input = parse(pagination, ctx.req.query);
    return ok(await ctx.store.list(name, { eventId: doc._id }, input, searchFields));
  }));

  router.post('/', write(async ctx => {
    const { doc } = await access(ctx, true);
    const input = prepare(parse(fields, ctx.req.body));
    return created(record(await ctx.store.insert(name, { ...input, eventId: doc._id, authorId: ctx.actorId })));
  }));

  const path = '/:' + idParam;

  router.get(path, read(async ctx => {
    const { doc } = await load(ctx);
    return ok(record(doc));
  }));

  router.patch(path, write(async ctx => {
    const { doc, isOrganizer } = await load(ctx, true);
    maintain(isOrganizer || doc.authorId === ctx.actorId);
    const input = prepare(parse(patchOf(fields), ctx.req.body));
    return ok(record(await ctx.store.update(name, { _id: doc._id }, input)));
  }));

  router.delete(path, write(async ctx => {
    const { doc, isOrganizer } = await load(ctx, true);
    maintain(isOrganizer || doc.authorId === ctx.actorId);
    await ctx.store.remove(name, { _id: doc._id });
    return deleted();
  }));

  return router;
}

const shopping = activityList({
  name: 'shoppingItems',
  label: 'Article',
  option: 'shoppingListEnabled',
  idParam: 'itemId',
  fields: z.object({ name: shortText, quantity: positiveInt, arrivalAt: dateTime }).strict(),
  searchFields: ['name'],
  prepare: input => input.name
    ? { ...input, nameKey: input.name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ') }
    : input
});

const rides = activityList({
  name: 'rides',
  label: 'Trajet',
  option: 'carpoolingEnabled',
  idParam: 'rideId',
  fields: z.object({
    departureLocation: shortText,
    departureAt: dateTime,
    priceCents: amountCents,
    availableSeats: positiveInt,
    maxDetourMinutes: z.number().int().min(0).max(1440)
  }).strict(),
  searchFields: ['departureLocation']
});

module.exports = { shopping, rides };
