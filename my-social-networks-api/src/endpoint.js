const { Store } = require('./db');
const { authenticate } = require('./auth');
const { check, id, parse } = require('./http');

function endpoint(handler, mode, transactional) {
  return async (req, res, next) => {
    const { client, db, config } = req.app.locals;
    try {
      const actorId = authenticate(req, mode, config.jwtSecret);
      const run = async session => {
        const store = new Store(db, session);
        if (actorId) {
          const actor = await store.one('users', { _id: actorId });
          check(actor, 401, 'UNAUTHORIZED', 'Le compte associé au jeton est introuvable.');
          if (transactional) await store.lock('users', actorId);
        }
        return handler({ req, store, actorId, config, param: key => parse(id, req.params[key]) });
      };

      const result = transactional
        ? await client.withSession(session => session.withTransaction(() => run(session)))
        : await run();

      if (result.status === 204) return res.status(204).end();
      res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  };
}

const read = (handler, mode = 'required') => endpoint(handler, mode, false);
const write = (handler, mode = 'required') => endpoint(handler, mode, true);
const ok = data => ({ status: 200, data });
const created = data => ({ status: 201, data });
const deleted = () => ({ status: 204 });

module.exports = { read, write, ok, created, deleted };
