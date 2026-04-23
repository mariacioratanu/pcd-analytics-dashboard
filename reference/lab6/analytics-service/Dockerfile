FROM node:25-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY index.js .
EXPOSE 8080
CMD ["node", "index.js"]