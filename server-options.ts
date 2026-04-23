import type { FastifyServerOptions } from 'fastify';

const serverOptions: FastifyServerOptions = {
  caseSensitive: false,
  logger: {
    level: 'debug',
    ...(process.env.NODE_ENV !== 'production' && {
      transport: { target: 'pino-pretty' }
    })
  },
  pluginTimeout: 100000
};

export { serverOptions };
