FROM node:25-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY client.js ./
COPY proto ./proto

ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]