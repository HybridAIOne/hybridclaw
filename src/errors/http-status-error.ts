import { AppError } from './app-error.js';

export class HttpStatusError extends AppError {
  statusCode: number;

  constructor(statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

export class GatewayRequestError extends HttpStatusError {}
