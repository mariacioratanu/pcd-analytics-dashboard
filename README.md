# Fast Lazy Bee

[![CI](https://github.com/cowuake/fast-lazy-bee/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/cowuake/fast-lazy-bee/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/cowuake/fast-lazy-bee/badge.svg?branch=main)](https://coveralls.io/github/cowuake/fast-lazy-bee?branch=main)

Fast Lazy Bee is a toy *RESTful API* developed in TypeScript with the [Fastify](https://fastify.dev/) framework for educational purposes.

## How to run locally

### Requirements

| Tool                          | Version        |
| ----------------------------- | -------------- |
| Node.js[^Node]                | 21.7.3         |
| MongoDB[^Mongo]               | 8.x            |
| mongodb-database-tools[^Tools]| (a recent one) |

[^Node]: Use [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) for installing the required version.

[^Mongo]: Install MongoDB Community Edition for your platform. See [MongoDB installation docs](https://www.mongodb.com/docs/manual/installation/).

[^Tools]: Required for `mongorestore`. See [mongodb-database-tools](https://www.mongodb.com/docs/database-tools/installation/installation/).

### Quick start

Make sure MongoDB is running locally on the default port (27017), then:

#### GNU/Linux and macOS

Give the run script execution permission with `chmod +x ./run.sh`, then launch it with

```bash
./run.sh
```

The script will download and restore the MongoDB sample dataset, build the app, and start it.
Once running, access the API via SwaggerUI at [http://localhost:3000/docs](http://localhost:3000/docs).

#### Windows

Launch the run script with:

```powershell
.\run.ps1
```

### Development mode

Install dependencies with `npm ci`, then run:

```shell
npm run dev
```

This starts the app with `tsx watch` for hot reloading. In development mode, the app connects to your local MongoDB instance using the connection string from `.env`.

### Running tests

Tests use [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) to spin up an ephemeral MongoDB instance automatically — no external database required.

```shell
npm test
```
