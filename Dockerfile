# No build step, on purpose: the service is plain JavaScript-in-TypeScript that
# Node executes directly, so the image is the repository plus a runtime. There is
# nothing here that can be out of date with the source.
#
# node:sqlite is a built-in module, so there is nothing to compile and no native
# dependency to keep in step with the base image.

FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8484 \
    HUMANS_DATA_DIR=/data

WORKDIR /app

# Only the manifests first, so a source edit does not re-install dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY public ./public
# The documents the site serves, and the licence they are served under. Missing
# any of them is a boot failure rather than a 404, so they are not optional files.
COPY docs ./docs
COPY DISCLAIMER.md LICENSE ./

# State lives in one SQLite file, on a volume rather than in the image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8484

# A deployment should be able to say whether it is answering at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
