# My Social Networks API

Projet d’API REST en Node.js, Express et MongoDB pour gérer des groupes et des événements. On peut gérer les participants, les discussions, les photos, les sondages, les billets et la shopping list. Le covoiturage est inclus en bonus.

## Lancer l’API

Il faut Node.js 18.20 ou plus et MongoDB en mode replica set. Avec Docker Desktop ouvert, lancer la base depuis le dossier du projet.

```bash
docker compose up -d --wait
```

Dans Git Bash, préparer le fichier `.env` et générer une clé.

```bash
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copier la clé dans `JWT_SECRET` dans `.env`. Si la base est sur Atlas ou sur un replica set déjà configuré, mettre son URI dans `MONGODB_URI`.

```bash
npm start
```

L’URL de base est `http://localhost:3000/api/v1`.

### MongoDB local sans Docker

Avec `mongod` et `mongosh` installés, ouvrir un terminal dans Git Bash et lancer MongoDB sur le port 27018.

```bash
mkdir -p "$HOME/mongo-social-dev"
mongod --dbpath "$HOME/mongo-social-dev" --replSet rs0 --bind_ip 127.0.0.1 --port 27018
```

Dans un deuxième terminal, initialiser le replica set une seule fois.

```bash
mongosh 'mongodb://127.0.0.1:27018/?directConnection=true' --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27018"}]})'
```

Dans `.env`, utiliser `MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true`.

## Postman

Importer [la collection Postman](postman/My_Social_Networks_API.postman_collection.json). Elle apparaît sous le nom **My Social Networks API – Documentation détaillée**. Chaque requête explique son but, les droits d’accès, les données à envoyer, la réponse et les vérifications du test.

1. Envoyer `GET /health`. La réponse attendue est `200 OK` avec `{"status":"ok"}`.
2. Lancer le dossier **Démo guidée** dans le Collection Runner pour essayer les principales fonctionnalités avec des données fictives.

Avec MongoDB démarré, les tests du projet se lancent avec `npm test`.

## Documentation publiée

[Documentation publique de l’API](https://documenter.getpostman.com/view/39391761/2sBYHbrbXQ)
