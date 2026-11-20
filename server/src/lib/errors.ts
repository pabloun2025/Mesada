export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}

export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, m, code);
export const unauthorized = (m = 'Sesión no válida') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'No tienes permiso para esta acción') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'No encontrado') => new HttpError(404, m, 'not_found');
export const conflict = (m: string, code = 'conflict') => new HttpError(409, m, code);
