FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
# /data is the app's persistent volume (WebManager backs it up)
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
