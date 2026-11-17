const { randomUUID } = require('node:crypto');
const { check } = require('./http');

const indexes = {
  users: [{ key: { email: 1 }, unique: true }, { key: { createdAt: -1 } }],
  events: [
    { key: { groupId: 1, createdAt: -1 } }, { key: { organizerIds: 1 } },
    { key: { participantIds: 1 } }, { key: { status: 1, visibility: 1, createdAt: -1 } }
  ],
  groups: [{ key: { adminIds: 1 } }, { key: { memberIds: 1 } }, { key: { visibility: 1, createdAt: -1 } }],
  threads: [{ key: { groupId: 1, createdAt: -1 } }, { key: { eventId: 1, createdAt: -1 } }],
  messages: [{ key: { threadId: 1, createdAt: -1 } }, { key: { groupId: 1 } }, { key: { eventId: 1 } }],
  messageComments: [
    { key: { messageId: 1, createdAt: -1 } }, { key: { threadId: 1 } }, { key: { groupId: 1 } }, { key: { eventId: 1 } }
  ],
  albums: [{ key: { eventId: 1, createdAt: -1 } }],
  photos: [{ key: { albumId: 1, createdAt: -1 } }, { key: { eventId: 1 } }],
  photoComments: [{ key: { photoId: 1, createdAt: -1 } }, { key: { albumId: 1 } }, { key: { eventId: 1 } }],
  polls: [{ key: { eventId: 1, createdAt: -1 } }],
  ballots: [{ key: { pollId: 1, userId: 1 }, unique: true }, { key: { eventId: 1 } }],
  ticketTypes: [{ key: { eventId: 1, createdAt: -1 } }],
  tickets: [
    { key: { eventId: 1, 'buyer.email': 1 }, unique: true },
    { key: { eventId: 1, purchaseAt: -1 } }
  ],
  shoppingItems: [{ key: { eventId: 1, nameKey: 1 }, unique: true }, { key: { eventId: 1, createdAt: -1 } }],
  rides: [{ key: { eventId: 1, createdAt: -1 } }]
};

async function initDb(db) {
  await Promise.all(Object.entries(indexes).map(([name, definitions]) => db.collection(name).createIndexes(definitions)));
}

function record(document) {
  const { _id, revision, nameKey, ...fields } = document;
  return { id: _id, ...fields };
}

class Store {
  constructor(db, session) {
    this.db = db;
    this.options = session ? { session } : {};
  }

  collection(name) {
    return this.db.collection(name);
  }

  find(name, filter, options = {}) {
    return this.collection(name).find(filter, { ...this.options, ...options });
  }

  one(name, filter) {
    return this.collection(name).findOne(filter, this.options);
  }

  async require(name, filter, label) {
    const document = await this.one(name, filter);
    check(document, 404, 'NOT_FOUND', label + ' introuvable.');
    return document;
  }

  async list(name, filter, input, fields, present = record, sort = { createdAt: -1, _id: -1 }) {
    const { q, page, limit } = input;
    if (q) {
      const literal = q.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
      const search = fields.map(field => ({ [field]: { $regex: literal, $options: 'i' } }));
      filter = { $and: [filter, { $or: search }] };
    }
    const cursor = this.find(name, filter).sort(sort).skip((page - 1) * limit).limit(limit);
    const [documents, total] = await Promise.all([
      cursor.toArray(),
      this.collection(name).countDocuments(filter, this.options)
    ]);
    return { items: documents.map(present), total, page, limit };
  }

  async insert(name, fields) {
    const now = new Date();
    const doc = { _id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
    await this.collection(name).insertOne(doc, this.options);
    return doc;
  }

  update(name, filter, fields) {
    return this.collection(name).findOneAndUpdate(filter, {
      $set: { ...fields, updatedAt: new Date() }
    }, { ...this.options, returnDocument: 'after' });
  }

  lock(name, id) {
    return this.collection(name).updateOne({ _id: id }, { $inc: { revision: 1 } }, this.options);
  }

  remove(name, filter) {
    return this.collection(name).deleteOne(filter, this.options);
  }

  removeMany(name, filter) {
    return this.collection(name).deleteMany(filter, this.options);
  }

  async ensureUsers(ids) {
    const users = await this.collection('users').updateMany(
      { _id: { $in: ids } },
      { $inc: { revision: 1 } },
      this.options
    );
    check(users.matchedCount === ids.length, 422, 'UNKNOWN_USER', 'Un ou plusieurs utilisateurs sont introuvables.');
  }
}

module.exports = { initDb, Store, record };
