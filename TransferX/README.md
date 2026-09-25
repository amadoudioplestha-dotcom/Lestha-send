# TransferX 3.0 — transfert de fichiers sans limites

Deux modes, une seule application :

| | **Cloud** (nouveau, par défaut) | **Direct P2P** (mode d'origine, fiabilisé) |
|---|---|---|
| Le lien marche si l'expéditeur ferme l'appli | ✅ oui, jusqu'à l'expiration | ⚠️ il doit revenir (le transfert reprend alors tout seul) |
| Taille max | 250 Go par envoi (réglable) | limitée par le disque du destinataire |
| Vitesse | upload direct vers R2 en parallèle, téléchargement direct depuis R2 | appareil → appareil |
| Reprise | upload **et** téléchargement | à l'octet près |
| Stockage | Cloudflare R2, supprimé à expiration | aucun |

## Ce qui a changé

**Problème corrigé : « quand je quitte la plateforme, le lien ne marche plus ».**
En P2P, le fichier ne vit que sur l'appareil de l'expéditeur : dès qu'il quittait la page, le serveur détruisait la room.
- Mode **Cloud** : les fichiers sont déposés sur R2 → le lien fonctionne même appli fermée, téléphone éteint.
- Mode **P2P** : la room n'est plus détruite. L'expéditeur la récupère automatiquement (clé expéditeur) à son retour, même après un redémarrage du serveur ; le destinataire voit « expéditeur momentanément hors ligne » et reprend à l'octet près.

**Envois de plus de 50 Go** : upload multipart (morceaux de 8 Mo, jusqu'à 10 000 morceaux, taille adaptée au-delà de 70 Go), **directement du navigateur vers R2** via URLs présignées. Le serveur ne voit passer aucun octet → pas de goulot d'étranglement, rien en mémoire (le navigateur lit chaque morceau depuis le disque).

**Vitesse** : aucune limite imposée par l'application. 3 à 5 morceaux en parallèle à l'envoi ; au téléchargement, redirection vers l'URL R2 (réseau Cloudflare) — compatible avec les gestionnaires multi-connexions (IDM, aria2 : bouton « lien direct »). La vitesse réelle reste bornée par la connexion de chacun.

**Reprise** :
- Envoi : coupure réseau → pause auto puis reprise ; page fermée → le tableau de bord propose « Reprendre », on resélectionne les fichiers et seuls les morceaux manquants partent.
- Téléchargement : réponses HTTP `Range` → le bouton « Reprendre » du navigateur repart là où il s'était arrêté.
- P2P : écriture disque en place (OPFS, Worker) + contrôle de flux → reprise exacte, plus de saturation mémoire sur les petits téléphones.

**Tableau de bord** : KPIs animés (liens actifs, téléchargements, visiteurs uniques, taux de conversion, volume), graphique d'activité 14 jours, **flux en direct** (socket.io) avec appareil et navigateur, alertes système et e-mail au 1er téléchargement, badge de nouveaux téléchargements, envois interrompus à reprendre, recherche et filtres.
Page de gestion par transfert : graphique 48 h / 30 j, fichiers les plus téléchargés, journal, et contrôles : activer/désactiver, prolonger, PIN, limite de destinataires, QR code, **lien de gestion privé** (piloter depuis un autre appareil), suppression immédiate, sauvegarde/import.

**Design** : interface premium sombre (identité cyan → turquoise conservée), glisser-déposer de dossiers entiers, coller, aperçus images/vidéos/audio/PDF, anneau de progression avec vitesse et temps restant, compte à rebours d'expiration, confettis, toasts, modales façon bottom-sheet sur mobile, effets allégés automatiquement sur les téléphones modestes.

## Architecture

```
server.js            Express + socket.io
lib/storage.js       drivers "s3" (R2/S3) et "local" (disque) — même interface
lib/db.js            métadonnées en JSON DANS le stockage (meta/<id>.json) → serveur sans état
lib/cloud.js         API transferts : création, URLs de morceaux, reprise, finalisation,
                     téléchargement (redirection R2 / flux Range), ZIP en streaming (ZIP64),
                     statistiques, PIN (scrypt + jetons HMAC), limites, nettoyage auto
lib/p2p.js           signalisation WebRTC avec rooms persistantes
lib/email.js         SendGrid ou SMTP
public/js/*.js       modules ES : envoi, uploader, réception, P2P, tableau de bord, gestion
public/js/opfs-worker.js   écriture disque synchrone pour le P2P
```

Les métadonnées étant stockées dans R2, un redémarrage ou une mise en veille (Render gratuit) **ne casse aucun lien**.

## Mise en route

```bash
npm install
cp .env.example .env     # puis remplir
npm start                # http://localhost:3000
```
Sans variables R2, l'appli démarre en stockage **disque local** (`./data`) — pratique pour tester.

### Cloudflare R2 (5 minutes)
1. Cloudflare → **R2** → *Create bucket* (`transferx`).
2. *Manage R2 API Tokens* → jeton « Object Read & Write » limité au bucket → noter *Access Key ID*, *Secret* et l'*Account ID*.
3. Bucket → *Settings* → **CORS policy** : coller `r2-cors.json` en remplaçant l'origine par votre domaine. Indispensable : le navigateur envoie les morceaux directement au bucket.
4. Bucket → *Settings* → **Object lifecycle rules** : ajouter « Abort incomplete multipart uploads after 7 days » (filet de sécurité).
5. Renseigner `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `PUBLIC_URL`, `APP_SECRET`.

Coûts R2 : 10 Go gratuits, puis ~0,015 $/Go/mois, **sortie (téléchargements) gratuite**. Les fichiers sont supprimés automatiquement à l'expiration (vérification toutes les 10 min).

### Render
`render.yaml` est fourni (Blueprint). Les uploads et téléchargements passent directement par R2 : la bande passante du serveur n'est sollicitée que pour le **ZIP « Tout télécharger »** (flux relayé). Pour les très gros envois, conseillez « Un par un » (reprenable).

## API (résumé)
| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/transfers` | créer un transfert → `id`, `ownerKey`, plan des morceaux |
| POST | `/api/transfers/:id/files/:fid/urls` | URLs présignées pour des morceaux |
| GET | `/api/transfers/:id/files/:fid/parts` | morceaux déjà reçus (reprise) |
| POST | `/api/transfers/:id/files/:fid/complete` | assembler un fichier |
| POST | `/api/transfers/:id/finalize` | activer le lien (+ e-mails) |
| GET/PATCH/DELETE | `/api/transfers/:id` | gestion (en-tête `X-Owner-Key`) |
| GET | `/api/public/t/:id` | infos destinataire |
| POST | `/api/public/t/:id/unlock` | vérifier le PIN → jeton |
| GET | `/api/public/t/:id/f/:fid` | télécharger un fichier (reprise) |
| GET | `/api/public/t/:id/zip` | tout en ZIP |

## Sécurité
Identifiants de lien aléatoires (62¹⁰), clé de gestion 192 bits stockée hachée, PIN haché (scrypt) avec limitation des tentatives, URLs R2 signées et temporaires, noms de fichiers jamais utilisés comme clés de stockage, e-mails P2P limités au domaine de l'appli (plus de relais de spam), limitation de débit par IP, **code d'accès optionnel à l'envoi** (`UPLOAD_CODE`) pour réserver la création de liens à votre équipe.
Mode Cloud : chiffrement en transit (HTTPS) et au repos (R2). Mode Direct : chiffrement de bout en bout WebRTC, rien n'est stocké.
