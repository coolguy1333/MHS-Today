FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
# Whatever modes the build checkout had (WebManager's can be 0600/0700), the app must be readable by `node`.
RUN chmod -R u+rwX,go+rX /app \
 && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
