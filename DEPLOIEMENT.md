# Lestha Send 3.6 : mise en production

Suivez ces étapes dans l'ordre. L'ordre de l'étape 2 est important : si vous l'inversez, le site refusera tous les visiteurs.

## 1. Installer la nouvelle version

Depuis votre dossier du projet, à jour sur `main` :

```bash
git checkout -b securite-lancement
git am lestha-send-securite.patch      # applique le commit fourni
npm install
npm test                               # 24 tests doivent passer
git checkout main && git merge securite-lancement
```

Ne poussez pas encore sur GitHub : Render redéploierait tout de suite. Commencez par l'étape 2.

## 2. Protéger l'origine (dans cet ordre)

Le serveur Render reste joignable en direct à l'adresse `xxx.onrender.com`. Un attaquant pourrait donc passer à côté de Cloudflare et choisir lui-même son adresse IP, ce qui annulerait toutes les limites anti-abus. Le correctif : Cloudflare ajoute un en-tête secret à chaque requête, et le serveur refuse celles qui ne l'ont pas.

1. Générez un secret d'au moins 32 caractères, par exemple avec `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
2. Dans **Cloudflare → lestha-send.com → Rules → Transform Rules → Modify Request Header → Create rule** :
   - **Rule name** : `Origine Lestha Send`
   - **If incoming requests match…** : cochez **All incoming requests** (aucun champ à remplir)
   - **Then… Modify request header** :
     - Operation : **Set static**
     - Header name : `X-Origin-Secret` (uniquement ce texte)
     - Value : votre secret
   - Cliquez sur **Deploy**.
3. **Ensuite seulement**, dans **Render → Environment**, ajoutez `ORIGIN_SECRET` avec la même valeur.
4. Vérifiez :
   - `https://lestha-send.com` s'ouvre normalement ;
   - `https://<votre-service>.onrender.com` affiche « Accès direct refusé » ;
   - `/health` répond toujours, car Render l'utilise pour son contrôle de santé.

## 3. Variables Render à ajouter

| Variable | Valeur conseillée | Rôle |
|---|---|---|
| `APP_SECRET` | nouvelle chaîne aléatoire (48 caractères) | Signature des jetons. Le dossier `data/` publié sur GitHub contenait un secret local ; utilisez une valeur neuve qui n'a jamais été publiée. |
| `ADMIN_EMAIL` | votre adresse | Reçoit les signalements d'abus. |
| `CONTACT_EMAIL` | adresse publique de contact | Affichée sur les pages Conditions et Confidentialité. |
| `STORAGE_QUOTA_GB` | `200` | Au-delà, les nouveaux envois Cloud sont refusés et le mode Direct reste disponible. 200 Go coûtent environ 3 $ par mois sur R2. |
| `EMAIL_DAILY_CAP` | `300` | Plafond d'e-mails par jour, pour protéger votre compte SendGrid. Le plan gratuit SendGrid ne permet que 100 e-mails par jour : mettez `100` si vous êtes sur ce plan. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | facultatif | Anti-robot. **Cloudflare → Turnstile → Add site**, domaine `lestha-send.com`, mode *Managed*. |

Les offres (`FREE_MAX_GB`, `VERIFIED_MAX_GB`, etc.) ont des valeurs par défaut raisonnables. Elles sont documentées dans `.env.example`.

Poussez ensuite `main` sur GitHub : Render redéploie.

## 4. Cloudflare R2 : règle de nettoyage

**R2 → votre bucket → Settings → Object lifecycle rules → Add rule** : *Abort incomplete multipart uploads* après **1 jour**. Les envois abandonnés en cours de route ne restent ainsi pas facturés.

## 5. Dépôt GitHub

- Passez le dépôt en **privé** : *Settings → General → Danger Zone → Change visibility*.
- Les fichiers de `data/` ne sont plus suivis par git. Ils restent cependant visibles dans l'historique, d'où le nouveau `APP_SECRET` de l'étape 3.

## 6. Ce qui change pour les utilisateurs

- **Sans compte** : jusqu'à 2 Go par envoi, liens de 3 jours, 10 envois par jour. Pas d'e-mail ni de demande de fichiers.
- **Avec une adresse confirmée** (code à 6 chiffres reçu par e-mail, valable 30 jours sur l'appareil) : jusqu'à 10 Go, liens de 7 jours, 20 envois par jour, envoi du lien à 3 destinataires, alertes de téléchargement et demandes de fichiers.
- **Mode Direct et À proximité** : toujours illimités, sans compte.
- **PIN** : les nouveaux PIN font 6 à 8 chiffres. Les anciens PIN à 4 chiffres continuent de fonctionner. Après 20 erreurs en une heure, le lien est verrouillé pendant une heure.
- **Signalement** : chaque page de téléchargement a un bouton « Signaler ». Le lien est suspendu automatiquement après 3 signalements distincts, ou 6 si l'expéditeur a confirmé son adresse. Vous recevez un e-mail. L'expéditeur ne peut pas réactiver lui-même un lien suspendu.
- **Liens Direct** : les salons ouverts avant la mise à jour ne pourront pas être repris après le redémarrage. Il suffit d'en créer un nouveau.

## 7. Votre accès administrateur

Il est inchangé, et même élargi :

- **Aucune limite pour vous.** Connectez-vous une fois à la console (`/admin` ou votre `ADMIN_PATH`) sur votre téléphone ou votre ordinateur. Pendant 12 heures, les pages publiques de cet appareil affichent alors « Mode administrateur » : pas de plafond de taille, de durée ni d'envois par jour, pas de vérification d'e-mail ni d'anti-robot, et autant de destinataires que vous voulez. Le bouton de déconnexion de la console rétablit l'offre normale. Le code `UPLOAD_CODE` donne le même niveau à qui vous le confiez.
- **Ce que vous voyez** : tous les envois et toutes les demandes, avec leurs noms de fichiers, tailles, statistiques, l'offre utilisée, si l'expéditeur est vérifié, et les signalements avec leurs motifs. Vous voyez aussi l'état du système : protection de l'origine, Turnstile, e-mails du jour par rapport au plafond, stockage réellement utilisé.
- **Ce que vous pouvez faire** : suspendre ou réactiver n'importe quel lien (réactiver efface les signalements), supprimer, bloquer une adresse.
- **Ce que personne ne voit** : le contenu des transferts Direct et À proximité, qui ne passe jamais par le serveur. Pour le Cloud, vous gardez techniquement la main sur le stockage, mais la console n'ouvre pas les fichiers. C'est ce que promet la page Confidentialité.

## 8. Après la mise en ligne

Dans la console, la rubrique Système ne doit plus afficher d'avertissement `no-origin-secret`. L'avertissement `no-turnstile` est normal si vous n'avez pas activé Turnstile.

Faites un essai complet :

1. un envoi sans compte ;
2. la confirmation de votre adresse depuis un autre navigateur ;
3. un envoi avec e-mail ;
4. un signalement de test, puis la réactivation depuis la console.

## 9. Nouveautés de la version 3.7

Ces fonctions ne demandent aucun réglage : elles marchent dès le déploiement.

- **Mode clair.** Le bouton rond en haut à droite passe de Automatique (suit le téléphone) à Clair, puis à Sombre. Le choix est mémorisé sur l'appareil.
- **Nouvelles pages.**
  - `/a-propos` : votre histoire.
  - `/securite` : comment les fichiers sont protégés.
  - `/faq` : questions fréquentes.
  - Une vraie page 404 pour les adresses inconnues.
  - Les liens vers ces pages sont en bas de chaque page.
- **Page À propos.** Elle contient votre photo (`public/img/fondateur.jpg`, déjà en place), une courte présentation, vos engagements et votre contact. Pour afficher un bouton LinkedIn, ajoutez sur Render `FOUNDER_LINKEDIN = https://www.linkedin.com/in/votre-profil`.
- **Compteurs sur l'accueil.** Ce sont les vrais chiffres : envois, fichiers, volume, liens directs. Ils restent cachés tant qu'il y a moins de 20 envois Cloud. La variable `STATS_MIN_TRANSFERS` change ce seuil.
- **Personnaliser ma page.** Un expéditeur à l'adresse confirmée choisit un nom affiché, une couleur, un site web et un logo (PNG, JPEG ou WebP, 300 Ko maximum). Ils apparaissent en haut de ses pages de téléchargement. Les liens signalés ne sont jamais personnalisés.
- **Lien personnel `lestha-send.com/@nom`.**
  - C'est une boîte de dépôt permanente, une seule par adresse confirmée.
  - Le titulaire reçoit un e-mail à chaque dépôt. Depuis un autre appareil, il reprend la gestion en confirmant à nouveau son adresse.
  - Les noms sensibles (admin, lestha, support, banques, opérateurs…) sont réservés.
  - Une boîte reçoit au plus 100 dépôts par jour (variable `HANDLE_DEPOSITS_PER_DAY`).
- **E-mails.** Tous les e-mails (code, lien, alerte, dépôt, signalement) utilisent un modèle clair aux couleurs du logo.
- **Icônes.** L'icône de l'application installée reprend le nouveau logo (avion en papier). Les téléphones peuvent garder l'ancienne icône quelques jours.

## 10. Version 3.8 : vitesse du mode Direct et retours des utilisateurs

### A. Relais TURN Cloudflare (le plus important)
Sans relais, le mode Direct échoue souvent entre deux réseaux mobiles (4G/5G, CGNAT) ou sur un Wi-Fi d'université filtré.
1. Tableau de bord Cloudflare → **Realtime** (ou *Calls*) → **TURN Server** → **Create** (nom : `lestha-send`).
2. Copiez le **Turn Token ID** et l'**API Token** affichés (le jeton n'est montré qu'une fois).
3. Render → votre service → **Environment** → ajoutez :
   - `CF_TURN_KEY_ID` = le Turn Token ID
   - `CF_TURN_API_TOKEN` = l'API Token
   - (facultatif) `CF_TURN_TTL` = `21600` (durée de validité des identifiants, 6 h par défaut)
4. Enregistrez : Render redéploie. Le journal affiche `🔄 TURN : relais Cloudflare (identifiants éphémères)`.

Coût : les 1 000 premiers Go relayés par mois sont gratuits, puis 0,05 $ par Go. Le relais ne sert que
lorsque la connexion directe est impossible ; la console indique la part de transferts qui passent par lui.

### B. Bilan de la semaine par e-mail
Ajoutez `ADMIN_EMAIL` = votre adresse (l'e-mail SendGrid ou SMTP doit déjà fonctionner).
Le bilan part chaque lundi vers 8 h (heure de Dakar). Bouton « Recevoir le bilan maintenant » dans la console.

### C. Liens de provenance
Pour savoir d'où viennent vos visiteurs, ajoutez `?src=` à vos liens publics :
`https://votre-site/?src=tiktok`, `?src=linkedin`, `?src=whatsapp`, `?src=isep`…

### D. Ce qui change
- Mode Direct : nouvelle tentative au bout de 12 s, puis passage automatique par le relais ;
  reprise immédiate quand le réseau change (Wi-Fi ↔ 4G, nouvelle adresse IP) ou quand le flux se bloque 10 s ;
  le destinataire voit le chemin utilisé (même réseau, direct, ou relais).
- Console → onglet **Retours & usage** : visiteurs, fidélité, parcours, usage par mode, provenance, pays,
  qualité du Direct (réussite, vitesse, part du relais), problèmes affichés, questionnaire, messages, idées à voter.
- Site : bouton « Votre avis » et « Proposer une idée » en pied de page ; petite invitation après un envoi
  réussi (au plus une fois tous les 20 jours, jamais au premier envoi).
- Confidentialité : compteurs anonymes et agrégés uniquement ; « Ne pas me suivre » respecté ; page Confidentialité mise à jour.

## 11. Version 3.8.1 : bouton « Recevoir » et code à 6 chiffres
- Menu : « Recevoir » à côté de « Envoyer ». Le destinataire tape le code affiché chez l'expéditeur (ou colle un lien).
- Mode Direct : le code reste valable tant que le lien direct est actif ; l'expéditeur doit **accepter** chaque appareil qui le saisit.
- Mode Cloud : le code est valable 24 h au plus (le lien, lui, garde sa durée normale) ; le PIN éventuel reste demandé.
- Protections : 15 essais par connexion toutes les 10 minutes, pause générale après 400 échecs en 10 minutes.
- Aucune variable à ajouter.

## 12. Version 3.9 : Réunions audio et vidéo
- Menu **Réunion** : sujet, prénom, format **Audio** ou **Vidéo**, puis « Lancer la réunion ». Bouton **Réunion d'urgence** : réunion audio immédiate + partage WhatsApp.
- Inviter : lien `/reunion/…`, code à 6 chiffres (à taper dans « Recevoir »), QR code, WhatsApp, SMS, e-mail.
- Pendant la réunion : micro coupé à l'arrivée, lever la main (ordre affiché), qui parle, caméra (format vidéo), présenter son écran (ordinateur).
- Organisateur : couper un micro / tous les micros, baisser une main, retirer quelqu'un, verrouiller, terminer pour tous.
- Rien n'est enregistré. Reconnexion automatique si le réseau coupe.

**Sans rien configurer** : moteur direct (jusqu'à 12 personnes en audio, 6 en vidéo).

**Pour aller jusqu'à 50 personnes (Cloudflare Realtime SFU)** :
1. Cloudflare → **Realtime** → **SFU** (Serverless SFU) → **Create** une application (nom : `lestha-send-reunions`).
2. Copiez l'**App ID** et l'**App Secret / API token**.
3. Render → Environment : `CF_SFU_APP_ID` et `CF_SFU_APP_TOKEN` (facultatif : `MEET_MAX` = 50).
4. Après le déploiement, faites un essai à 3 téléphones. En cas de souci, `MEET_ENGINE` = `mesh` revient au moteur direct sans rien perdre.

## 13. Version 3.9.1 : services activables depuis la console
- Console → **Système** → « Services affichés sur le site » : interrupteurs pour À proximité, Réunion, Direct vidéo et Classe BBB.
- Un service désactivé disparaît du menu, sa page affiche « Service indisponible pour le moment » et ses routes refusent les nouvelles demandes.
- **Classe BBB est désactivée par défaut** (elle demande un serveur BigBlueButton). Réactivez-la d'un clic quand vous en aurez un.
- Aucune variable à ajouter ; le réglage est enregistré dans le stockage et survit aux redéploiements.

## 14. Version 3.9.2 : réunion plein écran, réactions, enregistrement
- Pendant une réunion, le menu et le pied de page disparaissent (téléphone et ordinateur) : la réunion occupe tout l'écran.
- **Réagir** : 10 autocollants (main levée, d'accord, oui, non, bravo, merci, j'aime, rire, surpris, question) qui s'affichent sur la vignette ; **choix de la couleur de peau** (du jaune au noir), gardé d'une réunion à l'autre et appliqué aussi à la main levée.
- **Enregistrer** (organisateur seulement) : réunion audio → fichier audio ; réunion vidéo ou partage d'écran → vidéo 1280×720 avec les vignettes et les noms. Tous les participants voient « Enregistrement » en direct. Le fichier est téléchargé sur l'appareil de l'organisateur (rien n'est gardé sur le serveur). Conseil : enregistrer depuis un ordinateur (Chrome ou Edge).
- Grille compacte automatique au-delà de 6 puis de 15 participants.
- **Capacité** : 12 en audio / 6 en vidéo sans configuration ; **50 avec Cloudflare Realtime SFU** (voir section 12).

## 15. Version 3.9.3 : enregistrement MP3 et Direct simplifié
- **Enregistrer** propose maintenant le format : **MP3 128 kbit/s** (recommandé pour les cours, ~1 Mo/min), MP3 64 kbit/s (voix, WhatsApp), MP3 192 kbit/s, ou Vidéo (WebM) quand il y a des caméras ou un partage d'écran. Le MP3 est encodé pendant la réunion (encodeur LAME, licence LGPL : `public/vendor/LAME-LICENSE.txt`). Un limiteur évite la saturation quand plusieurs personnes parlent.
- **Direct** : la « Classe virtuelle » (doublon de Réunion) est masquée par défaut ; un encadré renvoie vers **Réunion**. Les anciennes classes virtuelles restent accessibles par leur lien. Pour la réafficher : Console → Système → « Classe virtuelle dans Direct ».

## 16. Version 3.10 : Réunion devient aussi la classe en ligne
- À la création : **Usage** Réunion ou **Cours**, **Format** Audio ou Vidéo, options **Discussion écrite** et **Salle d'attente**.
- **Mode Cours** : l'enseignant au centre de l'écran (sa vidéo en grand en format vidéo, bouton plein écran) ; les micros des apprenants sont verrouillés, ils lèvent la main et l'enseignant **donne la parole** puis la reprend.
- **Discussion écrite**, **sondages** (2 à 6 réponses, résultats en direct), **salle d'attente** (admettre / refuser / tout admettre), **co-animateur**, **liste de présence** (Excel : arrivée, départ, durée, connexions).
- Enregistrement MP3 / vidéo, réactions et couleur de peau : inchangés.
- **Direct** : le sous-menu « Classe virtuelle » est supprimé (restent le lien YouTube / Facebook et le flux pro). Les anciens liens de classe virtuelle affichent « Cette classe a été remplacée » avec un bouton vers Réunion.

## 17. Version 3.10.1 : boutons qui s'inversent, voix visible, épingler

- **Verrouiller ↔ Déverrouiller**, **Fermer ↔ Ouvrir la discussion**, **Salle d'attente ↔ Sans salle d'attente** : le panneau Participants se met à jour aussitôt après chaque appui.
- **Qui parle ?** La vignette de chaque participant qui parle s'illumine, son avatar pulse et trois petites barres animées apparaissent, exactement comme pour l'organisateur.
- **Épingler** : survolez une vignette (ou touchez-la sur téléphone) et appuyez sur 📌 pour l'afficher en grand. Seul votre écran change. Appuyez de nouveau sur 📌 pour la détacher.
- Rien à configurer : aucune nouvelle variable d'environnement.

## 18. Version 3.10.2 : lien de réunion durable

- À la création, **Validité du lien** : 24 heures (par défaut), 7 jours, 30 jours, ou « Seulement pour cette réunion » (ancien fonctionnement).
- Pendant toute cette durée, **le même lien et le même code à 6 chiffres** resservent : après « Quitter », après « Terminer pour tous », quand tout le monde est parti, et même après un redémarrage du serveur Render.
- L'organisateur garde ses droits sur le même appareil (bouton « Reprendre la réunion »).
- **Mes réunions** (page Réunion) : la liste des liens encore valables créés sur cet appareil, avec Ouvrir, Copier et Retirer.
- **Supprimer le lien** (panneau Participants, organisateur) : arrête la réunion et rend le lien inutilisable tout de suite.
- Correction : « Rejoindre à nouveau » ne faisait rien (même adresse) ; il rouvre maintenant la réunion.
- Stockage : une petite fiche par réunion dans `meets/` (sujet, réglages, empreinte de la clé organisateur, code, date d'expiration). Ni voix, ni discussion, ni liste de participants. Les fiches expirées sont effacées automatiquement (vérification toutes les heures).
- Rien à configurer : aucune nouvelle variable d'environnement.

## 19. Version 3.10.3 : présentation à faible délai, statistiques des réunions

**Présentation d'écran plus réactive**
- La voix passe toujours en premier (priorité haute).
- L'écran partagé est envoyé à 15 images/s (au lieu de 10), en 1080p au maximum, et son débit est **plafonné et partagé entre les participants** : en mode direct, l'organisateur envoie une copie à chacun ; sans plafond, la connexion se saturait et le retard grandissait. Au-delà de 6 participants, la présentation passe en 720p pour rester fluide.
- Pendant une présentation, les caméras baissent leur débit pour laisser la place à l'écran.
- Côté spectateurs, chaque image de la présentation est affichée dès son arrivée.
- Le délai mesuré s'affiche sur la présentation (⚡ 120 ms, vert / orange / rouge).
- Mesure en laboratoire (même machine, 3 élèves) : 126 ms au lieu de 189 ms. Sur un vrai réseau 4G chargé, le gain est bien plus grand.
- Pour un cours à plus de 6 élèves, le plus efficace reste le serveur de réunion Cloudflare Realtime (`CF_SFU_APP_ID` et `CF_SFU_APP_TOKEN`) : l'enseignant n'envoie alors son écran qu'une seule fois.

**Console admin → Retours & usage → « Réunions, cours et direct vidéo »**
- Réunions créées (réunions, cours, urgentes, audio, vidéo), participations, séances, record de personnes ensemble.
- Temps de réunion et temps cumulé des participants, présentations, enregistrements.
- Délai moyen des présentations mesuré chez les spectateurs, images/s, part au-delà de 0,7 s.
- Validité choisie pour les liens ; Direct vidéo créés (YouTube/Facebook ou flux pro) et spectateurs.
- Graphique par jour, et réunions en cours en ce moment. Les mêmes chiffres figurent dans le bilan hebdomadaire par e-mail.
- Compté par le serveur : aucun nom, aucun sujet, aucune adresse IP.
