# TransferX 3.5 — transfert de fichiers sans limites

Deux modes, une seule application :

| | **Cloud** (nouveau, par défaut) | **Direct P2P** (mode d'origine, fiabilisé) |
|---|---|---|
| Le lien marche si l'expéditeur ferme l'appli | ✅ oui, jusqu'à l'expiration | ⚠️ il doit revenir (le transfert reprend alors tout seul) |
| Taille max | 250 Gio par envoi par défaut (réglable) | 250 Gio par transfert, sous réserve de l'espace disque disponible sur le destinataire |
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
- P2P : écriture disque en place (OPFS, Worker) + contrôle de flux → reprise exacte, sans charger le fichier entier en mémoire. Jusqu'à 250 Gio, sous réserve que le navigateur et l'espace disque du destinataire le permettent.

**Tableau de bord** : KPIs animés (liens actifs, téléchargements, visiteurs uniques, taux de conversion, volume), graphique d'activité 14 jours, **flux en direct** (socket.io) avec appareil et navigateur, alertes système et e-mail au 1er téléchargement, badge de nouveaux téléchargements, envois interrompus à reprendre, recherche et filtres.
Page de gestion par transfert : graphique 48 h / 30 j, fichiers les plus téléchargés, journal, et contrôles : activer/désactiver, prolonger, PIN, limite de destinataires, QR code, **lien de gestion privé** (piloter depuis un autre appareil), suppression immédiate, sauvegarde/import.

**Design** : interface premium sombre (identité cyan → turquoise conservée), glisser-déposer de dossiers entiers, coller, aperçus images/vidéos/audio/PDF, anneau de progression avec vitesse et temps restant, compte à rebours d'expiration, confettis, toasts, modales façon bottom-sheet sur mobile, effets allégés automatiquement sur les téléphones modestes.

## Nouveautés 3.5 — Classe virtuelle (Direct › « Classe virtuelle (caméra / écran) »)
- **Rôles** : tuteur (créateur), **modérateur** (lien de co-animation `#m=…`), participants (nom demandé à l'entrée, sans compte).
- Tuteur : caméra, **présentation d'écran**, micro seul, bascule à chaud, coupure micro.
- **Lever la main ✋**, **réactions** (👍 👏 ❤️ 😂 ❓ 🐢) animées sur la vidéo.
- **Donner / retirer la parole** : l'apprenant parle à toute la classe (micro + caméra optionnelle, vignettes « intervenants »), « Rendre la parole ».
- **Modération** : couper un micro / tous les micros, baisser les mains, **retirer** un participant, **verrouiller la salle**, **salle d'attente** (admettre / refuser / tout admettre).
- **Sondages** en direct (résultats en temps réel, clore, effacer).
- **Liste de présence** (arrivée, dernière présence, durée, connexions) exportable en Excel.
- **Enregistrement du cours** (vidéo du tuteur + voix des intervenants) → téléchargement ou **publication en replay TransferX** (lecture en ligne + remarques horodatées), lien posté dans la discussion.
- Limite : 25 participants (diffusion pair-à-pair). Mosaïque de toutes les caméras = serveur vidéo SFU payant (évolution possible).

## Classe virtuelle hébergée BigBlueButton (`/classe`)

Une option distincte du mode Direct 3.5 : TransferX peut déléguer les réunions à un serveur BigBlueButton existant. L’interface native BBB fournit caméra, micro, partage d’écran, chat, sondages, main levée, modération et enregistrement; ces fonctions ne sont pas réimplémentées dans le mode Direct existant.
- création protégée par `CLASSROOM_CREATE_CODE` (16 caractères aléatoires minimum), liens séparés participant et enseignant, maximum BBB de 2 participants par défaut ;
- signature des appels API et génération côté serveur des liens d’entrée; le secret BBB n’est jamais envoyé au navigateur ;
- fin de réunion, relevé de présence à la demande/toutes les 30 s tant que l’enseignant garde la page ouverte, export CSV et consultation des enregistrements ;
- l’enregistrement est facultatif et activé explicitement à la création. BBB notifie les participants; les vidéos restent sur le stockage BBB ;
- l’historique TransferX est conservé jusqu’à 30 jours et n’est pas une preuve certifiée de présence.

Configurer dans l’environnement Render : `BBB_URL` (par exemple `https://bbb.exemple.org/bigbluebutton`, sans `/api`), `BBB_SECRET` (secret partagé/securitySalt de BBB) et un `CLASSROOM_CREATE_CODE` aléatoire d’au moins 16 caractères. `BBB_MAX_PARTICIPANTS` vaut 2 par défaut pour correspondre à l’offre d’essai décrite; ne l’augmentez qu’après confirmation d’une capacité supérieure par votre fournisseur. Les serveurs distants doivent utiliser HTTPS. Sans ces réglages, aucune réunion BBB n’est créée; le mode Direct demeure indépendant.

## Nouveautés 3.4 — Direct (`/direct` → salle `/live/:id`)
- **Lien de plateforme** : YouTube (vidéo et live), Facebook (vidéo et live), Vimeo, Twitch, publications Instagram / TikTok — lecteur **officiel** intégré, rien n'est recopié. (Les lives Instagram/TikTok ne sont pas intégrables : limite des plateformes.)
- **Caméra / écran / micro** diffusés depuis le navigateur (WebRTC, jusqu'à 25 spectateurs, débit adapté automatiquement, changement de source à chaud).
- **Flux .m3u8** (OBS, régie) lu avec hls.js.
- Discussion en direct, compteur de spectateurs, compte à rebours, badge EN DIRECT, partage WhatsApp, QR plein écran à projeter, régie (passer en direct, terminer, fermer la discussion, supprimer).

## Nouveautés 3.3 — Revue vidéo pro (façon Frame.io) + fichiers .TS

Active **Lecture en ligne** + **Commentaires horodatés** sur un envoi : le lien `/w/:id` devient une salle de revue.
- **Timecode à l'image près** (23,976 → 60 i/s), raccourcis **J/K/L**, **← →** image par image, vitesses 0,25×–2×, **plage In/Out** (I / O) et boucle.
- **Annotations dessinées sur l'image** : flèche, crayon, cadre, cercle, 5 couleurs ; réaffichées quand on clique la remarque.
- **Marqueurs sur la timeline** (rouge = à traiter, vert = traité), **fils de réponses**, case **« Traité »**, filtres.
- **Validation** : « Approuver » / « Demander des modifications » (e-mail + notification à l'auteur).
- **Versions V1, V2, V3…** sur le **même lien** (bouton « Nouvelle version » dans la page de gestion) ; chaque version garde ses remarques, les relecteurs sont prévenus.
- **Exports** : EDL de marqueurs pour **DaVinci Resolve**, **CSV** (Excel/Sheets), **rapport PDF** imprimable.
- **.TS / .M2TS** (MPEG-TS H.264 + AAC) lus dans le navigateur via mpegts.js (ordinateur, Android ; pas sur iPhone).

## Nouveautés 3.2 — Lots 2, 3 et 4

**À proximité** (`/proximite`) — partage façon AirDrop entre **tous** les appareils (Android, iPhone, Mac, Windows, Linux), sans installation :
- découverte automatique des appareils sur le même Wi-Fi (radar), nom d'appareil modifiable ;
- **appareils associés** par code à 6 chiffres ou QR : ils se retrouvent même sur des réseaux différents (jeton signé, rien n'est stocké côté serveur) ;
- envoi de fichiers, dossiers, photos, avec acceptation par le destinataire ; transfert **direct** WebRTC (le serveur ne voit jamais les fichiers) ;
- **presse-papiers partagé** : texte ou lien d'un appareil à l'autre (bouton « Ouvrir » pour les liens).
Les transferts jusqu'à 250 Gio sont écrits progressivement sur le stockage privé du navigateur (OPFS), avec contrôle de flux ; les fichiers ne sont pas chargés entièrement en RAM. La capacité effective dépend de l'espace disque et du quota accordé par le navigateur. Si OPFS est indisponible, la réception en mémoire reste volontairement limitée à 500 Mio sur téléphone et 2 Gio sur ordinateur.

**Lien de visionnage** (`/w/:id`) — option « Lecture en ligne » à l'envoi :
- *Lecture + téléchargement* ou *Visionnage seul* (boutons de téléchargement et ZIP désactivés côté serveur, liens de lecture courts, filigrane mobile) ;
- lecteur avec playlist, **reprise** là où on s'était arrêté, **sous-titres** automatiques (`video.fr.srt` ou `.vtt` envoyés avec la vidéo) ;
- **statistiques de visionnage** : spectateurs, % vu en moyenne, visionnages complets (événements 25/50/75/95 %) ;
- **commentaires horodatés** (« à 02:14, couper ce plan ») : cliquables, visibles et supprimables dans la page de gestion, notifiés en direct.
Formats : MP4 H.264, WebM, MP3/M4A lus partout ; MKV/AVI/H.265 affichent un message clair.

**Demande de fichiers** (`/demande` → lien `/d/:id`, gestion `/r/:id`) :
- consignes, date limite, taille maximale par dépôt, code facultatif pour déposer, alerte e-mail à chaque dépôt ;
- les déposants donnent leur nom (+ message) et envoient avec la même technologie que le mode Cloud (morceaux parallèles, reprise) ;
- chaque dépôt est un transfert qui vous appartient (le déposant n'a qu'une clé d'envoi) : ouvrir, ZIP, supprimer ;
- dépôts en direct, ouverture/fermeture, prolongation, QR à projeter en classe ; les demandes apparaissent dans le tableau de bord.

## Nouveautés 3.1 — Lot 1 « Fondations »

**Garde-fou stockage.** Au démarrage, le serveur teste réellement le stockage (écriture → lecture → suppression). Si les clés R2 sont fausses, il s'arrête et Render garde l'ancienne version en ligne. Sur Render sans R2, le mode Cloud est désactivé automatiquement (seul le P2P reste proposé) : plus aucun lien « introuvable » après un redémarrage. `/health` indique `"cloud": true|false`.

**Console d'administration discrète** (`ADMIN_PASSWORD` + `ADMIN_PATH`) :
- *Vue d'ensemble* : liens actifs, stockage, téléchargements, visiteurs, connexions en direct, liens P2P, graphique 30 jours, appareils et navigateurs, palmarès.
- *Transferts* : recherche, filtres, tri ; fiche détaillée ; désactiver, prolonger, supprimer, copier le lien.
- *Activité* : flux en direct (nouveaux envois, ouvertures, téléchargements, PIN erronés, suppressions).
- *Sécurité* : expéditeurs les plus actifs (empreinte de connexion, jamais l'IP complète), blocage/déblocage, PIN erronés.
- *Système* : état de la configuration et **diagnostic complet** (stockage, règle CORS R2, envoi, téléchargement, nettoyage) + e-mail de test.

L'admin ne voit que des métadonnées : jamais le contenu des fichiers ni les messages.

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
lib/admin.js         console d'administration (API + flux temps réel)
lib/security.js      empreintes d'IP, masquage, liste de blocage
views/admin.html     page de la console (servie uniquement sur ADMIN_PATH)
lib/requests.js      demandes de fichiers (liens de dépôt)
lib/nearby.js        À proximité : présence, appairage signé, relais de signalisation
lib/live.js          Direct : salles, discussion, signalisation caméra (lives/<id>.json)
lib/classroom.js     intégration serveur BigBlueButton : réunions, accès enseignant, présences et enregistrements
public/js/nearby.js  radar + transfert direct · watch.js lecteur · request.js dépôts
public/js/*.js       modules ES : envoi, uploader, réception, P2P, tableau de bord, gestion et classe BBB
public/js/opfs-worker.js   écriture disque synchrone pour les réceptions directes
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
| POST | `/api/classrooms` | créer une réunion BigBlueButton (code enseignant requis) |
| POST | `/api/classrooms/:id/join` | demander un lien signé participant/enseignant |
| GET | `/api/classrooms/:id/attendance` | lire l’historique des présences (enseignant) |
| POST | `/api/classrooms/:id/attendance/refresh` | relever les présences BBB en direct (enseignant) |
| GET | `/api/classrooms/:id/recordings` | lister les replays BBB (enseignant) |

## Sécurité
Identifiants de lien aléatoires (62¹⁰), clé de gestion 192 bits stockée hachée, PIN haché (scrypt) avec limitation des tentatives, URLs R2 signées et temporaires, noms de fichiers jamais utilisés comme clés de stockage, e-mails P2P limités au domaine de l'appli (plus de relais de spam), limitation de débit par IP, **code d'accès optionnel à l'envoi** (`UPLOAD_CODE`) pour réserver la création de liens à votre équipe.
Mode Cloud : chiffrement en transit (HTTPS) et au repos (R2). Mode Direct : chiffrement de bout en bout WebRTC, rien n'est stocké.

Les types téléversés ne sont pas considérés comme fiables : l’affichage intégré est limité aux images matricielles, médias audio/vidéo et PDF; les autres contenus, notamment HTML et SVG, sont servis en pièce jointe avec `application/octet-stream` et `X-Content-Type-Options: nosniff`.
