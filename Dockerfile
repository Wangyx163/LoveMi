FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8768

COPY --chown=node:node . .
USER node

EXPOSE 8768
CMD ["npm", "start"]
