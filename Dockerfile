# Facultatif : image Docker avec LibreOffice, pour présenter les PowerPoint et les fichiers Word
# directement en réunion (sans LibreOffice, l'application demande d'enregistrer le fichier en PDF).
# Sur Render : New › Web Service › « Docker » (ou runtime: docker dans render.yaml).
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc fonts-dejavu fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
