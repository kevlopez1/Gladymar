# Imagen universal para desplegar el agente/demo en cualquier hosting
# (Railway, Fly.io, Cloud Run, etc.). El servidor se ejecuta con tsx (TypeScript
# directo), así que no requiere paso de compilación.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
# El puerto real lo define el hosting vía la variable PORT.
EXPOSE 3000

CMD ["npm", "start"]
