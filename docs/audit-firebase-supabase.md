# Audit préalable — Migration Firebase/Firestore vers Supabase

Date d'audit : 2026-08-12

## Décision de périmètre

Cet audit ne modifie pas le code applicatif existant et ne touche pas aux données Firebase/Firestore de production. Le dépôt audité contient une application web statique utilisant Firebase côté frontend. La migration Supabase ne doit pas démarrer avant validation explicite de ce rapport.

## Architecture actuelle

- Application HTML/CSS/JavaScript statique, sans `package.json`, sans bundler et sans framework frontend.
- Pages HTML : `login.html`, `index.html`, `page2.html`, `page3.html`, `purchase-detail.html`, `historiques.html`, `users.html`, `materiels.html`.
- Styles : `css/login.css`, `css/style.css`.
- Scripts principaux : `js/firebase-core.js`, `js/login.js`, `js/storage.js`, `js/app.js`, `js/materiels.js`, `js/maintenance-banner.js`, `js/ui.js`, `js/config.js`, `js/automatic-unit.js`, `js/detail-status.js`, `js/message-variables.js`.
- Assets : dossier `Icon/` avec les icônes de navigation, actions, Google, sites, OUT, articles, historique, achats et filtres.
- Service worker : `sw.js`.
- Tests présents : `tests/automatic-unit.test.mjs`, `tests/detail-status.test.mjs`.

## Configuration Firebase détectée

Le projet initialise Firebase depuis le frontend avec :

- Firebase App
- Firebase Analytics
- Firebase Authentication
- Cloud Firestore

Projet Firebase détecté : `base-737bf`.

Fichier principal : `js/firebase-core.js`.

> Point de sécurité : la configuration Firebase frontend contient une clé API publique Firebase. Pour Supabase, il faudra n'utiliser côté frontend que la clé publique `anon`, jamais la clé `service_role`.

## Pages existantes et rôle fonctionnel

| Page | Fonction |
| --- | --- |
| `login.html` | Connexion email/mot de passe et Google. |
| `index.html` | Page 1 : liste des sites, menu, import/export, accès pages admin/historique/matériel. |
| `page2.html` | Page 2 : liste des OUT d'un site, filtres, achats matériel, export. |
| `page3.html` | Page 3 : articles/détails d'un OUT, quantités, statuts, export. |
| `purchase-detail.html` | Détail/édition d'un achat matériel. |
| `users.html` | Gestion admin : utilisateurs, rôles, maintenance, messages administrateur. |
| `historiques.html` | Consultation des historiques. |
| `materiels.html` | Demandes d'achat/de matériel et panier local. |

## Dépendances externes

### Firebase CDN

Version utilisée : `10.12.5` via `https://www.gstatic.com/firebasejs/10.12.5/...`.

Modules détectés :

- `firebase-app.js`
- `firebase-analytics.js`
- `firebase-auth.js`
- `firebase-firestore.js`

### Cloudinary

Les photos d'achats matériel sont envoyées vers Cloudinary via endpoint `https://api.cloudinary.com/v1_1/{cloudName}/image/upload`. La configuration est récupérée depuis `window.CLOUDINARY_UPLOAD_PRESET` / `window.CLOUDINARY_CLOUD_NAME` ou depuis des attributs `data-cloudinary-*` du formulaire.

Élément à conserver externe sauf décision contraire : Cloudinary peut rester externe pour les images. Alternative Supabase possible : Supabase Storage, mais cela nécessite une stratégie de migration d'URL et de droits d'accès.

### APIs navigateur

- `localStorage`
- `sessionStorage`
- Service Worker
- API DOM/HTML statique

## Fonctions Firebase utilisées

### Authentication

- `getAuth`
- `GoogleAuthProvider`
- `browserLocalPersistence`
- `setPersistence`
- `signInWithEmailAndPassword`
- `signInWithPopup`
- `fetchSignInMethodsForEmail`
- `getAdditionalUserInfo`
- `onAuthStateChanged`
- `signOut`

Fonctionnalités dépendantes : connexion Google, connexion email/mot de passe, persistance locale, redirections login/home, affichage du profil, contrôle de menus selon rôle.

### Firestore

- `getFirestore`
- `collection`
- `doc`
- `getDoc`
- `getDocs`
- `addDoc`
- `setDoc`
- `updateDoc`
- `deleteDoc`
- `deleteField`
- `serverTimestamp`
- `Timestamp`
- `query`
- `orderBy`
- `limit`
- `onSnapshot`
- `arrayUnion`

Fonctions explicitement demandées mais non détectées dans le code actuel :

- `where()` : non détecté.
- `startAfter()` : non détecté.

## Fonctions temps réel `onSnapshot()`

Le temps réel est utilisé pour :

1. Profil utilisateur courant : document `users/{uid}`.
2. Maintenance globale : document `appSettings/maintenance`.
3. Messages administrateur récents : collection `adminMessages`, triée par `createdAt desc`, limitée aux messages récents.
4. Liste utilisateurs admin : collection `users`.
5. Points OUT par utilisateur : collection `pages/page2/items`.
6. Données chargées par `StorageService` : sites, items, détails et historiques sont exposés à l'UI via un cache en mémoire et des listeners applicatifs ; Firestore est lu initialement puis l'application notifie ses abonnés internes.
7. Historique : collection `historiques`, triée par `createdAt desc`.
8. État maintenance / utilisateurs / statistiques admin via fonctions `StorageService.subscribe*`.

## Collections et documents Firestore identifiés

### `users/{userId}`

Champs observés :

- `uid`
- `username`
- `displayName`
- `email`
- `name`
- `photoURL`
- `avatarUrl`
- `avatar`
- `role`
- `status`
- `approved`
- `pending`
- `maintenanceAuthorized`
- `maintenanceAccess`
- `createdAt`
- `updatedAt`
- `lastLoginAt`
- `lastActivity`
- `lastNameChange`
- `readMessages`

Sous-collection : `users/{userId}/outDeletionLimits/{yyyy-mm-dd}` avec :

- `date`
- `count`
- `updatedAt`

### `appSettings/maintenance`

Champs observés :

- `enabled`
- `updatedAt`
- possibles métadonnées de maintenance selon l'UI.

### `pages/page1/items/{siteId}` — sites

Champs observés :

- `nom`
- `ownerId`
- `createdBy`
- `createdByName`
- `dateCreation`
- `dateModification`
- `passwordHash`
- `locked`
- `unlockProtections`
- `inactiveSince`
- `inactivityDecisionPending`
- `inactivityDecisionPendingAt`
- `inactivityRestoredAt`

Relation : un site possède plusieurs OUT dans `pages/page2/items` via `siteId`.

### `pages/page2/items/{itemId}` — OUT

Champs observés :

- `siteId`
- `numero`
- `magasin`
- `ownerId`
- `createdBy`
- `createdByName`
- `dateCreation`
- `dateModification`

Relation : un OUT appartient à un site via `siteId` et possède plusieurs articles dans `pages/page3/items` via `itemId`.

### `pages/page3/items/{detailId}` — articles/détails OUT

Champs observés :

- `siteId`
- `itemId`
- `champ`
- `code`
- `designation`
- `qteSortie`
- `unite`
- `qteHorsBtrs`
- `qteRetour`
- `dateRetour`
- `qtePosee`
- `qteRebus`
- `observation`
- `statut`
- `ownerId`
- `createdBy`
- `dateCreation`
- `dateModification`

Relation critique à préserver : `page3.itemId` doit référencer `page2.id`.

### `historiques/{historyId}`

Champs observés :

- `userId`
- `userName`
- `action`
- `siteId`
- `siteName`
- `createdAt`

### `adminMessages/{messageId}`

Champs observés :

- `recipientId`
- `recipientName`
- `recipientEmail`
- `title`
- `body`
- `createdAt`
- variables de message côté UI : `{Nom}`, `{Mail}`, `{Role}`, etc.

Lecture côté utilisateur filtrée applicativement : le code charge les messages récents puis choisit ceux destinés à l'utilisateur courant. À renforcer côté Supabase/RLS.

### `materialRequests/{requestId}`

Champs observés :

- `requestTitle`
- `createdAt`
- `items[]` avec `code`, `designation`, `qty`, `unit`.

### `sites/{siteId}/achatsMateriels/{purchaseId}`

Champs observés :

- `designation`
- `quantite`
- `magasin`
- `remark` / remarques éventuelles
- `photoUrl` / données image Cloudinary
- `createdAt`
- `updatedAt`
- `createdBy`
- `createdByName`
- `createdByEmail`
- autres champs d'édition d'achat selon formulaire.

## Relations de données actuelles

- `users.id` correspond au `uid` Firebase Auth.
- `pages/page1/items.id` est l'identifiant site.
- `pages/page2/items.siteId` référence `pages/page1/items.id`.
- `pages/page3/items.siteId` référence `pages/page1/items.id`.
- `pages/page3/items.itemId` référence `pages/page2/items.id`.
- `historiques.siteId` référence un site quand applicable.
- `historiques.userId` référence un utilisateur quand applicable.
- `adminMessages.recipientId` référence un utilisateur.
- `users/{userId}/outDeletionLimits/{date}` limite les suppressions OUT par utilisateur et par jour.
- `sites/{siteId}/achatsMateriels` est actuellement séparé de `pages/page2/items`, mais lié au site par chemin Firestore.

## Permissions et rôles

Rôles détectés/normalisés :

- `admin` / `Admin`
- `standard`, `adjoint`, `adjoint admin`, `Adjoint Admin`, `full` → rôle fonctionnel standard/adjoint admin.
- `limite`, `limité`, `Limité`, `limited`, `ecriture`, `écriture` → rôle limité.
- `lecture` existe comme valeur possible mais ne semble pas être un rôle principal demandé.

Particularités :

- L'email `andrainaaina@gmail.com` est traité comme administrateur primaire.
- Certains écrans considèrent `standard` / `Adjoint Admin` comme ayant des droits proches admin.
- `users.html` contient une logique où l'administrateur primaire ne peut pas être supprimé et où les rôles visibles sont surtout `Adjoint Admin` et `Limité`.
- Les onglets achats et certaines actions de suppression/édition sont réservés admin.
- Les sites peuvent être supprimés par admin/adjoint ou par leur créateur selon logique applicative.
- Les suppressions OUT peuvent être limitées à 2 par jour via `outDeletionLimits`.
- Le blocage par utilisateur/site est actuellement stocké dans `unlockProtections` sur le document site ou en localStorage si aucun utilisateur authentifié n'est disponible.

Risque majeur : les permissions semblent majoritairement appliquées côté frontend. La version Supabase devra traduire ces droits en RLS et/ou fonctions RPC/serveur pour éviter les contournements.

## Stockage d'images

- Les photos d'achats utilisent Cloudinary.
- Aucun usage direct de Firebase Storage SDK n'a été détecté malgré la présence d'un `storageBucket` dans la config Firebase.
- Migration recommandée : conserver les URL Cloudinary existantes dans Supabase dans un premier temps ; migrer vers Supabase Storage uniquement dans une phase ultérieure validée.

## Données localStorage / sessionStorage identifiées

### localStorage

- `suiviMateriel.offlineCache.v1` : cache offline des pages 1/2/3.
- `suiviMateriel.authUser.v1` : copie du profil auth Firebase après connexion.
- `suiviMateriel.loginMemo.v1` : mémo email/mot de passe encodé base64 côté navigateur. Risque sécurité élevé ; à supprimer ou remplacer dans la migration.
- `suiviMateriel.exportFileNames.v1` : historique des noms de fichiers export.
- `site-detail:item-date-filter:{siteId}` : filtre date des OUT.
- `site-detail:item-search:{siteId}` : recherche OUT par site.
- `page2_search_value` : recherche Page 2 conservée.
- `page2_search_read_ids` : OUT déjà lus dans une recherche.
- `page2_cursor_filter_read_outs` : OUT déjà lus avec filtre curseur/statut.
- `page2_cursor_filter_active` : libellé filtre actif.
- `outPageScrollY` : scroll Page 2.
- `purchaseStoreSuggestions` : suggestions de magasins pour achats.
- `siteDetailActiveTab:{siteId}` : onglet actif OUT/achats.
- `materialRequestCart` : panier demande matériel.
- `materialsHintSeen` : aide matériel déjà vue.
- `lastMaterialRequestTitle` : dernier titre de demande matériel.
- `adminMessageDraft` : brouillon message admin.
- `adminMessageRecipients` : brouillon destinataires message admin.
- Clés de protection locale site : préfixe calculé pour les tentatives de déverrouillage si utilisateur non authentifié.
- Le code contient un `localStorage.clear()` qui peut effacer toutes les clés locales lors d'une action de déconnexion/nettoyage.

### sessionStorage

- `suiviMateriel.googleWelcome.v1` : payload d'accueil après connexion Google.
- `albumAppHasLoadedOnce` : état UI de chargement.

## Règles de sécurité actuelles

Aucun fichier de règles Firestore (`firestore.rules`, `storage.rules`) n'est présent dans ce dépôt. Les règles réellement appliquées au projet Firebase ne peuvent donc pas être auditées depuis le code fourni.

Action obligatoire avant migration réelle : exporter/consulter les règles Firestore de production et les comparer avec les permissions applicatives détectées.

## Vérification du fichier d'export `Exporter.2026-08-11_07-18-15.su`

Statut : fichier non présent dans le dépôt audité au moment de l'audit.

Conséquences :

- Impossible de vérifier les 7 sites Page 1.
- Impossible de vérifier les 225 OUT Page 2.
- Impossible de vérifier les 856 articles Page 3.
- Impossible de valider `Page 3.itemId` → `Page 2.id`.
- Impossible de détecter précisément les IDs orphelins, `siteId` manquants, `itemId` invalides, créateurs, dates, quantités et statuts incohérents.

Aucune migration de données ne doit commencer tant que ce fichier n'est pas ajouté au dépôt ou fourni séparément pour analyse.

## Structure Supabase proposée — à valider, ne pas créer automatiquement

### `users`

- `id uuid primary key` — aligné avec `auth.users.id`.
- `email text unique`
- `username text`
- `display_name text`
- `photo_url text`
- `role text check in ('admin','adjoint_admin','standard','limite')`
- `maintenance_authorized boolean default false`
- `last_login_at timestamptz`
- `last_activity_at timestamptz`
- `last_name_change_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

### `sites`

- `id uuid primary key`
- `nom text not null`
- `created_by uuid references users(id)`
- `created_by_name text`
- `password_hash text`
- `locked boolean default false`
- `inactive_since timestamptz`
- `inactivity_decision_pending boolean default false`
- `inactivity_decision_pending_at timestamptz`
- `inactivity_restored_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

### `site_unlock_protections`

- `id uuid primary key`
- `site_id uuid references sites(id) on delete cascade`
- `user_id uuid references users(id) on delete cascade`
- `attempts_remaining int default 3`
- `blocked_until timestamptz`
- `has_attempted boolean default false`
- Unique `(site_id, user_id)`.

### `outs`

- `id uuid primary key`
- `site_id uuid references sites(id) on delete cascade`
- `numero text not null`
- `magasin text`
- `created_by uuid references users(id)`
- `created_by_name text`
- `created_at timestamptz`
- `updated_at timestamptz`
- Unique recommandé `(site_id, numero)`.

### `out_articles`

- `id uuid primary key`
- `site_id uuid references sites(id) on delete cascade`
- `out_id uuid references outs(id) on delete cascade`
- `champ int`
- `code text`
- `designation text not null`
- `qte_sortie numeric`
- `unite text`
- `qte_hors_btrs numeric`
- `qte_retour numeric`
- `date_retour date`
- `qte_posee numeric`
- `qte_rebus numeric`
- `observation text`
- `statut text`
- `created_by uuid references users(id)`
- `created_at timestamptz`
- `updated_at timestamptz`

### `historiques`

- `id uuid primary key`
- `user_id uuid references users(id)`
- `user_name text`
- `action text not null`
- `site_id uuid references sites(id)`
- `site_name text`
- `created_at timestamptz`

### `messages`

- `id uuid primary key`
- `title text not null`
- `body text not null`
- `created_by uuid references users(id)`
- `created_at timestamptz`

### `message_recipients`

- `id uuid primary key`
- `message_id uuid references messages(id) on delete cascade`
- `recipient_id uuid references users(id) on delete cascade`
- `read_at timestamptz`
- Unique `(message_id, recipient_id)`.

### `achats`

- `id uuid primary key`
- `site_id uuid references sites(id) on delete cascade`
- `designation text not null`
- `quantite numeric`
- `magasin text`
- `remark text`
- `photo_url text`
- `photo_provider text default 'cloudinary'`
- `created_by uuid references users(id)`
- `created_by_name text`
- `created_by_email text`
- `created_at timestamptz`
- `updated_at timestamptz`

### `app_settings`

- `key text primary key`
- `value jsonb not null`
- `updated_by uuid references users(id)`
- `updated_at timestamptz`

### Tables complémentaires recommandées

- `material_requests`
- `material_request_items`
- `out_deletion_limits`

## Éléments à migrer vers Supabase

- Authentification Google et email/mot de passe vers Supabase Auth.
- Profils utilisateurs et rôles vers table `users` liée à `auth.users`.
- Sites Page 1 vers `sites`.
- OUT Page 2 vers `outs`.
- Articles Page 3 vers `out_articles`.
- Historiques vers `historiques`.
- Messages admin vers `messages` + `message_recipients`.
- Achats matériel vers `achats`.
- Maintenance vers `app_settings`.
- Limites suppression OUT vers `out_deletion_limits`.
- Protections déverrouillage site vers `site_unlock_protections`.

## Éléments à garder externes provisoirement

- Cloudinary pour les images déjà existantes.
- Icônes locales du dépôt.
- Préférences purement UI dans localStorage/sessionStorage, sauf celles sensibles.

## Risques de migration

1. Permissions frontend insuffisantes : la version Supabase doit utiliser RLS/RPC.
2. Risque sur les rôles : `standard`, `Adjoint Admin`, `adjoint`, `full` sont synonymes dans le code et doivent être normalisés sans perte fonctionnelle.
3. Risque sur les IDs : les documents Firestore ont des IDs string ; Supabase peut utiliser UUID ou conserver les IDs d'origine en `legacy_id`.
4. Risque d'orphelins : `page3.itemId` doit référencer `page2.id`; impossible à valider sans fichier export.
5. Risque d'images : URLs Cloudinary à conserver ou migrer explicitement.
6. Risque localStorage : stockage actuel du mot de passe encodé base64 à retirer.
7. Risque temps réel : Supabase Realtime doit remplacer les besoins `onSnapshot` sans charger trop largement les données.
8. Risque messages : le filtrage destinataire doit passer côté base/RLS, pas seulement côté UI.
9. Risque achats : collection Firestore imbriquée `sites/{siteId}/achatsMateriels` à aplatir proprement.
10. Risque règles Firebase inconnues : règles de production absentes du dépôt.

## Plan de migration proposé par étapes

1. Valider cet audit et fournir le fichier `Exporter.2026-08-11_07-18-15.su`.
2. Analyser l'export hors import direct : compter pages, valider IDs, détecter orphelins et incohérences.
3. Créer un schéma SQL Supabase en brouillon, sans l'appliquer à la production.
4. Définir RLS pour chaque table et scénarios de rôle.
5. Créer une branche/version de test Supabase indépendante.
6. Ajouter variables publiques Supabase frontend sans secret.
7. Implémenter un service de données Supabase parallèle à `StorageService`.
8. Migrer auth sur environnement test.
9. Migrer lecture seule Page 1/2/3 depuis données importées de test.
10. Migrer écritures CRUD avec historiques.
11. Migrer temps réel, messages, maintenance et achats.
12. Comparer exports Firebase vs Supabase avant validation finale.
13. Basculer uniquement après validation complète, sans supprimer Firebase.

## Fichiers qui devront être modifiés lors de la migration validée

- `js/firebase-core.js` : remplacé ou doublé par un client Supabase public.
- `js/login.js` : migration Auth Firebase vers Supabase Auth.
- `js/storage.js` : couche de données principale Firestore à remplacer progressivement.
- `js/app.js` : appels Firestore directs achats + auth state + permissions.
- `js/maintenance-banner.js` : realtime maintenance/messages/utilisateur.
- `js/materiels.js` : `materialRequests` et lecture articles.
- `users.html` : appels Firestore directs users/adminMessages.
- Pages HTML si ajout de scripts Supabase ou variables d'environnement.
- Tests à étendre pour mapping Firebase → Supabase et logique rôles/statuts.

## Validation requise avant toute migration

Avant d'écrire du code de migration, il faut valider :

- la structure cible Supabase ;
- la stratégie de conservation ou conversion des IDs ;
- les règles RLS ;
- le traitement de Cloudinary ;
- la suppression du stockage local du mot de passe ;
- l'analyse réelle du fichier `.su`.
