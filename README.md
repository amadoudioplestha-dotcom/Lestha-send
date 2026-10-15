# TransferX 3.14 — transfert de fichiers sans limites

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

## Nouveautés 3.29.1

- Qualités vidéo du serveur : la vidéo est copiée de R2 dans un fichier temporaire avant la conversion (le ffmpeg statique ne résout pas les noms de domaine sur Render, d'où « vidéo illisible »). Les échecs des versions précédentes sont réessayés tout de suite.

## Nouveautés 3.29 — qualités vidéo automatiques, comme YouTube

- **Sélecteur Auto / 480p / 720p / Original** aussi dans la galerie et l'aperçu de la page de réception (public/js/video-quality.js, partagé avec le lecteur de revue). Auto choisit selon la connexion ; changement au même instant de lecture.
- **Le serveur fabrique une qualité à la fois, la plus légère d'abord** : la 480p est disponible bien avant la 720p (sur un petit serveur, environ 40 % du temps).
- **Suivi fiable** : l'avancement est gardé en mémoire (il disparaissait quand le transfert était relu), la vidéo regardée passe devant les autres, reprise automatique après un redémarrage (déploiement), nouvel essai après un échec (6 h, puis plus espacé), plus de durée maximale stricte (seul un vrai blocage arrête la conversion).
- **Console › Système › Qualités vidéo (serveur)** : conversion en cours, file d'attente, vitesse mesurée, échecs avec leur raison, dernières vidéos prêtes.

## Nouveautés 3.28 — stockage R2 et sauvegarde du secret

- **Console › Système › Stockage Cloudflare R2** : inventaire du bucket toutes les 6 h (ou bouton Actualiser), rangé par usage (fichiers, aperçus, qualités vidéo, documents de réunion, données), jauge sur la part gratuite (R2_FREE_GB, 10 par défaut), coût estimé au-delà, liens les plus lourds. E-mail à ADMIN_EMAIL à 80 et 100 % (lib/storage-usage.js).
- **Console › Système › Sauvegarde du secret** : empreinte d'APP_SECRET et vérification d'une copie de sauvegarde (jamais affichée ni enregistrée). Bannière de rappel tant que la sauvegarde n'est pas confirmée.

## Nouveautés 3.27 — compteur de bande passante

- **Console › Système › Bande passante du serveur** : ce que Render compte ce mois-ci (pages, réponses, temps réel, envois vers R2), jauge sur la limite, estimation de fin de mois et détail par catégorie (lib/bandwidth.js).
- **Bannière** dans la console dès 50 % de la limite, **e-mail** à ADMIN_EMAIL à 50, 80 et 100 % (une fois par seuil et par mois).
- Variable `BW_LIMIT_GB` (5 par défaut) si l'offre Render change.

## Nouveautés 3.26 — moins de bande passante sur le serveur

- **ZIP fabriqué dans le navigateur** (public/js/zip-stream.js) : les fichiers viennent directement de Cloudflare R2 et le ZIP est écrit au fil de l'eau par le Service Worker (Chrome, Edge, Firefox, Android) ou assemblé sur l'appareil (Safari, jusqu'à 400 Mo). Plus rien ne passe par le serveur. Le ZIP du serveur reste en secours.
- **Smart Drop « Tout télécharger »** : même principe (route GET /api/requests/:id/zip-list).
- **Réunions** : le document présenté est téléchargé directement depuis R2 ; les pages présentées sont mises en cache par Cloudflare (URL en .jpg, cache public 24 h).
- **Bibliothèques /vendor** gardées un mois par le navigateur et Cloudflare.

## Nouveautés 3.25.1 — banderoles et très gros PDF

- PDF jusqu'à **300 Mo** en aperçu (avant : 60 Mo). Envoyé depuis un ordinateur, le PDF est préparé (vignette + pages en images) jusqu'à 300 Mo ; depuis un téléphone, jusqu'à 60 Mo.
- Banderoles, roll-up, affiches (pages très larges ou très hautes) : image plus détaillée (2400 px sur le grand côté). Une banderole de 64 Mo s'ouvre en 4G après ≈ 80 Ko.
- Fichiers **Illustrator (.ai)** enregistrés « compatibles PDF » : vignette et aperçu comme un PDF.
- Le PDF n'est lu qu'une fois sur l'appareil de l'expéditeur (vignette et pages ensemble).

## Nouveautés 3.25 — aperçu des documents aussi rapide que les photos

- **PDF** : l'appareil de l'expéditeur dessine les 10 premières pages en images légères (≈ 60 à 200 Ko chacune, `POST /api/transfers/:id/files/:fid/pages`). Le destinataire les voit tout de suite, comme des photos, sans charger le lecteur PDF ; la page 1 s'affiche d'abord avec la vignette déjà en cache. Le lecteur PDF ne se charge que pour les pages suivantes, le zoom ou un grand écran.
- **PowerPoint et Excel** (au-delà de 1,5 Mo) : seule la partie utile du fichier est lue (sommaire de l'archive, puis texte et mise en page), par morceaux. Les images d'une diapositive ne sont chargées qu'en arrivant dessus, deux à la fois, la plus récente d'abord. Un PowerPoint de 25 Mo s'ouvre après ≈ 110 Ko au lieu de 25 Mo (`public/js/zip-range.js`).
- L'aperçu se prépare dès que le doigt touche « Aperçu » ; la vignette s'affiche pendant l'ouverture.
- Anciens liens : bouton **Préparer** de la page de gestion (« Aperçus légers ») pour fabriquer les pages des PDF.

## Nouveautés 3.24 — aperçu des documents avant téléchargement

- PDF, Word (.docx), Excel (.xlsx, .ods), PowerPoint (.pptx), CSV et texte s'ouvrent dans la page avec le bouton **Aperçu** (ou **Voir le document** quand le lien ne contient qu'un document).
- Léger en 4G : un gros PDF n'est lu que par morceaux (un PDF de 25 Mo s'ouvre en chargeant environ 2 Mo), les pages se dessinent au fil du défilement ; texte et CSV : seulement le début du fichier.
- Word, Excel et PowerPoint sont lus par le navigateur du destinataire : rien n'est fabriqué sur le serveur (fonctionne sur le plan gratuit de Render).
- Vignette de la première page dans la liste, préparée par l'appareil de l'expéditeur comme pour les photos ; pour un ancien lien : page de gestion › « Aperçus légers › Préparer ».
- Anciens formats (.doc, .xls, .ppt, OpenDocument) : version PDF préparée par le serveur s'il dispose de LibreOffice (image Docker), sinon invitation à télécharger.
- L'aperçu n'est pas compté comme un téléchargement. PowerPoint : aperçu simplifié (animations et graphiques non reproduits).

## Nouveautés 3.23.1 — liens TikTok dans Direct

- Les liens courts du bouton « Partager » de TikTok (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) sont reconnus : le serveur suit la redirection (uniquement vers tiktok.com) et affiche la vidéo.
- Publications photo TikTok reconnues.
- TikTok LIVE et profils : TikTok interdit leur intégration ; la page du direct affiche un bouton « Ouvrir sur TikTok » et la discussion reste sur Lestha.

## Nouveautés 3.23 — qualités vidéo automatiques, problèmes réglés

- Le serveur fabrique lui-même les qualités 480p et 720p (1080p au-dessus) de toute vidéo qui n'en a pas : 2 min après l'envoi si l'appareil de l'expéditeur ne l'a pas fait, ou à la première visite pour les anciennes vidéos. H.264 + AAC, lisible partout, démarrage immédiat (faststart). Une vidéo à la fois, en priorité basse. Nouvelle dépendance : ffmpeg-static. Désactivable avec TRANSCODE=0.
- Lecteur : pendant la préparation, le menu Qualité affiche l'avancement ; les qualités apparaissent toutes seules, sans recharger.
- Admin, « Problèmes rencontrés » : bouton « Réglé » (le problème disparaît, et ne revient que s'il se reproduit, en ne comptant que les nouvelles fois). Les problèmes pas revus depuis la dernière mise à jour sont rangés à part, avec « Tout marquer comme réglé ».

## Nouveautés 3.22.1 — bouton réglages de qualité

- Sous la vidéo, un bouton réglages toujours visible affiche la qualité en cours (« Auto · 720p », « 480p », « Original · 1080p ») et ouvre le menu Auto · Original · 1080p · 720p · 480p, comme YouTube.
- Si la vidéo n'a que sa version d'origine, le menu l'indique et explique comment préparer les qualités.

## Nouveautés 3.22 — vidéo fluide, qualités comme YouTube

- Mode Auto corrigé : il ne choisit plus l'original lourd d'un téléphone (15-20 Mbit/s) dès qu'une qualité légère existe ; il prend la plus haute qualité que la connexion tient avec 40 % de marge.
- Montée automatique : on démarre sur une qualité sûre, puis on monte d'un cran en silence si la vidéo se charge au moins 2 fois plus vite qu'elle ne se lit.
- Qualités préparées d'office après l'envoi, aussi depuis un téléphone (480p et 720p), sauf en mode économie de données.
- Le menu de qualité (Auto · 1080p · 720p · 480p · Original) reste disponible dans le lecteur.

## Nouveautés 3.21.1 — toutes les vignettes finissent par s'afficher

- Une vignette qui échoue (serveur occupé, réseau qui coupe, lien expiré) est redemandée 3 fois, puis remplacée par l'original : plus de case vide.
- Le serveur accepte les très grandes photos (jusqu'à 200 Mpx et 60 Mo) en les décodant directement en petit.
- Un échec passager ne condamne plus une photo : deux essais avant d'abandonner (en 3.20, un seul échec renvoyait l'original lourd dans la grille).
- Vignette manquante : la version écran (≈ 100 Ko) est servie à la place de l'original.
- Versions écran fabriquées 2 fois plus vite ; le serveur ne fait plus attendre un téléphone plus de 25 s.

## Nouveautés 3.21 — galerie qui s'affiche tout de suite

- Chaque photo arrive avec un minuscule aperçu flou (≈ 500 octets) inclus dans la page : la grille est colorée dès l'ouverture, même en 4G faible.
- Les 15 premières vignettes partent en priorité ; vignettes plus légères (300 px).
- Sur le serveur, toutes les vignettes sont fabriquées avant les versions écran, 15 s après l'envoi (au lieu de 90 s).
- Visionneuse : la photo commence à charger dès que le doigt la touche, et les photos voisines sont préchargées pendant qu'on regarde.
- La sélection reste instantanée (rien n'a changé de ce côté).

## Nouveautés 3.20 — Photos légères pour tout le monde

- **Le serveur compresse lui-même les photos** qui n'ont pas encore d'aperçu (anciens liens, navigateur qui n'a pas pu le faire) : vignette ≈ 360 px (≈ 10 Ko) et version écran 1400 px (≈ 50-200 Ko), faites une seule fois puis gardées. Une photo à la fois pour ménager le serveur ; celle qu'un élève regarde passe devant. L'original n'est jamais modifié et reste celui qu'on télécharge. Route : `/api/public/t/:id/pv/:fid/thumb|view`.
- `sharp` passe des dépendances de développement aux dépendances normales (installé sur Render par `npm ci --omit=dev`).
- **Sélection instantanée** : cocher une photo ne redessine que sa case, sans animation sur l'image (fluide sur les petits téléphones), pas de délai de toucher.

## Nouveautés 3.19 — Plus simple et plus rapide pour les élèves

- **Aperçu WhatsApp** : un lien de partage s'affiche avec la première photo et « 24 photos · 3 vidéos » au lieu d'un lien technique (jamais pour un lien protégé par PIN). Image servie par `/api/public/t/:id/cover.jpg`.
- **Photos d'abord** : quand un envoi ne contient que des photos et vidéos, la galerie passe juste sous le nom de l'expéditeur, avec un gros bouton « Enregistrer toutes les photos ». Compte à rebours, ZIP et conseils restent juste en dessous : rien n'est retiré.
- **Plus rapide** : vignettes et versions écran chargées directement depuis le stockage R2 (sans repasser par le serveur Render), avec des liens stables une heure pour rester en cache. Version écran ramenée à 1400 px.
- **Anciens liens** : dans la page de gestion, « Galerie légère → Préparer » fabrique les vignettes des photos envoyées avant la 3.18.

## Nouveautés 3.18.1 — Vignettes toujours visibles

- Les liens envoyés avant la 3.18 (sans vignettes légères) affichent maintenant leurs photos dans la grille, même au-delà de 80 photos ou jusqu'à 25 Mo par photo ; les photos d'iPhone (HEIC) s'affichent sur iPhone. Le nom du fichier apparaît si une case ne peut pas s'afficher.

## Nouveautés 3.18 — Galerie photos et vidéos

- Sur la page de réception, les photos et vidéos s'affichent en **galerie** : grille de vignettes, puis visionneuse plein écran où l'on fait défiler au doigt (flèches et clavier sur ordinateur).
- Zoom des photos par double-toucher ou en pinçant ; les vidéos se lisent directement dans la visionneuse.
- On **coche** les photos voulues (dans la grille ou la visionneuse) puis « Télécharger » : un par un, en un .zip (seulement les fichiers choisis), ou sur téléphone **directement dans la galerie** (feuille de partage du système).
- Légèreté en 4G : à l'envoi, le navigateur de l'expéditeur fabrique une vignette (≈ 10-30 Ko) et une version écran 1600 px (≈ 100-400 Ko) de chaque photo, plus une image d'aperçu pour chaque vidéo. Les élèves parcourent la galerie sans télécharger les originaux, qui restent intacts. Les anciens envois s'affichent aussi (avec les originaux).
- Le bouton Retour du téléphone ferme la visionneuse sans quitter la page. Le « visionnage seul » reste respecté (pas de téléchargement).
- Serveur : `POST /api/transfers/:id/files/:fid/previews` (JPEG seulement, tailles bornées) et `?only=id1,id2` sur le ZIP.

## Nouveautés 3.17.1 — Console admin : les inscrits

- Nouvel onglet **Inscrits** dans `/admin` : nombre total de comptes, actifs sur 7 et 30 jours, nouveaux de la semaine.
- Liste des adresses e-mail avec date d'inscription, dernière visite, nombre de visites et contenu (transferts, espaces Smart Drop, réunions, directs). Recherche par adresse et export CSV (s'ouvre dans Excel).
- L'annuaire est chiffré sur le serveur comme les coffres. Une personne y apparaît dès qu'elle se connecte avec la version 3.17 ou plus récente.

## Nouveautés 3.17 — Compte enseignant (e-mail + code, sans mot de passe)
- Bouton **Connexion** en haut de l'écran : on tape son e-mail, on reçoit un code à 6 chiffres. Rien à retenir.
- Transferts, espaces Smart Drop, réunions et directs sont gardés dans le compte et **retrouvés sur tout nouvel appareil** (téléphone perdu ou changé, ordinateur de l'école). Synchronisation automatique ; un élément supprimé sur un appareil disparaît aussi des autres.
- « Se déconnecter » : garder ou effacer les espaces de cet appareil (appareil partagé, cybercafé).
- Côté serveur : un coffre par adresse, chiffré (AES-256-GCM), nom de fichier non lié à l'adresse. Élèves et déposants : toujours sans compte.
- Nécessite l'envoi d'e-mails (SendGrid ou SMTP) ; sans lui, le bouton n'apparaît pas. Conseillé : définir `APP_SECRET` sur Render pour que la clé du coffre ne soit pas rangée dans le même stockage.

## 3.16.2 — Son du replay
- Correction importante : le son du replay était muet (l'encodeur MP3 abîmait la voix à 24 kHz). Le replay enregistre maintenant la voix en 16 kHz / 24 kbit/s, nette et toujours aussi légère.
- Le son de votre propre présentation (vidéo, musique partagée avec « Partager aussi le son ») entre dans l'enregistrement, même micro coupé. Changer de micro pendant l'enregistrement ne coupe plus la voix.

## 3.16.1 — Smart Drop
- Le nom du déposant n'apparaît plus deux fois dans la liste des dépôts (il est en titre, il n'est plus répété dans les réponses). Détection du nom plus fiable : « Nom et prénom », champs ajoutés à la main, nom complet tapé dans « Nom ».
- Changement de statut (Validé, À compléter…) : le message « le déposant est prévenu » n'apparaît que si l'e-mail est réellement parti ; sinon l'application dit que le déposant n'a pas laissé d'e-mail.
- Modèle « Rendu de devoir » : champ e-mail facultatif ajouté, pour que l'élève soit prévenu de la correction.

## Nouveautés 3.16 — Replay du cours
- **Enregistrer → « Replay du cours »** : au lieu de filmer l'écran, l'application note ce qui se passe. La voix (MP3 léger), chaque page présentée (une seule image par page), les annotations, le pointeur laser, qui parle et la discussion, avec leur moment exact.
- À la fin, **un seul fichier .html** (environ 15 Mo par heure de cours) qui se lit **sans connexion**, sur téléphone comme sur ordinateur. Pages et annotations sont rejouées en même temps que la voix, nettes à toutes les tailles.
- Lecteur : plan du cours automatique (une entrée par page, cliquable), repères sur la barre de lecture, ±10 s (double appui à gauche ou à droite), vitesse 0,75× à 2×, plein écran, reprise là où on s'était arrêté, commandes sur l'écran verrouillé du téléphone, discussion du cours alignée sur le temps.
- Bouton « Envoyer » (WhatsApp, e-mail…) sur téléphone. La page **/replay** ouvre aussi un replay reçu, utile sur iPhone. Le fichier est lu sur l'appareil, rien n'est envoyé.
- Partage d'écran pendant un replay : une image seulement quand l'écran change vraiment.

## 3.15.1 — Vérification de sécurité
- Dépendances mises à jour : plus aucune faille connue (`npm audit` : 0). nodemailer passe en version 10, express, socket.io (engine.io), qs et proxy-addr corrigés.
- L'application ne peut plus être affichée dans un cadre d'un autre site (protection contre le vol de clics) ; HTTPS imposé aux visites suivantes.
- Présentation de fichiers : taille refusée dès l'en-tête, limites par adresse IP (nouveaux fichiers, conversions PowerPoint), support envoyé en flux (toute une classe peut le télécharger sans saturer la mémoire), plafond mémoire abaissé pour le petit serveur Render.

## Nouveautés 3.15 — « Présenter » en réunion
- **Partager l'écran avec le son** : case « Partager aussi le son » (mémorisée) avant de choisir l'écran. Son d'un onglet (Chrome, Edge) ou de tout l'ordinateur (Windows). Le son de la réunion elle-même n'est pas renvoyé. « Couper le son de la présentation » dans le menu Plus, sans arrêter le partage.
- **Présenter un fichier sans quitter la réunion** : PDF, PowerPoint, Word ou images. Le navigateur de l'enseignant transforme chaque page en image nette, la page affichée part en premier. Chacun reçoit des images légères, au lieu d'une vidéo : texte net, même sur téléphone et petit réseau. L'enseignant peut présenter depuis son téléphone.
- Pages tournées par l'enseignant (flèches, clavier, balayage, vignettes de toutes les pages). Annotations gardées page par page : en revenant sur une page, on retrouve ses traits.
- **Navigation libre** : l'enseignant peut laisser les élèves feuilleter le fichier ; un bouton « Revenir à la page de l'enseignant » les ramène.
- **Support téléchargeable** : l'enseignant autorise d'un clic le téléchargement du fichier d'origine.
- Les pages restent en mémoire le temps de la présentation (200 pages, 60 Mo d'images au maximum) ; le support est effacé à la fin.
- PowerPoint et Word sont convertis en PDF par le serveur s'il dispose de LibreOffice (voir le `Dockerfile` facultatif) ; sinon l'application explique comment enregistrer le fichier en PDF.
- pdf.js (Apache-2.0) est inclus dans `public/vendor/pdfjs` et chargé seulement quand on présente un PDF.

## Nouveautés 3.14.1 — Nouvelle page « Direct »
- Salle du direct façon plateforme vidéo : grand lecteur avec halo, badge EN DIRECT et compteur de spectateurs sur l'image, réactions des spectateurs qui s'envolent sur la vidéo, partage WhatsApp / lien / QR en pastilles, fiche de l'animateur avec avatar et « À propos ».
- Discussion en direct repensée : avatars colorés, heure, badge « Animateur », nom mémorisé (« Vous écrivez en tant que… »), zone de saisie fixe en bas.
- Studio de création : choix de la source en cartes, détection automatique de la plateforme dans le lien, aperçu en direct de la page, « Mes directs » en vignettes.
- Début prévu respecté : compte à rebours plein écran jusqu'à l'heure dite, puis passage automatique en direct.
- Correctif : le bouton Retour ne casse plus la mise en page du direct. Téléphone : lecteur bord à bord.

## Nouveautés 3.14 — Outils de l'enseignant pendant une réunion ou un cours

- **Fenêtre flottante** (Chrome, Edge) : elle s'ouvre en cliquant « Présenter » et reste au-dessus de PowerPoint ou d'un autre onglet. On y voit les mains levées dans l'ordre (bouton « Donner la parole »), les réactions, la discussion (on peut répondre), « compris / perdu », qui suit le cours, le minuteur, et on y coupe son micro ou arrête la présentation. Bouton dédié dans la barre pendant une présentation. Safari : version image en lecture seule. Ailleurs : notification du système, titre de l'onglet qui clignote, petit son.
- **Annotations** sur la présentation : pointeur laser, stylo, surligneur, encre éphémère, lignes, flèches, rectangles, ellipses, zone de texte, note, tampons (✅ ❌ ⭐ ❓…), 10 couleurs, 3 épaisseurs, gomme, annuler (Ctrl+Z), tout effacer, « autoriser les participants à annoter ». Les traits tombent au même endroit chez tout le monde (ordinateur et téléphone), sont visibles par ceux qui arrivent en retard, apparaissent dans l'enregistrement vidéo et disparaissent à la fin de la présentation.
- **Tableau blanc** : l'animateur l'ouvre sans partager d'écran (menu « Plus »), avec les mêmes outils.
- **Minuteur commun** (1 à 30 min ou au choix, avec intitulé) : compte à rebours chez tous et signal sonore à la fin.
- **« J'ai compris / Je suis perdu »** dans le menu des réactions : l'enseignant voit le compte dans l'en-tête, une pastille 🤔 sur la vignette, et peut donner la parole ou remettre à zéro.
- **Qui suit le cours** (mode Cours) : l'enseignant voit qui a quitté la page du cours depuis plus de 8 secondes. Les participants en sont informés à l'entrée.
- **Quiz éclair** : modèles de sondage en un appui (Compris ?, Vrai / Faux, A B C D, note de 1 à 5, rythme du cours).

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
