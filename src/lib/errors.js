// Errors that are safe to show to the user. `errors` maps form fields to messages (rendered inline by
// public/js/forms.js and by server-rendered forms). Anything else reaching the error handler is a 500.
export class HttpError extends Error {
  constructor(status, message, { errors, code } = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    if (errors) this.errors = errors;
    if (code) this.code = code;
  }
}

export const badRequest = (message, errors) => new HttpError(400, message, { errors });
export const invalid = errors => new HttpError(422, 'Please fix the highlighted fields.', { errors });
export const unauthorized = (message = 'Please sign in.') => new HttpError(401, message);
export const forbidden = (message = "You don't have access to that.") => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);
export const conflict = message => new HttpError(409, message);
export const tooMany = message => new HttpError(429, message);
