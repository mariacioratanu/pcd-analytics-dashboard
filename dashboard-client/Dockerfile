FROM node:25-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY app.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]