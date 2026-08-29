# Firebase → Supabase Mapping Contract

Statut : contrat officiel de migration. Toute implémentation de migration doit respecter ce document. Une valeur source explicitement présente ne peut être abandonnée implicitement.

## 1. Scope

Ce contrat couvre les données Firebase/Firestore suivantes : `users`, `pages/page1/items`, `pages/page2/items`, `pages/page3/items`, les retours d'articles, `materialCodes`, `sites/{siteId}/achatsMateriels`, `materialRequests`, `adminMessages`, `historiques`, `trash`, `appSettings`, `users/{uid}/outDeletionLimits` et `sites.unlockProtections`.

Les cibles sont les 17 tables publiques : `profiles`, `app_settings`, `material_codes`, `sites`, `site_unlock_protections`, `outs`, `articles`, `article_returns`, `purchases`, `history_events`, `trash_entries`, `out_deletion_limits`, `material_requests`, `material_request_items`, `admin_messages`, `message_recipients` et `message_reads`.

Ce contrat ne lance aucun import, ne modifie ni Firebase ni Supabase distant, ne définit pas les politiques RLS et ne corrige pas le droit `PUBLIC EXECUTE`.

## 2. Firebase Inventory

| Source Firebase | Grain | Cible Supabase |
| --- | --- | --- |
| `users/{documentId}` | un profil | `profiles` |
| `pages/page1/items/{siteId}` | un site | `sites` |
| `site.unlockProtections.{uid}` | une protection profil/site | `site_unlock_protections` |
| `pages/page2/items/{outId}` | un OUT | `outs` |
| `pages/page3/items/{articleId}` | un article | `articles` |
| `article.returns[]` | un retour | `article_returns` |
| `materialCodes/{codeId}` | un code matériel | `material_codes` |
| `sites/{siteId}/achatsMateriels/{purchaseId}` | un achat | `purchases` |
| `materialRequests/{requestId}` | une demande | `material_requests` |
| `materialRequest.items[]` | une ligne ordonnée | `material_request_items` |
| `adminMessages/{messageId}` | un message | `admin_messages` |
| `recipientId`, `recipientIds[]` | un destinataire | `message_recipients` |
| `users/{uid}.readMessages[]` | une lecture | `message_reads` |
| `historiques/{historyId}` | un événement | `history_events` |
| `trash/{trashId}` | une entrée de corbeille | `trash_entries` |
| `appSettings/{key}` | un réglage | `app_settings` |
| `users/{uid}/outDeletionLimits/{date}` | un compteur journalier | `out_deletion_limits` |

## 3. Identity Strategy

`profiles.id` est l'UUID Supabase correspondant à `auth.users.id`. `profiles.firebase_id` conserve exactement l'identifiant du document Firestore et `profiles.firebase_uid` conserve exactement le Firebase Auth UID. Ils ne sont pas interchangeables et doivent être tous deux importés quand ils sont disponibles.

Pour toute valeur Firebase représentant `sites.unlockedBy` ou `purchases.updatedBy`, résoudre le profil dans cet ordre strict :

1. correspondance exacte avec `profiles.firebase_uid` ;
2. correspondance exacte avec `profiles.firebase_id` ;
3. correspondance email `CITEXT` **UNIQUE**.

Si une seule correspondance est trouvée, utiliser `profiles.id`. Si aucune correspondance n'est trouvée, classer `ORPHAN_PROFILE_REFERENCE` et **BLOCK** pour la migration réelle. Si plusieurs correspondances sont trouvées, classer `AMBIGUOUS_PROFILE_REFERENCE` et **BLOCK**.

Il est interdit de deviner, d'utiliser le nom, de créer automatiquement un UUID ou de transformer silencieusement la relation en `NULL`.

Pour les autres acteurs (`ownerId`, `createdBy`, `lockedBy`, `updatedBy`, `userId`, `deletedBy`, `requesterId`), la résolution documentée dans les sections concernées est appliquée ; aucune valeur relationnelle source présente ne peut être perdue.

## 4. Profiles

Source : `users/{documentId}`. Cible : `profiles`.

| Firebase | Supabase | Règle |
| --- | --- | --- |
| document ID | `firebase_id` | texte exact |
| `uid` | `firebase_uid` | texte exact |
| compte Auth apparié | `id` | UUID `auth.users.id` |
| `email` | `email` | `CITEXT`, sans modification sémantique |
| `username` | `username` | `CITEXT` |
| `displayName` | `display_name` | texte |
| `name` | `name` | texte |
| `photoURL`, `avatarUrl`, `avatar` | `avatar_url` | priorité section 18 |
| `role` | `role`, `legacy_role` | normaliser et conserver l'original |
| `status`, `approved`, `pending` | `legacy_status`, `legacy_approved`, `legacy_pending` | conservation |
| `presence`, `online` | colonnes homonymes | conservation |
| `lastSeenAt`, `lastSeen` | `last_seen_at` | priorité section 18 |
| `maintenanceAuthorized` | `maintenance_authorized` | booléen |
| `maintenanceAccess` | `maintenance_access` | booléen |
| `createdAt`, `updatedAt` | `created_at`, `updated_at` | timestamp |
| `lastLoginAt`, `lastActivity` | `last_login_at`, `last_activity_at` | timestamp |
| `lastNameChange` | `username_changed_at` | timestamp |

Rôles : `admin` → `admin`; `standard`, `adjoint`, `adjoint admin`, `Adjoint Admin`, `full` → `deputy_admin`; `limite`, `limité`, `Limité`, `limited`, `ecriture`, `écriture` → `limited`; `lecture` → `read_only`. Une valeur inconnue exige `HUMAN_REVIEW` et ne doit pas recevoir silencieusement un rôle.

## 5. Sites

Source : `pages/page1/items/{siteId}`. Cible : `sites`.

Document ID → `firebase_id`; `nom`/`name` → `name`; `ownerId` → `owner_id`; `createdBy` → `created_by`; `outCount` → `out_count_legacy`; `createdByName` → `created_by_name_snapshot`; `createdByEmail` → `created_by_email_snapshot`; `locked` → `is_locked`; `passwordHash` → `password_hash_legacy`; `lockedAt` → `locked_at`; `lockedBy` → `locked_by`; `lockedByName` → `locked_by_name_snapshot`; `unlockedBy` → `unlocked_by`; `unlockedByName` → `unlocked_by_name_snapshot`; `unlockAttemptsRemaining` → `unlock_attempts_remaining`; `unlockBlockedUntil` → `unlock_blocked_until`; les champs d'inactivité → leurs colonnes `snake_case`; dates de création/modification → `created_at`/`updated_at`; timestamp d'import → `imported_at`.

La résolution de `unlockedBy` suit obligatoirement la section 3. Les relations site explicites non résolues sont bloquantes.

## 6. Site Unlock Protections

Chaque entrée Firebase `site.unlockProtections` doit produire une ligne `site_unlock_protections` avec `site_id`, `profile_id`, `attempts_remaining` et `blocked_until`.

Résolution obligatoire :

- Firebase `siteId` → `sites.firebase_id` → `sites.id` ;
- Firebase UID → `profiles.firebase_uid` → `profiles.id`.

Si le site est introuvable : `ORPHAN_UNLOCK_SITE` → **BLOCK**. Si le profil est introuvable : `ORPHAN_UNLOCK_PROFILE` → **BLOCK**. Une collision sur `(site_id, profile_id)` avec des valeurs divergentes est un `CONFLICT_UNLOCK_PROTECTION` → **HUMAN_REVIEW**.

Il est interdit d'ignorer silencieusement l'entrée ou d'utiliser `profile_id NULL`.

## 7. OUT

Source : `pages/page2/items/{itemId}`. Cible : `outs`.

Document ID → `firebase_id`; `siteId` → `site_id` via `sites.firebase_id`; `numero`/`number` → `number`; valeur canonique → `normalized_number`; `magasin`/`store` → `store`; `ownerId` → `owner_id`; `createdBy` → `created_by`; `articleCount` → `article_count_legacy`; snapshots nom/email → colonnes snapshot; dates → `created_at`, `updated_at`, `imported_at`.

Un `siteId` absent alors que requis, ou ne résolvant aucun site, est `ORPHAN_OUT_SITE` → **BLOCK**. L'unicité métier est `(site_id, normalized_number)`.

## 8. Articles

Source : `pages/page3/items/{detailId}`. Cible : `articles`.

Document ID → `firebase_id`; `itemId` → `out_id` via `outs.firebase_id`; `siteId` → `site_id` via `sites.firebase_id`; `champ` → `field`; `code` → `code`; `designation` → `designation`; `qteSortie` → `quantity_out`; `unite` → `unit`; `qteHorsBtrs` → `quantity_outside_btrs`; `qteRetour` → `quantity_returned_legacy`; `dateRetour` → `return_date_legacy`; `qtePosee` → `quantity_installed`; `qteRebus` → `quantity_scrap`; `observation` → `observation`; `statut` → `status`; acteurs, snapshots et dates → colonnes correspondantes.

Un `itemId` introuvable est `ORPHAN_ARTICLE_OUT` → **BLOCK**. Un `siteId` explicite introuvable ou incompatible avec `outs.site_id` est `ARTICLE_SITE_MISMATCH` → **BLOCK**.

## 9. Article Returns

Chaque objet de `article.returns[]` produit une ligne `article_returns`. `id`/`returnId` → `firebase_return_id`; article parent → `article_id`; `quantity`/`qte` → `quantity`; `returnDate`/`dateRetour` → `return_date`; `note`/`observation` → `note`; `createdBy` → `created_by`; `createdAt` → `created_at`; provenance historique → `is_legacy = TRUE`.

Sans identifiant de retour, conserver l'ordre source dans le manifest pour rendre le diagnostic reproductible. Une quantité non positive est `INVALID_RETURN_QUANTITY` → **HUMAN_REVIEW**. Un parent absent est `ORPHAN_ARTICLE_RETURN` → **BLOCK**.

## 10. Material Codes

Source : `materialCodes/{id}`. Cible : `material_codes`. Document ID → `firebase_id`; `code` → `code`; code normalisé → `normalized_code`; `designation` → `designation`; dates → `created_at`/`updated_at`.

Une collision de `normalized_code` avec des désignations incompatibles est `CONFLICT_MATERIAL_CODE` → **HUMAN_REVIEW**, sans écrasement automatique.

## 11. Purchases

Source : `sites/{siteId}/achatsMateriels/{purchaseId}`. Cible : `purchases`.

Document ID → `firebase_id`; site parent → `site_id`; `designation` → `designation`; `quantite`/`quantity` → `quantity`; `unite`/`unit` → `unit`; `magasin`/`store` → `store`; `remark`/`remarque` → `remark`; `photoUrl`/`imageUrl` → `image_url`; `imagePublicId` → `image_public_id`; fournisseur → `image_provider` (Cloudinary conservé); `createdBy` → `created_by`; snapshots créateur/site → colonnes snapshot; `updatedBy` → `updated_by`; `updatedByName` → `updated_by_name_snapshot`; dates → `created_at`/`updated_at`.

`updatedBy` suit obligatoirement la section 3. Un site parent introuvable est `ORPHAN_PURCHASE_SITE` → **BLOCK**. L'identité d'import est `(site_id, firebase_id)`.

## 12. Material Requests

Source parent → `material_requests` : document ID → `firebase_id`; `requestTitle`/`title` → `request_title`; `requesterId` → `requester_id`; `siteId` → `site_id`; `status` → `status`; `remark` → `remark`; dates → `created_at`/`updated_at`.

Chaque `items[]` produit une ligne `material_request_items` : parent → `request_id`; indice source → `position`; `code`, `designation`, `qty`/`quantity`, `unit`/`unite` → colonnes correspondantes. Ne pas dédupliquer ni réordonner les lignes. Une relation explicite requester/site introuvable suit la règle globale des FK.

## 13. Admin Messages

`adminMessages/{messageId}` → `admin_messages` : document ID → `firebase_id`; `title`, `body`, variantes template et mode destinataire → colonnes correspondantes; `createdBy` → `created_by`; `createdAt` → `created_at`.

Pour `recipientId` et chaque valeur de `recipientIds[]`, résoudre le Firebase UID par `profiles.firebase_uid` → `profiles.id`, puis créer `message_recipients(message_id, profile_id)` avec les snapshots disponibles. Les doublons exacts d'un même destinataire sont fusionnés sans perdre leurs snapshots.

Pour `users/{uid}.readMessages[]`, résoudre le UID parent → `profiles.firebase_uid` → `profiles.id`, et chaque message ID → `admin_messages.firebase_id` → `admin_messages.id`, puis créer `message_reads(message_id, profile_id)`.

Si le profil est absent : `ORPHAN_MESSAGE_PROFILE` → **BLOCK**. Si le message est absent : `ORPHAN_MESSAGE_REFERENCE` → **BLOCK**. Ne jamais créer un UUID fictif.

Les anciens `readMessages[]` ne possèdent pas de timestamp. Pour ces lectures uniquement :

- `read_at =` timestamp officiel du run de migration ;
- `is_synthetic_timestamp = TRUE`.

Pour les nouvelles lectures Supabase normales, `is_synthetic_timestamp = FALSE`. Le timestamp de migration doit être unique et fixé dans le manifest du run, jamais recalculé ligne par ligne.

## 14. History

Source : `historiques/{historyId}`. Cible : `history_events`. Document ID → `firebase_id`; `userId`/`actorId` → `actor_id`; nom/email acteur → snapshots; `action` → `action`; `siteId` → `site_id`; `siteName` → `site_name_snapshot`; champs additionnels → `metadata` JSONB; `createdAt` → `created_at`.

Une relation acteur/site explicitement présente et introuvable ne devient pas `NULL` : elle est classée selon la section 21 et soumise à `HUMAN_REVIEW` ou `BLOCK` avant import.

## 15. Trash

Source : `trash/{trashId}`. Cible : `trash_entries`. Document ID → `firebase_id`; type → `entity_type`; ID original → `original_firebase_id`; objet original complet → `payload` JSONB; acteur et snapshots → `deleted_by` et snapshots; `deletedAt`, `expiresAt`, `restoredAt` → colonnes correspondantes.

Le `payload` doit rester lossless. `expires_at < deleted_at` ou `restored_at < deleted_at` est `INVALID_TRASH_TIMELINE` → **HUMAN_REVIEW**.

## 16. App Settings

Chaque `appSettings/{key}` produit `app_settings(key, value, updated_by, updated_at)`. La clé est le document ID exact et le document complet est conservé en JSONB `value`. `updatedBy`, s'il est présent, est résolu vers `profiles.id`; `updatedAt` est converti en timestamp.

`appSettings/maintenance` et `appSettings/trash` sont inclus. Une relation `updatedBy` explicite non résolue ne devient pas silencieusement `NULL`.

## 17. Deletion Limits

Source : `users/{uid}/outDeletionLimits/{yyyy-mm-dd}`. Cible : `out_deletion_limits`. UID parent → `profile_id` via `profiles.firebase_uid`; document ID ou `date` → `limit_date`; `count` → `deletion_count`; `updatedAt` → `updated_at`.

Si l'ID du document et `date` divergent : `CONFLICT_DELETION_LIMIT_DATE` → **HUMAN_REVIEW**. Profil introuvable : `ORPHAN_DELETION_LIMIT_PROFILE` → **BLOCK**. Le compteur ne peut pas être négatif.

## 18. Alias Priority Rules

Les alias sont choisis par première valeur **présente** dans l'ordre indiqué, sans confondre `false`, `0` ou chaîne vide avec une valeur absente :

- profil avatar : `photoURL` → `avatarUrl` → `avatar` ;
- profil nom affiché : `displayName` → `name` → `username` ;
- dernière présence : `lastSeenAt` → `lastSeen` ;
- nom site : `nom` → `name` ;
- numéro OUT : `numero` → `number` ;
- magasin : `magasin` → `store` ;
- quantité : `quantite` → `quantity` → `qty` ;
- unité : `unite` → `unit` ;
- image : `photoUrl` → `imageUrl` ;
- remarque : `remark` → `remarque` → `observation` lorsque la cible l'autorise ;
- destinataires : union ordonnée de `recipientId` puis `recipientIds[]`, dédupliquée par UID exact.

Deux alias simultanément présents avec des valeurs sémantiquement différentes produisent `ALIAS_VALUE_CONFLICT` → **HUMAN_REVIEW** ; la priorité sert à construire le candidat, pas à masquer le conflit.

## 19. Type Conversion Rules

- Firestore `Timestamp`, `{seconds,nanoseconds}`, Date ISO valide → `TIMESTAMPTZ` UTC sans perte de l'instant.
- Date civile `yyyy-mm-dd` → `DATE`, sans conversion de fuseau.
- Entier exact → `INTEGER`; dépassement ou fraction vers entier → `INVALID_INTEGER`.
- Nombre fini → `NUMERIC`; `NaN`/infini/chaîne ambiguë → `INVALID_NUMERIC`.
- Seuls booléens réels, ou alias explicitement inventoriés, → `BOOLEAN`; aucune coercition JavaScript générique.
- Objet/array conservé → JSONB avec structure et ordre des tableaux préservés.
- UUID Supabase uniquement après résolution d'identité/FK; jamais par cast ou UUID aléatoire de remplacement.
- Une valeur invalide produit un diagnostic avec collection, document, champ, valeur brute et code de classification.

## 20. Normalization Rules

La valeur originale reste dans la colonne non normalisée. `normalized_number` est le numéro OUT trimé et normalisé en casse de manière déterministe. `normalized_code` applique la même politique canonique au code matériel. La locale et l'algorithme exacts doivent être inscrits dans le manifest du run.

Les emails utilisent la comparaison `CITEXT`; ils ne servent à l'identité qu'aux endroits explicitement autorisés. Les IDs Firebase, UIDs, mots de passe legacy, URLs, texte libre, snapshots et JSON ne sont ni trimés ni changés silencieusement. Toute normalisation causant une collision produit `NORMALIZATION_COLLISION` → **HUMAN_REVIEW**.

## 21. Foreign Key Mapping

| Relation source | Lookup | FK cible | Absence |
| --- | --- | --- | --- |
| site `ownerId`, `createdBy`, acteurs ordinaires | identité profil documentée | `profiles.id` | `ORPHAN_PROFILE_REFERENCE` |
| `sites.unlockedBy`, `purchases.updatedBy` | UID, Firebase ID, email unique | `profiles.id` | `ORPHAN_PROFILE_REFERENCE` |
| OUT `siteId` | `sites.firebase_id` | `outs.site_id` | `ORPHAN_OUT_SITE` |
| article `itemId` | `outs.firebase_id` | `articles.out_id` | `ORPHAN_ARTICLE_OUT` |
| article `siteId` | `sites.firebase_id` | `articles.site_id` | `ARTICLE_SITE_MISMATCH` |
| achat site parent | `sites.firebase_id` | `purchases.site_id` | `ORPHAN_PURCHASE_SITE` |
| retour parent | `articles.firebase_id` | `article_returns.article_id` | `ORPHAN_ARTICLE_RETURN` |
| limites UID parent | `profiles.firebase_uid` | `out_deletion_limits.profile_id` | `ORPHAN_DELETION_LIMIT_PROFILE` |
| message recipient/read UID | `profiles.firebase_uid` | `profile_id` | `ORPHAN_MESSAGE_PROFILE` |
| read message ID | `admin_messages.firebase_id` | `message_id` | `ORPHAN_MESSAGE_REFERENCE` |
| unlock site/UID | `sites.firebase_id`, `profiles.firebase_uid` | `site_id`, `profile_id` | `ORPHAN_UNLOCK_SITE/PROFILE` |

Règle globale : toute relation Firebase explicitement présente dans la source qui ne peut pas être résolue vers sa FK Supabase doit produire **BLOCK** ou **HUMAN_REVIEW**, selon ce contrat. La conversion silencieuse vers `NULL` est interdite. Une FK nullable dans PostgreSQL ne signifie pas qu'une relation Firebase existante peut être perdue. `NULL` n'est acceptable que lorsque la relation est réellement absente de la source et que le champ cible est nullable.

## 22. Conflict Rules

Les imports sont idempotents sur les clés Firebase/contraintes uniques définies par la cible. Même identité et même contenu → `DUPLICATE_IDENTICAL`, sans seconde insertion. Même identité et contenu divergent → `SOURCE_ID_CONFLICT` → **BLOCK**. Collision de clé métier/normalisée → **HUMAN_REVIEW**. Plusieurs profils candidats → `AMBIGUOUS_PROFILE_REFERENCE` → **BLOCK**.

Aucun dernier-écrivain-gagne, merge heuristique, renommage, incrémentation, UUID fictif ou écrasement automatique n'est permis. Le rapport doit compter chaque classification et identifier les documents concernés.

## 23. Explicitly Dropped Fields

Aucun champ métier inventorié n'est supprimé implicitement. Les compteurs dénormalisés sont conservés dans les colonnes `*_legacy`; les snapshots sont conservés; les champs inconnus des historiques vont dans `metadata`; la corbeille conserve le document dans `payload`; les réglages conservent le document dans `value`.

Seules les valeurs purement UI/locales (cache, scroll, recherche, brouillons, état d'aide, service worker), les secrets/mots de passe de mémorisation navigateur et les métadonnées techniques de l'outil d'export hors document sont hors import. Cloudinary reste externe mais ses URLs, public IDs et fournisseur sont conservés. Toute proposition supplémentaire de suppression exige **HUMAN_REVIEW** et modification de ce contrat.

## 24. Dry-run Contract

Le dry-run doit être strictement sans écriture Firebase/Supabase. Il doit fixer dans son manifest : identifiant du run, hash/version de l'export, version du contrat, timestamp officiel unique du run, fuseau UTC, algorithmes de normalisation et versions de schéma/migrateur.

Il doit produire au minimum : comptes source/cible prévus par collection/table; mapping champ par champ; résolutions de toutes les FK; collisions; conversions invalides; `BLOCK`; `HUMAN_REVIEW`; champs inconnus; lignes prêtes; et un verdict reproductible. Les diagnostics doivent contenir le chemin Firebase et l'ID source, sans exposer de secret.

Une migration réelle est interdite si un `BLOCK` subsiste. Les `HUMAN_REVIEW` doivent recevoir une décision humaine enregistrée dans le manifest. Ce contrat ne modifie pas le dry-run existant : cette modification reste interdite tant que le P0 `PUBLIC EXECUTE` n'est pas traité.

## 25. Human Decisions Required

Avant migration réelle, une décision humaine reste requise pour : conflits d'alias; collisions de normalisation; rôles inconnus; chronologies invalides; valeurs/types invalides réparables; relations historiques optionnelles introuvables lorsque ce contrat les classe `HUMAN_REVIEW`; doublons métier divergents; et toute suppression de champ proposée.

Les orphelins classés `BLOCK`, les identités ambiguës, les parents structurels absents et les références message/unlock absentes ne peuvent pas être approuvés par une conversion en `NULL`; la source ou le mapping doit être corrigé explicitement.

## 26. Readiness Verdict

Les cibles SQL connues sont présentes et aucune cible de champ inventoriée ne manque. La stratégie d'identité est figée, y compris `sites.unlockedBy`, `purchases.updatedBy`, les destinataires/lectures de messages et les protections de déverrouillage. La table `site_unlock_protections` et ses FK obligatoires sont disponibles.

| Verdict | Valeur |
| --- | --- |
| `MISSING_TARGET` restants | **0** |
| `FIELD MAPPING COMPLETE` | **YES** |
| `IDENTITY STRATEGY COMPLETE` | **YES** |
| `UNLOCK PROTECTIONS RESOLVED` | **YES** |
| `READY TO FIX PUBLIC EXECUTE` | **YES** |
| `READY TO MODIFY DRY-RUN` | **NO** |

`READY TO MODIFY DRY-RUN` reste **NO** tant que le P0 `PUBLIC EXECUTE` n'est pas traité. Le présent verdict autorise uniquement l'étape distincte de correction de `PUBLIC EXECUTE`; il n'autorise ni import réel, ni modification du dry-run dans cette tâche.
