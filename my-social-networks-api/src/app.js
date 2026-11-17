const express = require('express');
const helmet = require('helmet');
const { errorHandler, ApiError } = require('./http');
const { read, ok } = require('./endpoint');
const { users, auth } = require('./routes/users');
const { groups } = require('./routes/groups');
const { events } = require('./routes/events');
const { threads } = require('./routes/threads');
const { albums } = require('./routes/albums');
const { polls } = require('./routes/polls');
const { ticketTypes, tickets } = require('./routes/tickets');
const { shopping, rides } = require('./routes/activityLists');

function createApp(client, db, config) {
  const app = express();
  Object.assign(app.locals, { client, db, config });
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(helmet());
  app.use(express.json({ limit: '200kb' }));

  const api = express.Router();
  api.get('/health', read(async ({ store }) => {
    await store.db.command({ ping: 1 });
    return ok({ status: 'ok' });
  }, 'none'));
  api.use('/auth', auth);
  api.use('/users', users);
  api.use('/groups', groups);
  api.use('/events', events);
  api.use('/threads', threads);
  api.use('/events/:eventId/albums', albums);
  api.use('/events/:eventId/polls', polls);
  api.use('/events/:eventId/ticket-types', ticketTypes);
  api.use('/events/:eventId/tickets', tickets);
  api.use('/events/:eventId/shopping-list', shopping);
  api.use('/events/:eventId/rides', rides);

  app.use('/api/v1', api);
  app.use((req, res, next) => next(new ApiError(404, 'ROUTE_NOT_FOUND', 'Cette route n’existe pas.')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
