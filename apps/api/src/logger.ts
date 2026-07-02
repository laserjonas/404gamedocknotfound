import { pino, type Logger } from 'pino';

export function createLogger(isProduction: boolean): Logger {
  return pino({
    level: process.env.GAMEDOCK_LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    // Never log values of these fields (defense in depth against secret leaks).
    redact: {
      paths: [
        'password',
        '*.password',
        'req.headers.authorization',
        'req.headers.cookie',
        'passwordHash',
        '*.passwordHash',
        'token',
        '*.token',
        'secret',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    transport: isProduction ? undefined : { target: 'pino-pretty', options: { colorize: true } },
  });
}

export type { Logger };
