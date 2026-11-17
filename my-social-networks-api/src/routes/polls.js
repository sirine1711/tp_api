const { randomUUID } = require('node:crypto');
const { Router } = require('express');
const { z } = require('zod');
const { read, write, ok, created, deleted } = require('../endpoint');
const { eventAccess } = require('../access');
const { record } = require('../db');
const { check, id, shortText, longText, pagination, patchOf, parse } = require('../http');

const polls = Router({ mergeParams: true });
const questionFields = z.object({
  text: shortText,
  options: z.array(shortText).min(2).max(20)
    .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length,
      'Les options d’une même question doivent être différentes.')
}).strict();
const pollFields = z.object({
  title: shortText,
  description: longText.optional(),
  questions: z.array(questionFields).min(1).max(50)
}).strict();
const ballotFields = z.object({
  answers: z.array(z.object({ questionId: id, optionId: id }).strict()).min(1).max(50)
}).strict();

function defineQuestions(questions) {
  return questions.map(question => ({
    id: randomUUID(),
    text: question.text,
    options: question.options.map(text => ({ id: randomUUID(), text }))
  }));
}

function pollEvent(ctx, organizer = false) {
  return eventAccess(ctx, ctx.param('eventId'), { participant: true, organizer, lock: organizer });
}

async function loadPoll(ctx, { organizer = false, lock = false } = {}) {
  const { doc: event } = await eventAccess(ctx, ctx.param('eventId'), { participant: true, organizer, lock });
  return ctx.store.require('polls', { _id: ctx.param('pollId'), eventId: event._id }, 'Sondage');
}

polls.get('/', read(async ctx => {
  const { doc } = await pollEvent(ctx);
  const input = parse(pagination, ctx.req.query);
  return ok(await ctx.store.list('polls', { eventId: doc._id }, input, ['title', 'description', 'questions.text']));
}));

polls.post('/', write(async ctx => {
  const { doc } = await pollEvent(ctx, true);
  const { questions, ...input } = parse(pollFields, ctx.req.body);
  const createdPoll = await ctx.store.insert('polls', {
    ...input, eventId: doc._id, authorId: ctx.actorId, questions: defineQuestions(questions)
  });
  return created(record(createdPoll));
}));

polls.get('/:pollId', read(async ctx => ok(record(await loadPoll(ctx)))));

polls.patch('/:pollId', write(async ctx => {
  const doc = await loadPoll(ctx, { organizer: true, lock: true });
  const { questions, ...input } = parse(patchOf(pollFields), ctx.req.body);
  if (questions) {
    const ballot = await ctx.store.one('ballots', { pollId: doc._id });
    check(!ballot, 409, 'POLL_HAS_RESPONSES', 'Les questions sont modifiables tant que le sondage n’a pas de réponse.');
    input.questions = defineQuestions(questions);
  }
  return ok(record(await ctx.store.update('polls', { _id: doc._id }, input)));
}));

polls.delete('/:pollId', write(async ctx => {
  const doc = await loadPoll(ctx, { organizer: true, lock: true });
  await ctx.store.removeMany('ballots', { pollId: doc._id });
  await ctx.store.remove('polls', { _id: doc._id });
  return deleted();
}));

polls.get('/:pollId/responses/me', read(async ctx => {
  const doc = await loadPoll(ctx);
  return ok(record(await ctx.store.require('ballots', { pollId: doc._id, userId: ctx.actorId }, 'Vote')));
}));

polls.put('/:pollId/responses/me', write(async ctx => {
  const doc = await loadPoll(ctx, { lock: true });
  const { answers } = parse(ballotFields, ctx.req.body);
  const byQuestion = new Map(answers.map(answer => [answer.questionId, answer.optionId]));
  const valid = answers.length === doc.questions.length && byQuestion.size === answers.length
    && doc.questions.every(question => question.options.some(option => option.id === byQuestion.get(question.id)));
  check(valid, 422, 'INVALID_BALLOT', 'Choisissez exactement une option valide pour chaque question.');

  const filter = { pollId: doc._id, userId: ctx.actorId };
  const existing = await ctx.store.one('ballots', filter);
  const ballot = existing
    ? await ctx.store.update('ballots', filter, { answers })
    : await ctx.store.insert('ballots', { ...filter, eventId: doc.eventId, answers });
  return ok(record(ballot));
}));

polls.delete('/:pollId/responses/me', write(async ctx => {
  const doc = await loadPoll(ctx, { lock: true });
  await ctx.store.remove('ballots', { pollId: doc._id, userId: ctx.actorId });
  return deleted();
}));

polls.get('/:pollId/results', read(async ctx => {
  const doc = await loadPoll(ctx);
  const counts = await ctx.store.collection('ballots').aggregate([
    { $match: { pollId: doc._id } },
    { $unwind: '$answers' },
    { $group: { _id: '$answers.optionId', votes: { $sum: 1 } } }
  ], ctx.store.options).toArray();

  const byOption = new Map(counts.map(item => [item._id, item.votes]));
  const questions = doc.questions.map(question => ({
    ...question,
    options: question.options.map(option => ({ ...option, votes: byOption.get(option.id) ?? 0 }))
  }));
  const totalResponses = questions[0].options.reduce((total, option) => total + option.votes, 0);
  return ok({ pollId: doc._id, totalResponses, questions });
}));

module.exports = { polls };
