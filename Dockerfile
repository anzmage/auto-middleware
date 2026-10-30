FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=8790 DB_PATH=/data/auto-middleware.sqlite
VOLUME /data
EXPOSE 8790
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
