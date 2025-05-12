# Utiliser une image Node.js officielle comme base (version légère pour optimiser)
FROM node:18-alpine AS builder

# Définir le répertoire de travail dans le conteneur
WORKDIR /app

# Copier les fichiers package.json et package-lock.json pour installer les dépendances
COPY package.json package-lock.json ./

# Installer les dépendances
RUN npm install --production

# Copier le reste des fichiers du projet
COPY . .

# Étape finale : image de production
FROM node:18-alpine

WORKDIR /app

# Copier uniquement les dépendances et le code nécessaire depuis l'étape de build
COPY --from=builder /app .

# Exposer le port utilisé par ton serveur (par défaut 3000)
EXPOSE 3000

# Commande pour démarrer le serveur avec app.js
CMD ["node", "app.js"]