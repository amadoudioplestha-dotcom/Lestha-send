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
   - Nom : `Origine Lestha Send`
   - Si : *All incoming requests* (ou `Hostname equals lestha-send.com`)
   - Action : **Set static**, en-tête `X-Origin-Secret`, valeur : votre secret
   - Déployez la règle.
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
