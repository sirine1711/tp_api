async function removeEventData(store, eventIds) {
  if (!eventIds.length) return;
  const scoped = { eventId: { $in: eventIds } };

  for (const name of [
    'messageComments', 'messages', 'threads', 'photoComments', 'photos', 'albums',
    'ballots', 'polls', 'tickets', 'ticketTypes', 'shoppingItems', 'rides'
  ]) {
    await store.removeMany(name, scoped);
  }
  await store.removeMany('events', { _id: { $in: eventIds } });
}

module.exports = { removeEventData };
