export class GatewayRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, options?: ErrorOptions) {
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new RangeError(`Invalid HTTP status code: ${statusCode}`);
    }

    super(message, options);
    this.name = 'GatewayRequestError';
    this.statusCode = statusCode;
    Object.defineProperty(this, 'statusCode', {
      value: statusCode,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
}
