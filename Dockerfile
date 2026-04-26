FROM node:25-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci
RUN npm run build

FROM node:25-bookworm-slim
ENV HOME=/home/app
ENV APP_HOME=$HOME/node/
WORKDIR $APP_HOME
COPY --chown=node:node . $APP_HOME
COPY --chown=node:node --from=builder /build $APP_HOME
USER node
EXPOSE $APP_CONTAINER_PORT
CMD ["npm", "start"]