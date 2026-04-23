import type { FastifyMongodbOptions } from '@fastify/mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { execSync } from 'child_process';
import { downloadMongoArchive } from './setup-mongo-common';

const setupMongoMemoryServer = async (): Promise<FastifyMongodbOptions> => {
  const archivePath: string = await downloadMongoArchive();

  const mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  execSync(`mongorestore --uri="${uri}" --archive=${archivePath} --drop`, {
    stdio: 'pipe'
  });

  const connectionString = `${uri}sample_mflix?directConnection=true`;
  return { url: connectionString };
};

export default setupMongoMemoryServer;
