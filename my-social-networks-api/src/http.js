const { z } = require('zod');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function check(condition, status, code, message) {
  if (!condition) throw new ApiError(status, code, message);
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(422, 'INVALID_INPUT', 'Les données fournies sont invalides.', result.error.issues.map(issue => ({
    field: issue.path.join('.'),
    message: issue.message
  })));
}

const id = z.string().uuid().transform(value => value.toLowerCase());
const idList = z.array(id).transform(values => [...new Set(values)]);
const email = z.string().trim().toLowerCase().email().max(254);
const shortText = z.string().trim().min(1).max(160);
const longText = z.string().trim().min(1).max(10000);
const dateTime = z.string().datetime({ offset: true }).transform(value => new Date(value))
  .refine(value => Number.isFinite(value.getTime()), 'Date ou fuseau horaire invalide.');
const positiveInt = z.number().int().min(1).max(1000000);
const amountCents = z.number().int().min(0).max(100000000);
const imageUrl = z.string().max(2048).url().refine(value => /^https?:\/\//i.test(value), 'URL HTTP(S) attendue.');

function patchOf(schema) {
  return schema.partial().refine(value => Object.keys(value).length > 0, 'Au moins un champ est requis.');
}

const pagination = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  page: z.string().regex(/^[1-9]\d{0,3}$/).transform(Number).default(1),
  limit: z.string().regex(/^([1-9]\d?|100)$/).transform(Number).default(20)
}).strict();

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    error = new ApiError(400, 'INVALID_JSON', 'Le corps de la requête doit être du JSON valide.');
  } else if (error.type === 'entity.too.large') {
    error = new ApiError(413, 'BODY_TOO_LARGE', 'Le corps de la requête est trop volumineux.');
  } else if (error.code === 11000) {
    const keys = error.keyPattern || {};
    if (keys.email) {
      error = new ApiError(409, 'EMAIL_EXISTS', 'Cette adresse email est déjà utilisée.');
    } else if (keys['buyer.email']) {
      error = new ApiError(409, 'ALREADY_BOOKED', 'Cette adresse email a déjà obtenu un billet pour cet événement.');
    } else if (keys.nameKey) {
      error = new ApiError(409, 'ITEM_EXISTS', 'Cet article existe déjà dans la liste de cet événement.');
    } else {
      error = new ApiError(409, 'DUPLICATE', 'Cette donnée existe déjà.');
    }
  } else if (!(error instanceof ApiError)) {
    console.error(error.name, error.code || '');
    error = new ApiError(500, 'INTERNAL_ERROR', 'Une erreur interne est survenue.');
  }

  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    }
  });
}

module.exports = {
  ApiError, check, parse, patchOf, pagination, errorHandler,
  id, idList, email, shortText, longText, dateTime, positiveInt, amountCents, imageUrl
};
