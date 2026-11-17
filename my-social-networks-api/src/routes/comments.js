const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { maintain } = require('../access');
const { record } = require('../db');
const { longText, pagination, parse } = require('../http');

const fields = z.object({ content: longText }).strict();

function mountComments(router, { path, collection, load }) {
  router.get(path, read(async ctx => {
    const { scope } = await load(ctx);
    const input = parse(pagination, ctx.req.query);
    return ok(await ctx.store.list(collection, scope, input, ['content']));
  }));

  router.post(path, write(async ctx => {
    const { scope } = await load(ctx, true);
    const input = parse(fields, ctx.req.body);
    const doc = await ctx.store.insert(collection, { ...scope, ...input, authorId: ctx.actorId });
    return created(record(doc));
  }));

  async function getComment(ctx, lock = false) {
    const { scope, moderate } = await load(ctx, lock);
    const doc = await ctx.store.require(collection, { ...scope, _id: ctx.param('commentId') }, 'Commentaire');
    return { doc, moderate };
  }

  router.get(path + '/:commentId', read(async ctx => {
    const { doc } = await getComment(ctx);
    return ok(record(doc));
  }));

  router.patch(path + '/:commentId', write(async ctx => {
    const { doc, moderate } = await getComment(ctx, true);
    maintain(moderate || doc.authorId === ctx.actorId);
    const input = parse(fields, ctx.req.body);
    return ok(record(await ctx.store.update(collection, { _id: doc._id }, input)));
  }));

  router.delete(path + '/:commentId', write(async ctx => {
    const { doc, moderate } = await getComment(ctx, true);
    maintain(moderate || doc.authorId === ctx.actorId);
    await ctx.store.remove(collection, { _id: doc._id });
    return deleted();
  }));
}

module.exports = { mountComments };
