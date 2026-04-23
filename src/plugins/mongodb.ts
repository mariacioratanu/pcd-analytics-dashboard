import fastifyMongo, { type FastifyMongodbOptions } from '@fastify/mongodb';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import setupMongoMemoryServer from '../utils/testing/setup-mongo-memory-server';

const getMongoOptions = async (fastify: FastifyInstance): Promise<FastifyMongodbOptions> => {
  const commonOptions: FastifyMongodbOptions = {
    forceClose: true
  };

  if (fastify.config.NODE_ENV === 'test') {
    const mongoTestcontainersOptions = await setupMongoMemoryServer();
    return {
      ...commonOptions,
      ...mongoTestcontainersOptions
    };
  }

  return {
    ...commonOptions,
    url: fastify.config.MONGO_URL,
    database: fastify.config.MONGO_DB_NAME
  };
};

const mongoPlugin = fp(
  async (fastify: FastifyInstance) => {
    const mongoOptions = await getMongoOptions(fastify);
    await fastify.register(fastifyMongo, mongoOptions);
  },
  { name: 'mongo', dependencies: ['server-config'] }
);

export default mongoPlugin;
