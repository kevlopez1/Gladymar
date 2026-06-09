# Imagen universal para desplegar el agente/demo en cualquier hosting
# (Railway, Fly.io, Cloud Run, etc.).
FROM node:22-slim

WORKDIR /app

# Instala dependencias (incluye devDependencies para poder compilar TypeScript)
COPY package*.json ./
RUN npm install --include=dev

# Copia el código y compila
COPY . .
RUN npm run build

ENV NODE_ENV=production
# El puerto real lo define el hosting vía la variable PORT.
EXPOSE 3000

CMD ["npm", "start"]
