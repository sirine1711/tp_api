const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { eventAccess, isTicketShopOpen } = require('../access');
const { record } = require('../db');
const { check, email, id, shortText, amountCents, positiveInt, pagination, patchOf, parse } = require('../http');

const ticketTypes = Router({ mergeParams: true });
const tickets = Router({ mergeParams: true });

const typeFields = z.object({ name: shortText, amountCents, quantity: positiveInt }).strict();
const address = z.object({
  street: shortText,
  addressLine2: shortText.optional(),
  postalCode: z.string().trim().min(1).max(20),
  city: shortText,
  region: shortText.optional(),
  country: shortText
}).strict();
const buyerFields = z.object({ firstName: shortText, lastName: shortText, address }).strict();
const saleFields = z.object({ ticketTypeId: id, buyer: buyerFields.extend({ email }) }).strict();

function typeView(doc) {
  return { ...record(doc), available: doc.quantity - doc.sold };
}

async function ticketTypeAccess(ctx, organizer = false, lock = false) {
  const access = await eventAccess(ctx, ctx.param('eventId'), { organizer, lock });
  check(access.isOrganizer || isTicketShopOpen(access.doc), 404, 'TICKETING_UNAVAILABLE', 'Billetterie indisponible.');
  return access.doc;
}

function findTicketType(ctx, eventId) {
  return ctx.store.require('ticketTypes', { _id: ctx.param('ticketTypeId'), eventId }, 'Type de billet');
}

ticketTypes.get('/', read(async ctx => {
  const doc = await ticketTypeAccess(ctx);
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('ticketTypes', { eventId: doc._id }, input, ['name'], typeView));
}, 'optional'));

ticketTypes.get('/:ticketTypeId', read(async ctx => {
  const doc = await ticketTypeAccess(ctx);
  return ok(typeView(await findTicketType(ctx, doc._id)));
}, 'optional'));

ticketTypes.post('/', write(async ctx => {
  const doc = await ticketTypeAccess(ctx, true, true);
  check(doc.options.ticketingEnabled, 409, 'OPTION_DISABLED', 'Activez la billetterie pour ajouter des types de billets.');
  const input = parse(typeFields, ctx.req.body);
  const ticketType = await ctx.store.insert('ticketTypes', { ...input, eventId: doc._id, sold: 0, currency: 'EUR' });
  return created(typeView(ticketType));
}));

ticketTypes.patch('/:ticketTypeId', write(async ctx => {
  const doc = await ticketTypeAccess(ctx, true, true);
  const type = await findTicketType(ctx, doc._id);
  const input = parse(patchOf(typeFields), ctx.req.body);
  check(input.quantity === undefined || input.quantity >= type.sold, 409, 'QUANTITY_BELOW_SALES',
    'La quantité doit couvrir les billets déjà achetés.');
  return ok(typeView(await ctx.store.update('ticketTypes', { _id: type._id }, input)));
}));

ticketTypes.delete('/:ticketTypeId', write(async ctx => {
  const doc = await ticketTypeAccess(ctx, true, true);
  const type = await findTicketType(ctx, doc._id);
  check(type.sold === 0, 409, 'TICKETS_ALREADY_SOLD', 'Annulez les billets existants avant de supprimer le type.');
  await ctx.store.remove('ticketTypes', { _id: type._id });
  return deleted();
}));

tickets.post('/', write(async ctx => {
  const { doc } = await eventAccess(ctx, ctx.param('eventId'), { lock: true });
  check(isTicketShopOpen(doc), 409, 'TICKETING_UNAVAILABLE', 'La billetterie est fermée.');
  const input = parse(saleFields, ctx.req.body);
  const type = await ctx.store.require('ticketTypes', { _id: input.ticketTypeId, eventId: doc._id }, 'Type de billet');
  const duplicate = await ctx.store.one('tickets', { eventId: doc._id, 'buyer.email': input.buyer.email });
  check(!duplicate, 409, 'ALREADY_BOOKED', 'Cette adresse email a déjà obtenu un billet pour cet événement.');

  const stock = await ctx.store.collection('ticketTypes').updateOne({
    _id: type._id, $expr: { $lt: ['$sold', '$quantity'] }
  }, { $inc: { sold: 1 }, $currentDate: { updatedAt: true } }, ctx.store.options);
  check(stock.matchedCount === 1, 409, 'SOLD_OUT', 'Il ne reste plus de billet de ce type.');

  const ticket = await ctx.store.insert('tickets', {
    ...input, eventId: doc._id, amountCents: type.amountCents, currency: type.currency, purchaseAt: new Date()
  });
  return created(record(ticket));
}, 'none'));

async function organizerSale(ctx, lock = false) {
  const { doc } = await eventAccess(ctx, ctx.param('eventId'), { organizer: true, lock });
  return ctx.store.require('tickets', { _id: ctx.param('ticketId'), eventId: doc._id }, 'Billet');
}

tickets.get('/', read(async ctx => {
  const { doc } = await eventAccess(ctx, ctx.param('eventId'), { organizer: true });
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('tickets', { eventId: doc._id }, input,
    ['buyer.firstName', 'buyer.lastName', 'buyer.email'], record, { purchaseAt: -1, _id: -1 }));
}));

tickets.get('/:ticketId', read(async ctx => ok(record(await organizerSale(ctx)))));

tickets.patch('/:ticketId', write(async ctx => {
  const ticket = await organizerSale(ctx, true);
  const buyer = parse(patchOf(buyerFields), ctx.req.body);
  return ok(record(await ctx.store.update('tickets', { _id: ticket._id }, { buyer: { ...ticket.buyer, ...buyer } })));
}));

tickets.delete('/:ticketId', write(async ctx => {
  const ticket = await organizerSale(ctx, true);
  await ctx.store.collection('ticketTypes').updateOne({ _id: ticket.ticketTypeId }, {
    $inc: { sold: -1 },
    $currentDate: { updatedAt: true }
  }, ctx.store.options);
  await ctx.store.remove('tickets', { _id: ticket._id });
  return deleted();
}));

module.exports = { ticketTypes, tickets };
