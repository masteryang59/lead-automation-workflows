# Mock enrichment API, CRM and Slack webhook, plus the demo form and dashboard.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY mock-services ./mock-services

USER node
EXPOSE 4000
CMD ["node", "mock-services/server.js"]
ENV ROLLBACK_CHANGES=true
ENV EMIT_EVENT=true
ENV TRACE_REQUEST=true
ENV ROLLBACK_CHANGES=true