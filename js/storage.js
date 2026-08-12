import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseAuth, firebaseDb } from './firebase-core.js';
import { APP_CONFIG } from './config.js';

const OFFLINE_CACHE_KEY = 'suiviMateriel.offlineCache.v1';
const OFFLINE_CACHE_TTL_MS = 180 * 1000;
const SITE_INACTIVITY_THRESHOLD_DAYS = Number(APP_CONFIG?.siteInactivity?.thresholdDays) || 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const state = {
  initialized: false,
  db: null,
  userId: null,
  authUser: null,
  sites: [],
  itemsBySite: new Map(),
  detailsByItem: new Map(),
  listeners: {
    sites: new Set(),
    itemCounts: new Set(),
    itemsBySite: new Map(),
    detailCountsBySite: new Map(),
    detailDesignationsBySite: new Map(),
    detailRowsBySite: new Map(),
    detailsByPair: new Map(),
  },
};

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') {
    return 'admin';
  }
  if (role === 'adjoint' || role === 'adjoint admin' || role === 'full' || role === 'standard') {
    return 'standard';
  }
  if (role === 'lecture') {
    return 'lecture';
  }
  if (role === 'ecriture' || role === 'écriture' || role === 'limite' || role === 'limité') {
    return 'limite';
  }
  return 'limite';
}

function serializeRole(role) {
  const normalized = normalizeRole(role);
  if (normalized === 'admin') {
    return 'admin';
  }
  if (normalized === 'standard') {
    return 'Adjoint Admin';
  }
  return 'Limité';
}

function normalizeUsername(value) {
  return sanitizeText(value, false);
}

function normalizeAvatarUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMaintenanceAccess(value) {
  return Boolean(value);
}

function normalizeMaintenanceAuthorized(data) {
  if (typeof data?.maintenanceAuthorized === 'boolean') {
    return data.maintenanceAuthorized;
  }
  return normalizeMaintenanceAccess(data?.maintenanceAccess);
}

const BLOCKED_USERNAMES = new Set([
  'FACEBOOK',
  'YOUTUBE',
  'TWITEER',
  'ANONYME',
  'TAY',
  'AMANY',
  'FORY',
  'VODY',
  'LATAKA',
  'BOBOTA',
  'BIBITY',
  'BIBY',
  'KINDY',
  'TABORY',
  'NEMANY',
  'FUCK',
  'JE T AIME',
  'GOOGLE',
]);

function isValidUsername(username) {
  const value = normalizeUsername(username);
  if (!/^[A-Za-z0-9]{4,20}$/.test(value)) {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return false;
  }
  if (BLOCKED_USERNAMES.has(value.toUpperCase())) {
    return false;
  }
  return true;
}

function getCurrentAuthUser() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    return null;
  }
  return {
    uid: authUser.uid,
    email: authUser.email || '',
    displayName: authUser.displayName || '',
    photoURL: authUser.photoURL || '',
  };
}

function isAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === 'andrainaaina@gmail.com';
}

function usersCollection() {
  return collection(state.db, 'users');
}

function userDocRef(userId = state.userId) {
  if (!userId) {
    return null;
  }
  return doc(state.db, 'users', userId);
}

function maintenanceDocRef() {
  return doc(state.db, 'appSettings', 'maintenance');
}

function parseFirestoreDate(value) {
  if (!value) {
    return null;
  }
  let normalizedValue = value;
  if (typeof value?.toDate === 'function') {
    normalizedValue = value.toDate();
  } else if (typeof value?.seconds === 'number') {
    normalizedValue = new Date(value.seconds * 1000);
  }
  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getInactiveUserCutoffDate(referenceDate = new Date()) {
  const cutoffDate = new Date(referenceDate);
  cutoffDate.setMonth(cutoffDate.getMonth() - 5);
  return cutoffDate;
}

async function recordCurrentUserActivity(extraUpdates = {}) {
  if (!state.userId) {
    return false;
  }
  await setDoc(
    userDocRef(),
    {
      ...extraUpdates,
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  return true;
}

async function isUsernameDuplicate(username, excludedUserId) {
  const normalizedTarget = normalizeUsername(username).toUpperCase();
  const snapshot = await getDocs(usersCollection());
  return snapshot.docs.some((snap) => {
    if (snap.id === excludedUserId) {
      return false;
    }
    const existing = normalizeUsername(snap.data()?.username).toUpperCase();
    return existing && existing === normalizedTarget;
  });
}

async function ensureCurrentUser() {
  if (!state.userId) {
    return null;
  }
  const ref = userDocRef();
  const snap = await getDoc(ref);
  const authDisplayName = String(state.authUser?.displayName || '').trim();
  const authEmail = String(state.authUser?.email || '').trim();
  const authPhotoUrl = String(state.authUser?.photoURL || '').trim();
  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        uid: state.userId,
        username: authDisplayName,
        displayName: authDisplayName,
        email: authEmail,
        name: authDisplayName,
        photoURL: authPhotoUrl,
        avatarUrl: authPhotoUrl,
        avatar: authPhotoUrl,
        role: 'Limité',
        status: deleteField(),
        approved: deleteField(),
        pending: deleteField(),
        maintenanceAuthorized: false,
        maintenanceAccess: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        lastActivity: serverTimestamp(),
        lastNameChange: null,
      },
      { merge: true },
    );
    return {
      id: state.userId,
      username: authDisplayName,
      avatarUrl: authPhotoUrl,
      role: 'limite',
      maintenanceAccess: false,
      maintenanceAuthorized: false,
      lastNameChange: null,
      createdAt: null,
    };
  }

  const data = snap.data() || {};
  const mergedMaintenanceAuthorized = normalizeMaintenanceAuthorized(data);
  const updates = {
    uid: state.userId,
    displayName: authDisplayName,
    email: authEmail,
    photoURL: authPhotoUrl,
    avatarUrl: authPhotoUrl,
    avatar: authPhotoUrl,
    lastLoginAt: serverTimestamp(),
    lastActivity: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (!Object.prototype.hasOwnProperty.call(data, 'role') || !String(data.role || '').trim()) {
    updates.role = 'Limité';
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'maintenanceAuthorized')) {
    updates.maintenanceAuthorized = false;
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'maintenanceAccess')) {
    updates.maintenanceAccess = mergedMaintenanceAuthorized;
  }

  await setDoc(ref, updates, { merge: true });

  if ('status' in data || 'approved' in data || 'pending' in data) {
    await setDoc(
      ref,
      {
        status: deleteField(),
        approved: deleteField(),
        pending: deleteField(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  return {
    email: String(data.email || state.authUser?.email || ''),
    id: snap.id,
    username: normalizeUsername(data.username || data.displayName || data.name || state.authUser?.displayName),
    role: normalizeRole(data.role),
    maintenanceAccess: normalizeMaintenanceAuthorized(data),
    maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
    lastNameChange: data.lastNameChange || null,
    avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
    createdAt: data.createdAt || null,
  };
}

async function getCurrentUserProfile() {
  if (!state.userId) {
    return {
      id: null,
      username: '',
      email: '',
      role: 'limite',
      maintenanceAccess: false,
      lastNameChange: null,
      avatarUrl: '',
      createdAt: null,
      guest: true,
    };
  }
  const ref = userDocRef();
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    return ensureCurrentUser();
  }
  const data = snap.data() || {};
  return {
    email: String(data.email || state.authUser?.email || ''),
    id: snap.id,
    username: normalizeUsername(data.username || data.displayName || data.name || state.authUser?.displayName),
    role: normalizeRole(data.role),
    maintenanceAccess: normalizeMaintenanceAuthorized(data),
    maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
    lastNameChange: data.lastNameChange || null,
    avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
    createdAt: data.createdAt || null,
  };
}

function computeNextNameChangeDate(lastNameChange) {
  if (!lastNameChange) {
    return null;
  }
  const date = typeof lastNameChange.toDate === 'function' ? lastNameChange.toDate() : new Date(lastNameChange);
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

async function saveUsername(username) {
  const nextName = normalizeUsername(username);
  if (!isValidUsername(nextName)) {
    return { ok: false, reason: 'invalid_username' };
  }

  const profile = await getCurrentUserProfile();
  const duplicate = await isUsernameDuplicate(nextName, state.userId);
  if (duplicate) {
    return { ok: false, reason: 'duplicate_username' };
  }

  const isFirstUsername = !profile.username;
  const updates = {
    username: nextName,
    name: nextName,
    updatedAt: serverTimestamp(),
  };

  if (isFirstUsername) {
    updates.role = 'Limité';
    updates.status = deleteField();
    updates.approved = deleteField();
    updates.pending = deleteField();
  }

  await setDoc(
    userDocRef(),
    {
      ...updates,
      lastActivity: serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true, username: nextName };
}

async function changeUsername(username) {
  const profile = await getCurrentUserProfile();
  const nextAllowedAt = computeNextNameChangeDate(profile.lastNameChange);
  if (nextAllowedAt && new Date() < nextAllowedAt) {
    return { ok: false, reason: 'cooldown', nextAllowedAt };
  }

  const nextName = normalizeUsername(username);
  if (!isValidUsername(nextName)) {
    return { ok: false, reason: 'invalid_username' };
  }

  const duplicate = await isUsernameDuplicate(nextName, profile.id);
  if (duplicate) {
    return { ok: false, reason: 'duplicate_username' };
  }

  await setDoc(
    userDocRef(),
    {
      username: nextName,
      name: nextName,
      lastNameChange: Timestamp.fromDate(new Date()),
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return { ok: true, username: nextName };
}

async function updateAvatarUrl(avatarUrl) {
  const nextAvatarUrl = normalizeAvatarUrl(avatarUrl);
  await setDoc(
    userDocRef(),
    {
      avatarUrl: nextAvatarUrl,
      avatar: nextAvatarUrl,
      lastActivity: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  return { ok: true, avatarUrl: nextAvatarUrl };
}

async function listUsers() {
  const snapshot = await getDocs(usersCollection());
  return snapshot.docs
    .map((snap) => {
      const data = snap.data() || {};
      const email = String(data.email || '').trim();
      const fallbackName = email ? email.split('@')[0] : '';
      return {
        id: snap.id,
        username: normalizeUsername(data.username || data.displayName || data.name || fallbackName),
        rawUsername: normalizeUsername(data.username),
        displayName: normalizeUsername(data.displayName),
        name: normalizeUsername(data.name),
        email,
        avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
        role: normalizeRole(data.role),
        maintenanceAccess: normalizeMaintenanceAuthorized(data),
        maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
        createdAt: data.createdAt || null,
        lastActivity: data.lastActivity || null,
        lastSeen: data.lastSeen || null,
        online: data.online === true,
        presence: data.presence || null,
        status: data.status || null,
      };
    });
}

async function cleanupInactiveUsers(options = {}) {
  const cutoffDate = getInactiveUserCutoffDate(options.referenceDate || new Date());
  const snapshot = await getDocs(usersCollection());
  const deletedUserIds = [];
  const currentUserId = String(state.userId || '').trim();

  for (const userSnapshot of snapshot.docs) {
    const data = userSnapshot.data() || {};
    const email = String(data.email || '').trim();
    const lastActivityDate = parseFirestoreDate(data.lastActivity);
    if (!lastActivityDate || lastActivityDate >= cutoffDate || isAdminEmail(email) || userSnapshot.id === currentUserId) {
      continue;
    }
    await deleteDoc(userSnapshot.ref);
    deletedUserIds.push(userSnapshot.id);
  }

  return { deletedCount: deletedUserIds.length, deletedUserIds, cutoffDate };
}


function normalizeOutCreationPointsSnapshot(snapshot) {
  return snapshot.docs.reduce((pointsByUser, snap) => {
    const data = snap.data() || {};
    const creatorId = String(data.createdBy || data.ownerId || '').trim();
    if (!creatorId) {
      return pointsByUser;
    }
    pointsByUser[creatorId] = (pointsByUser[creatorId] || 0) + 1;
    return pointsByUser;
  }, {});
}

async function listOutCreationPoints() {
  const snapshot = await getDocs(makePageItemsCollection('page2'));
  return normalizeOutCreationPointsSnapshot(snapshot);
}

function subscribeOutCreationPoints(onChange, onError) {
  try {
    return onSnapshot(
      makePageItemsCollection('page2'),
      (snapshot) => {
        onChange(normalizeOutCreationPointsSnapshot(snapshot));
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

async function updateUserRole(userId, role) {
  const nextRole = normalizeRole(role);
  await setDoc(
    userDocRef(userId),
    {
      role: serializeRole(nextRole),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await recordCurrentUserActivity();
  return true;
}

async function updateUserMaintenanceAccess(userId, maintenanceAccess) {
  await setDoc(
    userDocRef(userId),
    {
      maintenanceAccess: Boolean(maintenanceAccess),
      maintenanceAuthorized: Boolean(maintenanceAccess),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await recordCurrentUserActivity();
  return true;
}

async function deleteUser(userId) {
  const targetId = String(userId || '').trim();
  if (!targetId) {
    return false;
  }
  await deleteDoc(userDocRef(targetId));
  await recordCurrentUserActivity();
  return true;
}

function subscribeCurrentUserProfile(onChange, onError) {
  try {
    return onSnapshot(
      userDocRef(),
      (snapshot) => {
        if (!snapshot.exists()) {
          onChange({
            id: state.userId,
            username: '',
            role: isAdminEmail(state.authUser?.email) ? 'admin' : 'limite',
            maintenanceAccess: false,
            lastNameChange: null,
            avatarUrl: '',
            createdAt: null,
            missing: true,
          });
          return;
        }
        const data = snapshot.data() || {};
        onChange({
          id: snapshot.id,
          username: normalizeUsername(data.username || data.name),
          role: normalizeRole(data.role),
          maintenanceAccess: normalizeMaintenanceAccess(data.maintenanceAccess),
          lastNameChange: data.lastNameChange || null,
          avatarUrl: normalizeAvatarUrl(data.avatarUrl || data.avatar),
          createdAt: data.createdAt || null,
          missing: false,
        });
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeUsers(onChange, onError) {
  try {
    return onSnapshot(
      usersCollection(),
      (snapshot) => {
        console.log('[users] snapshot size:', snapshot.size);
        snapshot.docs.forEach((snap) => {
          console.log('[users] doc id:', snap.id, snap.data());
        });
        const users = snapshot.docs
          .map((snap) => {
            const data = snap.data() || {};
            const email = String(data.email || '').trim();
            const fallbackName = email ? email.split('@')[0] : '';
            return {
              id: snap.id,
              username: normalizeUsername(data.username || data.displayName || data.name || fallbackName),
              email,
              avatarUrl: normalizeAvatarUrl(data.photoURL || data.avatarUrl || data.avatar),
              role: normalizeRole(data.role),
              maintenanceAccess: normalizeMaintenanceAuthorized(data),
              maintenanceAuthorized: normalizeMaintenanceAuthorized(data),
              createdAt: data.createdAt || null,
              lastActivity: data.lastActivity || null,
              lastSeen: data.lastSeen || null,
              online: data.online === true,
              presence: data.presence || null,
              status: data.status || null,
            };
          });
        onChange(users);
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function normalizeMaintenanceState(value) {
  return {
    enabled: Boolean(value?.enabled),
  };
}

async function setMaintenanceState(enabled) {
  await setDoc(
    maintenanceDocRef(),
    {
      enabled: Boolean(enabled),
      updatedAt: serverTimestamp(),
      updatedBy: state.userId || null,
    },
    { merge: true },
  );
  await recordCurrentUserActivity();
  return true;
}

function subscribeMaintenanceState(onChange, onError) {
  try {
    return onSnapshot(
      maintenanceDocRef(),
      (snapshot) => {
        onChange(normalizeMaintenanceState(snapshot.exists() ? snapshot.data() : { enabled: false }));
      },
      (error) => {
        if (typeof onError === 'function') {
          onError(error);
        }
      },
    );
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeTrim(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeText(value, uppercase) {
  const cleaned = safeTrim(value).replace(/[<>]/g, '');
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

function sanitizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function sanitizeNumber(value) {
  if (value === '' || value === null || value === undefined) {
    return '';
  }
  const normalizedValue = typeof value === 'string' ? value.trim().replace(',', '.') : value;
  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function sanitizeReturnDate(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function sanitizeDetailStatut(value) {
  return String(value || '').trim().toUpperCase() === 'K.O' ? 'K.O' : 'OK';
}

function nowIso() {
  return new Date().toISOString();
}

async function resolveCurrentUserName() {
  const profile = await getCurrentUserProfile();
  const rawName = profile?.username || state.authUser?.displayName || '';
  return sanitizeText(rawName, false) || 'Utilisateur';
}

function resolveCurrentUserEmail() {
  return String(state.authUser?.email || firebaseAuth.currentUser?.email || '').trim();
}

function uid() {
  return `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function makePageItemsCollection(pageName) {
  return collection(state.db, 'pages', pageName, 'items');
}

function getOutDeletionLimitDateKey(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0');
  const day = String(referenceDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function outDeletionLimitDocRef(userId, dateKey = getOutDeletionLimitDateKey()) {
  return doc(state.db, 'users', userId, 'outDeletionLimits', dateKey);
}

async function hasReachedOutDeletionLimit(userId, limit = 2) {
  if (!userId) {
    return true;
  }
  const limitSnap = await getDoc(outDeletionLimitDocRef(userId));
  const currentCount = Number(limitSnap.exists() ? limitSnap.data()?.count : 0);
  return currentCount >= limit;
}

async function recordOutDeletionLimitUsage(userId) {
  if (!userId) {
    return;
  }
  const dateKey = getOutDeletionLimitDateKey();
  const limitRef = outDeletionLimitDocRef(userId, dateKey);
  const limitSnap = await getDoc(limitRef);
  const currentCount = Number(limitSnap.exists() ? limitSnap.data()?.count : 0);
  await setDoc(
    limitRef,
    {
      date: dateKey,
      count: currentCount + 1,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

function historyCollection() {
  return collection(state.db, 'historiques');
}

function normalizeDocData(docSnapshot) {
  const data = docSnapshot.data() || {};
  return { id: docSnapshot.id, ...data };
}

function persistOfflineState() {
  const items = [];
  state.itemsBySite.forEach((value) => items.push(...value));
  const details = [];
  state.detailsByItem.forEach((value) => details.push(...value));
  const payload = {
    savedAt: nowIso(),
    pages: {
      page1: state.sites,
      page2: items,
      page3: details,
    },
  };
  localStorage.setItem(OFFLINE_CACHE_KEY, JSON.stringify(payload));
}

function parseOfflineState() {
  try {
    const raw = localStorage.getItem(OFFLINE_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const page1 = Array.isArray(parsed?.pages?.page1) ? parsed.pages.page1 : [];
    const page2 = Array.isArray(parsed?.pages?.page2) ? parsed.pages.page2 : [];
    const page3 = Array.isArray(parsed?.pages?.page3) ? parsed.pages.page3 : [];
    const savedAt = typeof parsed?.savedAt === 'string' ? parsed.savedAt : null;
    const savedAtTime = savedAt ? new Date(savedAt).getTime() : NaN;
    const isFresh = Number.isFinite(savedAtTime) && Date.now() - savedAtTime < OFFLINE_CACHE_TTL_MS;
    return {
      snapshot: { page1, page2, page3 },
      savedAt,
      isFresh,
    };
  } catch (_error) {
    return null;
  }
}

async function readPageItems(pageName) {
  const pageRef = makePageItemsCollection(pageName);
  const snapshot = await getDocs(pageRef);
  return snapshot.docs.map(normalizeDocData);
}

async function loadRemoteSnapshot() {
  const [page1, page2, page3] = await Promise.all([
    readPageItems('page1'),
    readPageItems('page2'),
    readPageItems('page3'),
  ]);
  return { page1, page2, page3 };
}

function applySnapshot(snapshot) {
  state.sites = Array.isArray(snapshot.page1) ? clone(snapshot.page1) : [];

  state.itemsBySite = new Map();
  (Array.isArray(snapshot.page2) ? snapshot.page2 : []).forEach((item) => {
    const siteId = String(item.siteId || '');
    if (!siteId) {
      return;
    }
    if (!state.itemsBySite.has(siteId)) {
      state.itemsBySite.set(siteId, []);
    }
    state.itemsBySite.get(siteId).push(item);
  });

  state.detailsByItem = new Map();
  (Array.isArray(snapshot.page3) ? snapshot.page3 : []).forEach((detail) => {
    const siteId = String(detail.siteId || '');
    const itemId = String(detail.itemId || '');
    if (!siteId || !itemId) {
      return;
    }
    const key = `${siteId}:${itemId}`;
    if (!state.detailsByItem.has(key)) {
      state.detailsByItem.set(key, []);
    }
    state.detailsByItem.get(key).push(detail);
  });

  sortState();
}

function sortState() {
  state.sites.sort((a, b) => String(b.dateModification || '').localeCompare(String(a.dateModification || '')));
  state.itemsBySite.forEach((items) => {
    items.sort((a, b) => String(b.dateModification || '').localeCompare(String(a.dateModification || '')));
  });
  state.detailsByItem.forEach((details) => {
    details.sort((a, b) => Number(a.champ) - Number(b.champ));
  });
}

function emitForSite(siteId) {
  const items = clone(state.itemsBySite.get(siteId) || []);
  (state.listeners.itemsBySite.get(siteId) || new Set()).forEach((listener) => listener(items));

  const detailCounts = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      detailCounts[itemId] = details.length;
    }
  });
  (state.listeners.detailCountsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(detailCounts)));

  const designationsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId !== siteId) {
      return;
    }
    designationsByItem[itemId] = details.map((detail) => sanitizeText(detail.designation, true)).filter(Boolean);
  });
  (state.listeners.detailDesignationsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(designationsByItem)));

  const rowsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      rowsByItem[itemId] = clone(details).sort((a, b) => Number(a.champ) - Number(b.champ));
    }
  });
  (state.listeners.detailRowsBySite.get(siteId) || new Set()).forEach((listener) => listener(clone(rowsByItem)));
}

function emitAll() {
  state.listeners.sites.forEach((listener) => listener(filterSitesVisibleToCurrentUser()));

  const itemCounts = {};
  state.itemsBySite.forEach((items, siteId) => {
    itemCounts[siteId] = items.length;
  });
  state.listeners.itemCounts.forEach((listener) => listener(clone(itemCounts)));

  state.listeners.itemsBySite.forEach((_listeners, siteId) => emitForSite(siteId));
  state.listeners.detailsByPair.forEach((listeners, key) => {
    const [siteId, itemId] = key.split(':');
    const details = clone(state.detailsByItem.get(`${siteId}:${itemId}`) || []);
    listeners.forEach((listener) => listener(details));
  });
}

async function init() {
  if (state.initialized) {
    return;
  }

  state.initialized = true;
  state.authUser = getCurrentAuthUser();
  state.userId = state.authUser?.uid || null;
  state.db = firebaseDb;

  const offlineState = parseOfflineState();
  if (offlineState?.snapshot) {
    applySnapshot(offlineState.snapshot);
  }

  if (!offlineState?.isFresh) {
    try {
      const remote = await loadRemoteSnapshot();
      applySnapshot(remote);
      persistOfflineState();
    } catch (_error) {
      if (!offlineState?.snapshot) {
        applySnapshot({ page1: [], page2: [], page3: [] });
      }
    }
  } else if (!offlineState.snapshot) {
    // Defensive fallback, should never happen.
    try {
      const remote = await loadRemoteSnapshot();
      applySnapshot(remote);
      persistOfflineState();
    } catch (_error) {
      applySnapshot({ page1: [], page2: [], page3: [] });
    }
  }
}


function getSiteInactivityThresholdDays() {
  return SITE_INACTIVITY_THRESHOLD_DAYS;
}

function getSiteOutCount(siteId) {
  return (state.itemsBySite.get(String(siteId || '')) || []).length;
}

function isCurrentUserSiteCreator(site) {
  const currentUserId = String(state.userId || '').trim();
  const creatorId = String(site?.createdBy || site?.ownerId || '').trim();
  return Boolean(currentUserId && creatorId && currentUserId === creatorId);
}

function getInactiveSiteEligibleDate(site, referenceDate = new Date()) {
  if (getSiteOutCount(site?.id) !== 0) {
    return null;
  }
  const inactiveSince = parseFirestoreDate(site?.inactiveSince);
  if (!inactiveSince) {
    return null;
  }
  return new Date(inactiveSince.getTime() + SITE_INACTIVITY_THRESHOLD_DAYS * DAY_IN_MS);
}

function isSitePendingInactivityDecision(site, referenceDate = new Date()) {
  if (!site) {
    return false;
  }
  if (site?.inactivityDecisionPending === true) {
    return true;
  }
  const eligibleDate = getInactiveSiteEligibleDate(site, referenceDate);
  return Boolean(eligibleDate && eligibleDate.getTime() <= referenceDate.getTime());
}

function isSiteVisibleToCurrentUser(site, referenceDate = new Date()) {
  return !isSitePendingInactivityDecision(site, referenceDate) || isCurrentUserSiteCreator(site);
}

function filterSitesVisibleToCurrentUser(sites = state.sites, referenceDate = new Date()) {
  return clone((Array.isArray(sites) ? sites : []).filter((site) => isSiteVisibleToCurrentUser(site, referenceDate)));
}

async function refreshSiteInactivityStates(referenceDate = new Date()) {
  const updates = [];
  const nowValue = referenceDate.toISOString();

  for (const site of state.sites) {
    const siteId = String(site?.id || '').trim();
    if (!siteId) {
      continue;
    }
    const outCount = getSiteOutCount(siteId);
    const hasInactiveSince = Boolean(parseFirestoreDate(site?.inactiveSince));
    if (outCount === 0 && !hasInactiveSince) {
      const payload = {
        inactiveSince: nowValue,
        inactivityDecisionPending: false,
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      Object.assign(site, payload);
      continue;
    }
    const pendingEligibleDate = getInactiveSiteEligibleDate(site, referenceDate);
    if (outCount === 0 && pendingEligibleDate && pendingEligibleDate.getTime() <= referenceDate.getTime() && site?.inactivityDecisionPending !== true) {
      const payload = {
        inactivityDecisionPending: true,
        inactivityDecisionPendingAt: nowValue,
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      Object.assign(site, payload);
      continue;
    }
    if (outCount > 0 && (hasInactiveSince || site?.inactivityDecisionPending)) {
      const payload = {
        inactiveSince: deleteField(),
        inactivityDecisionPending: deleteField(),
        inactivityDecisionPendingAt: deleteField(),
        dateModification: site.dateModification || nowValue,
      };
      updates.push(setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true }));
      delete site.inactiveSince;
      delete site.inactivityDecisionPending;
      delete site.inactivityDecisionPendingAt;
    }
  }

  if (updates.length) {
    await Promise.all(updates);
    persistOfflineState();
    emitAll();
  }
  return listInactiveSitesForCurrentCreator(referenceDate);
}

function listInactiveSitesForCurrentCreator(referenceDate = new Date()) {
  return clone(state.sites.filter((site) => isCurrentUserSiteCreator(site) && isSitePendingInactivityDecision(site, referenceDate)));
}

async function restoreInactiveSite(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1 || !isCurrentUserSiteCreator(state.sites[siteIndex])) {
    return { ok: false, reason: 'site_not_found' };
  }
  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    {
      inactiveSince: deleteField(),
      inactivityDecisionPending: deleteField(),
      inactivityDecisionPendingAt: deleteField(),
      inactivityRestoredAt: timestamp,
      dateModification: timestamp,
    },
    { merge: true },
  );
  delete state.sites[siteIndex].inactiveSince;
  delete state.sites[siteIndex].inactivityDecisionPending;
  delete state.sites[siteIndex].inactivityDecisionPendingAt;
  state.sites[siteIndex].inactivityRestoredAt = timestamp;
  state.sites[siteIndex].dateModification = timestamp;
  await appendHistoryEntry(`a restauré le site inactif ${state.sites[siteIndex].nom}`, { siteId, siteName: state.sites[siteIndex].nom });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

function getSite(siteId) {
  const site = state.sites.find((item) => item.id === siteId) || null;
  return site && isSiteVisibleToCurrentUser(site) ? clone(site) : null;
}

function getSites() {
  return filterSitesVisibleToCurrentUser();
}

function getItem(siteId, itemId) {
  const items = state.itemsBySite.get(siteId) || [];
  return clone(items.find((item) => item.id === itemId) || null);
}

function subscribeFactory(registry, key, onChange) {
  if (!registry.has(key)) {
    registry.set(key, new Set());
  }
  const listeners = registry.get(key);
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function subscribeSites(onChange, onError) {
  try {
    state.listeners.sites.add(onChange);
    onChange(filterSitesVisibleToCurrentUser());
    return () => state.listeners.sites.delete(onChange);
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeItems(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.itemsBySite, siteId, onChange);
    onChange(clone(state.itemsBySite.get(siteId) || []));
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeItemCounts(onChange, onError) {
  try {
    state.listeners.itemCounts.add(onChange);
    const counts = {};
    state.itemsBySite.forEach((items, siteId) => {
      counts[siteId] = items.length;
    });
    onChange(clone(counts));
    return () => state.listeners.itemCounts.delete(onChange);
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeDetails(siteId, itemId, onChange, onError) {
  try {
    const key = `${siteId}:${itemId}`;
    const unsubscribe = subscribeFactory(state.listeners.detailsByPair, key, onChange);
    onChange(clone(state.detailsByItem.get(key) || []));
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeDetailCounts(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailCountsBySite, siteId, onChange);
    const counts = {};
    state.detailsByItem.forEach((details, key) => {
      const [kSiteId, itemId] = key.split(':');
      if (kSiteId === siteId) {
        counts[itemId] = details.length;
      }
    });
    onChange(clone(counts));
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeDetailDesignations(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailDesignationsBySite, siteId, onChange);
    const designationsByItem = {};
    state.detailsByItem.forEach((details, key) => {
      const [kSiteId, itemId] = key.split(':');
      if (kSiteId === siteId) {
        designationsByItem[itemId] = details.map((detail) => sanitizeText(detail.designation, true)).filter(Boolean);
      }
    });
    onChange(clone(designationsByItem));
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

function subscribeDetailRows(siteId, onChange, onError) {
  try {
    const unsubscribe = subscribeFactory(state.listeners.detailRowsBySite, siteId, onChange);
    const rowsByItem = {};
    state.detailsByItem.forEach((details, key) => {
      const [kSiteId, itemId] = key.split(':');
      if (kSiteId === siteId) {
        rowsByItem[itemId] = clone(details).sort((a, b) => Number(a.champ) - Number(b.champ));
      }
    });
    onChange(clone(rowsByItem));
    return unsubscribe;
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error);
    }
    return () => {};
  }
}

async function getDetailRowsBySite(siteId) {
  const rowsByItem = {};
  state.detailsByItem.forEach((details, key) => {
    const [kSiteId, itemId] = key.split(':');
    if (kSiteId === siteId) {
      rowsByItem[itemId] = clone(details).sort((a, b) => Number(a.champ) - Number(b.champ));
    }
  });
  return clone(rowsByItem);
}

async function getAllDetails() {
  const details = [];
  state.detailsByItem.forEach((itemDetails) => {
    details.push(...itemDetails);
  });
  return clone(details);
}

function isDuplicateSiteName(name) {
  const normalized = sanitizeText(name, true);
  if (!normalized) {
    return false;
  }
  return state.sites.some((site) => sanitizeText(site.nom, true) === normalized);
}

function isDuplicateItemNumber(siteId, numero) {
  const normalized = sanitizeText(numero, true);
  if (!normalized) {
    return false;
  }
  const items = state.itemsBySite.get(siteId) || [];
  return items.some((item) => sanitizeText(item.numero, true) === normalized);
}

function isDuplicateDetailDesignation(siteId, itemId, designation) {
  const normalized = sanitizeText(designation, true);
  if (!normalized) {
    return false;
  }
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  return details.some((detail) => sanitizeText(detail.designation, true) === normalized);
}

function withoutId(payload) {
  const copy = { ...payload };
  delete copy.id;
  return copy;
}

async function createSite(name) {
  const siteName = sanitizeText(name, true);
  if (!siteName) {
    return { ok: false, reason: 'invalid_name' };
  }
  if (isDuplicateSiteName(siteName)) {
    return { ok: false, reason: 'duplicate_site' };
  }

  const timestamp = nowIso();
  const creatorName = await resolveCurrentUserName();
  const sitePayload = {
    nom: siteName,
    ownerId: state.userId,
    createdBy: state.userId,
    createdByName: creatorName,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page1'), sitePayload);
  const site = { id: created.id, ...sitePayload };

  state.sites.unshift(site);
  await appendHistoryEntry(`a créé le site ${site.nom}`, { siteId: site.id, siteName: site.nom });
  persistOfflineState();
  emitAll();
  return { ok: true, id: site.id };
}

async function updateSiteName(siteId, name) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const siteName = sanitizeText(name, true);
  if (!siteName) {
    return { ok: false, reason: 'invalid_name' };
  }

  const hasDuplicate = state.sites.some(
    (site, index) => index !== siteIndex && sanitizeText(site.nom, true) === siteName,
  );
  if (hasDuplicate) {
    return { ok: false, reason: 'duplicate_site' };
  }

  const previousSiteName = sanitizeText(state.sites[siteIndex]?.nom, false);
  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    { nom: siteName, dateModification: timestamp },
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    nom: siteName,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry(`a modifié le site ${previousSiteName || siteName} en ${siteName}`, { siteId, siteName });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function updateSiteCreator(siteId, user) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const userId = String(user?.id || user?.uid || '').trim();
  if (!userId) {
    return { ok: false, reason: 'invalid_user' };
  }

  const userName = normalizeUsername(user?.username || user?.displayName || user?.name || user?.email || 'Utilisateur') || 'Utilisateur';
  const userEmail = String(user?.email || '').trim();
  const timestamp = nowIso();
  const creatorPayload = {
    ownerId: userId,
    createdBy: userId,
    createdByName: userName,
    createdByEmail: userEmail,
    dateModification: timestamp,
  };

  await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), creatorPayload, { merge: true });

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    ...creatorPayload,
  };
  await appendHistoryEntry(`a changé le créateur du site ${state.sites[siteIndex].nom} en ${userName}`, {
    siteId,
    siteName: state.sites[siteIndex].nom,
  });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function setSiteLock(siteId, lockPayload) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const timestamp = nowIso();
  const resolvedLockerName = await resolveCurrentUserName();
  const lockerName = resolvedLockerName && resolvedLockerName !== 'Utilisateur' ? resolvedLockerName : 'Utilisateur inconnu';
  const lockerEmail = resolveCurrentUserEmail();
  const nextLockState = {
    isLocked: true,
    passwordHash: sanitizeText(lockPayload?.passwordHash, false),
    lockedAt: timestamp,
    lockedBy: lockerEmail,
    lockedByName: lockerName,
    unlockedBy: deleteField(),
    unlockAttemptsRemaining: 3,
    unlockBlockedUntil: deleteField(),
    dateModification: timestamp,
  };

  if (!nextLockState.passwordHash) {
    return { ok: false, reason: 'invalid_password_hash' };
  }

  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    nextLockState,
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    ...nextLockState,
  };
  sortState();
  await appendHistoryEntry(lockPayload?.historyAction || 'a protégé le site par un mot de passe', { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function clearSiteLock(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }

  const timestamp = nowIso();
  const resolvedUnlockerName = await resolveCurrentUserName();
  const unlockerName = resolvedUnlockerName && resolvedUnlockerName !== 'Utilisateur' ? resolvedUnlockerName : 'Utilisateur inconnu';
  const unlockerEmail = resolveCurrentUserEmail();
  const nextLockState = {
    isLocked: false,
    passwordHash: deleteField(),
    lockedAt: deleteField(),
    lockedByName: deleteField(),
    lockedBy: deleteField(),
    unlockedBy: unlockerEmail,
    unlockedByName: unlockerName,
    unlockAttemptsRemaining: deleteField(),
    unlockBlockedUntil: deleteField(),
    dateModification: timestamp,
  };

  await setDoc(
    doc(state.db, 'pages', 'page1', 'items', siteId),
    nextLockState,
    { merge: true },
  );

  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    isLocked: false,
    passwordHash: '',
    lockedAt: null,
    lockedBy: '',
    lockedByName: '',
    unlockedBy: unlockerEmail,
    unlockedByName: unlockerName,
    unlockAttemptsRemaining: null,
    unlockBlockedUntil: null,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry('a retiré le mot de passe du site', { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function recordSiteUnlockHistory(siteId) {
  await appendHistoryEntry('a déverrouillé le site', { siteId });
}

function formatSiteUnlockFailureAttemptsMessage(attemptsRemaining) {
  const count = Math.max(0, Number(attemptsRemaining) || 0);
  if (count === 0) {
    return 'Il ne reste plus aucun essai.';
  }
  return `Il reste ${count} ${count === 1 ? 'essai' : 'essais'}.`;
}

async function recordSiteUnlockFailureHistory(siteId, attemptsRemaining) {
  const profile = await getCurrentUserProfile();
  const username = normalizeUsername(profile?.username) || normalizeUsername(state.authUser?.displayName) || 'Utilisateur inconnu';
  const siteName = resolveSiteNameForHistory(siteId);
  const action = `${username} a essayé d'ouvrir le site « ${siteName || 'Site inconnu'} » avec un mot de passe incorrect. ${formatSiteUnlockFailureAttemptsMessage(attemptsRemaining)}`;
  await appendHistoryEntry(action, { siteId, siteName });
}

async function recordExcelExportHistory(siteId, siteName = '') {
  const resolvedSiteName = resolveSiteNameForHistory(siteId, siteName);
  const action = resolvedSiteName
    ? `a exporté un fichier depuis le site « ${resolvedSiteName} ».`
    : 'a exporté un fichier depuis le site.';
  await appendHistoryEntry(action, { siteId, siteName: resolvedSiteName });
}

function getAuthenticatedUnlockProtectionUid() {
  return String(state.authUser?.uid || state.userId || firebaseAuth.currentUser?.uid || '').trim();
}

function buildSiteUnlockProtectionKey(siteId) {
  const uid = getAuthenticatedUnlockProtectionUid();
  const normalizedSiteId = String(siteId || '').trim();
  return uid && normalizedSiteId ? `${normalizedSiteId}_${uid}` : '';
}

function isLocalUnlockProtectionEnabled() {
  return !getAuthenticatedUnlockProtectionUid() && typeof window !== 'undefined' && window.localStorage;
}

function buildLocalSiteUnlockProtectionKey(siteId) {
  const normalizedSiteId = String(siteId || '').trim();
  return normalizedSiteId ? `security_attempts_${normalizedSiteId}` : '';
}

function readLocalSiteUnlockProtection(siteId) {
  if (!isLocalUnlockProtectionEnabled()) {
    return {};
  }
  const storageKey = buildLocalSiteUnlockProtectionKey(siteId);
  if (!storageKey) {
    return {};
  }
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    return parsedValue && typeof parsedValue === 'object' ? parsedValue : {};
  } catch (_error) {
    return {};
  }
}

function writeLocalSiteUnlockProtection(siteId, protection) {
  if (!isLocalUnlockProtectionEnabled()) {
    return false;
  }
  const storageKey = buildLocalSiteUnlockProtectionKey(siteId);
  if (!storageKey) {
    return false;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({
      attemptsRemaining: protection.attemptsRemaining,
      blockedUntil: protection.blockedUntil || null,
      hasAttempted: Boolean(protection.hasAttempted),
    }));
    return true;
  } catch (_error) {
    return false;
  }
}

function readSiteUnlockProtection(site, siteId) {
  const normalizedSiteId = String(siteId || site?.id || '').trim();
  if (isLocalUnlockProtectionEnabled()) {
    return readLocalSiteUnlockProtection(normalizedSiteId);
  }
  const protectionKey = buildSiteUnlockProtectionKey(normalizedSiteId);
  const protections = site?.unlockProtections && typeof site.unlockProtections === 'object' ? site.unlockProtections : {};
  const scopedProtection = protectionKey ? protections[protectionKey] : null;
  return scopedProtection && typeof scopedProtection === 'object' ? scopedProtection : {};
}

function normalizeUnlockProtection(site, siteId) {
  const scopedProtection = readSiteUnlockProtection(site, siteId);
  const blockedUntilRaw = scopedProtection?.blockedUntil || null;
  const blockedUntilDate = blockedUntilRaw ? new Date(blockedUntilRaw) : null;
  const blockedUntilMs = blockedUntilDate && !Number.isNaN(blockedUntilDate.getTime()) ? blockedUntilDate.getTime() : 0;
  if (blockedUntilMs > Date.now()) {
    return {
      attemptsRemaining: 0,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      hasAttempted: true,
      isBlocked: true,
    };
  }
  const attempts = Number(scopedProtection?.attemptsRemaining);
  const hasAttempted = Boolean(scopedProtection?.hasAttempted);
  return {
    attemptsRemaining: Number.isInteger(attempts) && attempts >= 0 && attempts <= 3 ? attempts : 3,
    blockedUntil: null,
    hasAttempted,
    isBlocked: false,
  };
}

async function resetSiteUnlockProtection(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }
  if (isLocalUnlockProtectionEnabled()) {
    writeLocalSiteUnlockProtection(siteId, {
      attemptsRemaining: 3,
      blockedUntil: null,
      hasAttempted: false,
    });
    return { ok: true, ...normalizeUnlockProtection(state.sites[siteIndex], siteId) };
  }
  const protectionKey = buildSiteUnlockProtectionKey(siteId);
  if (!protectionKey) {
    return { ok: false, reason: 'auth_required' };
  }
  const unlockProtections = {
    ...(state.sites[siteIndex].unlockProtections && typeof state.sites[siteIndex].unlockProtections === 'object'
      ? state.sites[siteIndex].unlockProtections
      : {}),
    [protectionKey]: {
      attemptsRemaining: 3,
      blockedUntil: null,
    },
  };
  const payload = { unlockProtections };
  await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true });
  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    unlockProtections,
  };
  persistOfflineState();
  emitAll();
  return { ok: true, ...normalizeUnlockProtection(state.sites[siteIndex], siteId) };
}

async function getSiteUnlockProtectionState(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) {
    return { ok: false, reason: 'site_not_found' };
  }
  const protection = normalizeUnlockProtection(site, siteId);
  const scopedProtection = readSiteUnlockProtection(site, siteId);
  if (!protection.isBlocked && scopedProtection.blockedUntil) {
    return resetSiteUnlockProtection(siteId);
  }
  return { ok: true, ...protection };
}

async function registerSiteUnlockFailure(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return { ok: false, reason: 'site_not_found' };
  }
  const current = normalizeUnlockProtection(state.sites[siteIndex], siteId);
  if (current.isBlocked) {
    return { ok: true, ...current };
  }
  const attemptsRemaining = Math.max(0, current.attemptsRemaining - 1);
  const blockedUntil = attemptsRemaining === 0 ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
  if (isLocalUnlockProtectionEnabled()) {
    writeLocalSiteUnlockProtection(siteId, {
      attemptsRemaining,
      blockedUntil,
      hasAttempted: true,
    });
    return { ok: true, attemptsRemaining, blockedUntil, hasAttempted: true, isBlocked: Boolean(blockedUntil) };
  }
  const protectionKey = buildSiteUnlockProtectionKey(siteId);
  if (!protectionKey) {
    return { ok: false, reason: 'auth_required' };
  }
  const unlockProtections = {
    ...(state.sites[siteIndex].unlockProtections && typeof state.sites[siteIndex].unlockProtections === 'object'
      ? state.sites[siteIndex].unlockProtections
      : {}),
    [protectionKey]: {
      attemptsRemaining,
      blockedUntil,
    },
  };
  const payload = { unlockProtections };
  await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), payload, { merge: true });
  state.sites[siteIndex] = {
    ...state.sites[siteIndex],
    unlockProtections,
  };
  persistOfflineState();
  emitAll();
  return { ok: true, attemptsRemaining, blockedUntil, isBlocked: Boolean(blockedUntil) };
}

async function removeSite(siteId) {
  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex === -1) {
    return null;
  }

  const siteToRemove = state.sites[siteIndex];
  const profile = await getCurrentUserProfile();
  const currentUserId = String(state.userId || profile?.id || '').trim();
  const creatorId = String(siteToRemove?.createdBy || siteToRemove?.ownerId || '').trim();
  const normalizedRole = normalizeRole(profile?.role);
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'standard' || isAdminEmail(profile?.email);
  if (!isAdmin && (!currentUserId || !creatorId || currentUserId !== creatorId)) {
    return null;
  }

  const itemsToDelete = clone(state.itemsBySite.get(siteId) || []);
  const detailDeletePromises = [];
  Array.from(state.detailsByItem.entries()).forEach(([key, details]) => {
    if (key.startsWith(`${siteId}:`)) {
      details.forEach((detail) => detailDeletePromises.push(deleteDoc(doc(state.db, 'pages', 'page3', 'items', detail.id))));
    }
  });
  await Promise.all([
    ...detailDeletePromises,
    ...itemsToDelete.map((item) => deleteDoc(doc(state.db, 'pages', 'page2', 'items', item.id))),
    deleteDoc(doc(state.db, 'pages', 'page1', 'items', siteId)),
  ]);

  const [site] = state.sites.splice(siteIndex, 1);
  const items = clone(state.itemsBySite.get(siteId) || []);
  state.itemsBySite.delete(siteId);

  const details = [];
  Array.from(state.detailsByItem.keys()).forEach((key) => {
    if (key.startsWith(`${siteId}:`)) {
      details.push(...(state.detailsByItem.get(key) || []));
      state.detailsByItem.delete(key);
    }
  });

  await appendHistoryEntry(`a supprimé le site ${site.nom}`, { siteId, siteName: site.nom });
  persistOfflineState();
  emitAll();

  return { site: clone(site), items, details };
}

async function createItem(siteId, numberValue, options = {}) {
  const cleanNumber = sanitizeDigits(sanitizeText(numberValue, true).replace(/^OUT-/, ''));
  if (cleanNumber.length < 4) {
    return { ok: false, reason: 'invalid_out' };
  }
  const numero = `OUT-${cleanNumber}`;
  if (isDuplicateItemNumber(siteId, numero)) {
    return { ok: false, reason: 'duplicate_out' };
  }

  const timestamp = nowIso();
  const creatorName = await resolveCurrentUserName();
  const itemPayload = {
    siteId,
    numero,
    magasin: sanitizeText(options?.magasin || 'None', true) || 'None',
    ownerId: state.userId,
    createdBy: state.userId,
    createdByName: creatorName,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page2'), itemPayload);
  const item = { id: created.id, ...itemPayload };

  const siteIndex = state.sites.findIndex((site) => site.id === siteId);
  if (siteIndex !== -1 && (state.sites[siteIndex].inactiveSince || state.sites[siteIndex].inactivityDecisionPending)) {
    await setDoc(doc(state.db, 'pages', 'page1', 'items', siteId), { inactiveSince: deleteField(), inactivityDecisionPending: deleteField(), inactivityDecisionPendingAt: deleteField(), dateModification: timestamp }, { merge: true });
    delete state.sites[siteIndex].inactiveSince;
    delete state.sites[siteIndex].inactivityDecisionPending;
    delete state.sites[siteIndex].inactivityDecisionPendingAt;
    state.sites[siteIndex].dateModification = timestamp;
  }

  if (!state.itemsBySite.has(siteId)) {
    state.itemsBySite.set(siteId, []);
  }
  state.itemsBySite.get(siteId).unshift(item);

  await appendHistoryEntry(`a créé ${item.numero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, id: item.id };
}

async function updateItemName(siteId, itemId, nextValue) {
  const items = state.itemsBySite.get(siteId) || [];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    return { ok: false, reason: 'item_not_found' };
  }

  const rawValue = sanitizeText(nextValue, true);
  if (!rawValue) {
    return { ok: false, reason: 'invalid_out' };
  }

  let normalizedNumero = rawValue;
  if (!/^out-/i.test(normalizedNumero)) {
    const cleanDigits = sanitizeDigits(normalizedNumero.replace(/^OUT-/i, ''));
    if (cleanDigits.length < 4) {
      return { ok: false, reason: 'invalid_out' };
    }
    normalizedNumero = `OUT-${cleanDigits}`;
  }

  if (normalizedNumero.length < 4) {
    return { ok: false, reason: 'invalid_out' };
  }

  const currentNumero = sanitizeText(items[itemIndex]?.numero, true);
  if (sanitizeText(normalizedNumero, true) === currentNumero) {
    return { ok: true, unchanged: true };
  }

  const hasDuplicate = items.some(
    (item, index) => index !== itemIndex && sanitizeText(item.numero, true) === sanitizeText(normalizedNumero, true),
  );
  if (hasDuplicate) {
    return { ok: false, reason: 'duplicate_out' };
  }

  const timestamp = nowIso();
  await setDoc(
    doc(state.db, 'pages', 'page2', 'items', itemId),
    { numero: normalizedNumero, dateModification: timestamp },
    { merge: true },
  );

  items[itemIndex] = {
    ...items[itemIndex],
    numero: normalizedNumero,
    dateModification: timestamp,
  };
  sortState();
  await appendHistoryEntry(`a modifié ${currentNumero || 'OUT inconnu'} en ${normalizedNumero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true };
}

async function removeItem(siteId, itemId) {
  const items = state.itemsBySite.get(siteId) || [];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    return null;
  }

  const itemToRemove = items[itemIndex];
  const profile = await getCurrentUserProfile();
  const currentUserId = String(state.userId || profile?.id || '').trim();
  const creatorId = String(itemToRemove?.createdBy || itemToRemove?.ownerId || '').trim();
  const normalizedRole = normalizeRole(profile?.role);
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'standard' || isAdminEmail(profile?.email);
  const shouldCountDeletion = !isAdmin && (!currentUserId || !creatorId || currentUserId !== creatorId);
  if (shouldCountDeletion && await hasReachedOutDeletionLimit(currentUserId)) {
    return { limitReached: true };
  }

  await deleteDoc(doc(state.db, 'pages', 'page2', 'items', itemId));

  const [item] = items.splice(itemIndex, 1);
  const detailsKey = `${siteId}:${itemId}`;
  const details = clone(state.detailsByItem.get(detailsKey) || []);
  state.detailsByItem.delete(detailsKey);
  if (shouldCountDeletion) {
    await recordOutDeletionLimitUsage(currentUserId);
  }

  await appendHistoryEntry(`a supprimé ${item.numero}`, { siteId });
  persistOfflineState();
  emitAll();
  return { item: clone(item), details };
}

async function restoreSite(snapshot) {
  const site = snapshot?.site;
  if (!site?.id) {
    return false;
  }

  try {
    const createdSite = await addDoc(makePageItemsCollection('page1'), withoutId(site));
    const nextSite = { ...clone(site), id: createdSite.id };
    const itemIdMap = new Map();
    const restoredItems = [];

    for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
      const itemPayload = { ...withoutId(item), siteId: nextSite.id };
      const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
      const nextItem = { ...itemPayload, id: createdItem.id };
      itemIdMap.set(item.id, nextItem.id);
      restoredItems.push(nextItem);
    }

    const restoredDetails = [];
    for (const detail of Array.isArray(snapshot.details) ? snapshot.details : []) {
      const nextItemId = itemIdMap.get(detail.itemId);
      if (!nextItemId) {
        continue;
      }
      const detailPayload = { ...withoutId(detail), siteId: nextSite.id, itemId: nextItemId };
      const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
      restoredDetails.push({ ...detailPayload, id: createdDetail.id });
    }

    state.sites.unshift(nextSite);
    restoredItems.forEach((item) => {
      if (!state.itemsBySite.has(item.siteId)) {
        state.itemsBySite.set(item.siteId, []);
      }
      state.itemsBySite.get(item.siteId).push(item);
    });
    restoredDetails.forEach((detail) => {
      const key = `${detail.siteId}:${detail.itemId}`;
      if (!state.detailsByItem.has(key)) {
        state.detailsByItem.set(key, []);
      }
      state.detailsByItem.get(key).push(detail);
    });
  } catch (_error) {
    return false;
  }

  persistOfflineState();
  emitAll();
  return true;
}

async function restoreItem(snapshot) {
  const item = snapshot?.item;
  if (!item?.id || !item.siteId) {
    return false;
  }

  try {
    const itemPayload = { ...withoutId(item) };
    const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
    const nextItem = { ...itemPayload, id: createdItem.id };
    if (!state.itemsBySite.has(nextItem.siteId)) {
      state.itemsBySite.set(nextItem.siteId, []);
    }
    state.itemsBySite.get(nextItem.siteId).push(nextItem);

    for (const detail of Array.isArray(snapshot.details) ? snapshot.details : []) {
      const detailPayload = {
        ...withoutId(detail),
        siteId: nextItem.siteId,
        itemId: nextItem.id,
      };
      const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
      const nextDetail = { ...detailPayload, id: createdDetail.id };
      const key = `${nextDetail.siteId}:${nextDetail.itemId}`;
      if (!state.detailsByItem.has(key)) {
        state.detailsByItem.set(key, []);
      }
      state.detailsByItem.get(key).push(nextDetail);
    }
  } catch (_error) {
    return false;
  }

  persistOfflineState();
  emitAll();
  return true;
}

async function createDetail(siteId, itemId, payload) {
  const designation = sanitizeText(payload.designation, true);
  if (!designation) {
    return { ok: false, reason: 'invalid_designation' };
  }
  if (isDuplicateDetailDesignation(siteId, itemId, designation)) {
    return { ok: false, reason: 'duplicate_designation' };
  }

  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const timestamp = nowIso();
  const detailPayload = {
    siteId,
    itemId,
    champ: details.length + 1,
    code: sanitizeText(payload.code, true),
    designation,
    qteSortie: payload.qteSortie === '' ? '' : sanitizeNumber(payload.qteSortie),
    unite: sanitizeText(payload.unite || 'm', false) || 'm',
    qteHorsBtrs: '',
    qteRetour: 0,
    dateRetour: '',
    qtePosee: 0,
    qteRebus: 0,
    observation: '',
    statut: sanitizeDetailStatut(payload.statut),
    ownerId: state.userId,
    createdBy: state.userId,
    dateCreation: timestamp,
    dateModification: timestamp,
  };
  const created = await addDoc(makePageItemsCollection('page3'), detailPayload);
  const detail = { id: created.id, ...detailPayload };

  if (!state.detailsByItem.has(detailsKey)) {
    state.detailsByItem.set(detailsKey, []);
  }
  state.detailsByItem.get(detailsKey).push(detail);

  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a ajouté des articles dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return { ok: true, id: detail.id };
}

async function updateDetail(siteId, itemId, detailId, changes) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const target = details.find((detail) => detail.id === detailId);
  if (!target) {
    return null;
  }

  const syncedChanges = {};
  const nextValues = {};
  if ('code' in changes) {
    nextValues.code = sanitizeText(changes.code, true);
    syncedChanges.code = nextValues.code;
  }
  if ('designation' in changes) {
    nextValues.designation = sanitizeText(changes.designation, false);
    syncedChanges.designation = nextValues.designation;
  }
  if ('qteSortie' in changes) {
    nextValues.qteSortie = sanitizeNumber(changes.qteSortie);
    syncedChanges.qteSortie = nextValues.qteSortie;
  }
  if ('unite' in changes) {
    nextValues.unite = sanitizeText(changes.unite, false) || 'm';
    syncedChanges.unite = nextValues.unite;
  }
  if ('qteRetour' in changes) {
    nextValues.qteRetour = sanitizeNumber(changes.qteRetour);
    syncedChanges.qteRetour = nextValues.qteRetour;
  }
  if ('qtePosee' in changes) {
    nextValues.qtePosee = sanitizeNumber(changes.qtePosee);
    syncedChanges.qtePosee = nextValues.qtePosee;
  }
  if ('qteRebus' in changes) {
    nextValues.qteRebus = sanitizeNumber(changes.qteRebus);
    syncedChanges.qteRebus = nextValues.qteRebus;
  }
  if ('observation' in changes) {
    nextValues.observation = sanitizeText(changes.observation, false);
    syncedChanges.observation = nextValues.observation;
  }
  if ('dateRetour' in changes) {
    nextValues.dateRetour = sanitizeReturnDate(changes.dateRetour);
    syncedChanges.dateRetour = nextValues.dateRetour;
  }
  if ('statut' in changes) {
    nextValues.statut = sanitizeDetailStatut(changes.statut);
    syncedChanges.statut = nextValues.statut;
  }
  nextValues.dateModification = nowIso();
  syncedChanges.dateModification = nextValues.dateModification;

  await updateDoc(doc(state.db, 'pages', 'page3', 'items', detailId), syncedChanges);
  Object.assign(target, nextValues);
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a modifié un article dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return true;
}

async function removeDetail(siteId, itemId, detailId) {
  const detailsKey = `${siteId}:${itemId}`;
  const details = state.detailsByItem.get(detailsKey) || [];
  const detailIndex = details.findIndex((detail) => detail.id === detailId);
  if (detailIndex === -1) {
    return false;
  }

  await deleteDoc(doc(state.db, 'pages', 'page3', 'items', detailId));
  details.splice(detailIndex, 1);
  const item = getItem(siteId, itemId);
  await appendHistoryEntry(`a supprimé un article dans ${item?.numero || 'OUT inconnu'}`, { siteId });
  persistOfflineState();
  emitAll();
  return true;
}

function resolveSiteNameForHistory(siteId, fallbackName = '') {
  const explicitName = sanitizeText(fallbackName, false);
  if (explicitName) {
    return explicitName;
  }
  const normalizedSiteId = sanitizeText(siteId, false);
  if (!normalizedSiteId) {
    return '';
  }
  return sanitizeText(state.sites.find((site) => site.id === normalizedSiteId)?.nom, false);
}

async function appendHistoryEntry(actionText, context = {}) {
  const action = sanitizeText(actionText, false);
  if (!action) {
    return;
  }
  try {
    const profile = await getCurrentUserProfile();
    if (normalizeRole(profile?.role) === 'admin') {
      return;
    }

    const username = normalizeUsername(profile?.username) || normalizeUsername(state.authUser?.displayName) || 'Utilisateur inconnu';
    const siteId = sanitizeText(context?.siteId, false);
    const siteName = resolveSiteNameForHistory(siteId, context?.siteName);
    await addDoc(historyCollection(), {
      userId: profile?.id || state.userId || null,
      userName: username,
      action,
      siteId: siteId || null,
      siteName: siteName || null,
      createdAt: serverTimestamp(),
    });
    await pruneHistoryEntries();
  } catch (_error) {
    // L'historique ne doit pas bloquer l'action principale.
  } finally {
    recordCurrentUserActivity().catch(() => {});
  }
}

async function pruneHistoryEntries() {
  const snapshot = await getDocs(query(historyCollection(), orderBy('createdAt', 'desc')));
  if (snapshot.size <= 100) {
    return;
  }

  const docsToDelete = snapshot.docs.slice(100);
  await Promise.all(docsToDelete.map((historyDoc) => deleteDoc(historyDoc.ref)));
}

function normalizeHistoryDocument(snap) {
  const data = snap.data() || {};
  return {
    id: snap.id,
    userId: sanitizeText(data.userId, false),
    userName: normalizeUsername(data.userName) || 'Utilisateur inconnu',
    action: sanitizeText(data.action, false),
    siteId: sanitizeText(data.siteId, false),
    siteName: resolveSiteNameForHistory(data.siteId, data.siteName),
    createdAt: data.createdAt || null,
  };
}

async function recordSearchHistory(searchText, context = {}) {
  const queryText = sanitizeText(searchText, false);
  if (!queryText) {
    return;
  }
  await appendHistoryEntry(`a recherché « ${queryText} »`, context);
}

async function recordFilterHistory(filterName, context = {}) {
  const label = sanitizeText(filterName, false);
  if (!label) {
    return;
  }
  await appendHistoryEntry(`a appliqué le filtre « ${label} »`, context);
}

async function recordMaterialsPageOpenHistory() {
  await appendHistoryEntry('a cliqué sur « Demande matériels ».');
}

async function listHistoriques() {
  const snapshot = await getDocs(query(historyCollection(), orderBy('createdAt', 'desc')));
  return snapshot.docs.map(normalizeHistoryDocument);
}

function subscribeHistoriques(onChange, onError) {
  return onSnapshot(
    query(historyCollection(), orderBy('createdAt', 'desc')),
    (snapshot) => {
      onChange(snapshot.docs.map(normalizeHistoryDocument));
    },
    onError,
  );
}

function exportData() {
  const items = [];
  state.itemsBySite.forEach((siteItems) => {
    items.push(...siteItems);
  });
  const details = [];
  state.detailsByItem.forEach((itemDetails) => {
    details.push(...itemDetails);
  });

  return {
    format: 'suivi-materiel-export',
    version: 2,
    exportedAt: nowIso(),
    pages: {
      page1: clone(state.sites),
      page2: clone(items),
      page3: clone(details),
    },
  };
}

function normalizeImportPayload(payload) {
  if (!payload) {
    return null;
  }

  if (payload.pages && typeof payload.pages === 'object') {
    return {
      page1: Array.isArray(payload.pages.page1) ? payload.pages.page1 : [],
      page2: Array.isArray(payload.pages.page2) ? payload.pages.page2 : [],
      page3: Array.isArray(payload.pages.page3) ? payload.pages.page3 : [],
    };
  }

  const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!source) {
    return null;
  }

  const page1 = [];
  const page2 = [];
  const page3 = [];

  source.forEach((site) => {
    const siteId = uid();
    page1.push({
      id: siteId,
      nom: sanitizeText(site.nom, true),
      ownerId: state.userId,
      createdBy: state.userId,
      dateCreation: site.dateCreation || nowIso(),
      dateModification: site.dateModification || site.dateCreation || nowIso(),
      importedAt: nowIso(),
    });

    (site.items || []).forEach((item) => {
      const itemId = uid();
      page2.push({
        id: itemId,
        siteId,
        numero: sanitizeText(item.numero, true),
        ownerId: state.userId,
        createdBy: state.userId,
        dateCreation: item.dateCreation || nowIso(),
        dateModification: item.dateModification || item.dateCreation || nowIso(),
        importedAt: nowIso(),
      });

      (item.details || []).forEach((detail, index) => {
        page3.push({
          id: uid(),
          siteId,
          itemId,
          champ: Number(detail.champ) || index + 1,
          code: sanitizeText(detail.code, true),
          designation: sanitizeText(detail.designation, true),
          qteSortie: sanitizeNumber(detail.qteSortie),
          unite: sanitizeText(detail.unite || 'm', false) || 'm',
          qteHorsBtrs: '',
          qteRetour: sanitizeNumber(detail.qteRetour),
          dateRetour: sanitizeReturnDate(detail.dateRetour),
          qtePosee: sanitizeNumber(detail.qtePosee),
          qteRebus: sanitizeNumber(detail.qteRebus),
          observation: sanitizeText(detail.observation, false),
          statut: sanitizeDetailStatut(detail.statut),
          ownerId: state.userId,
          createdBy: state.userId,
          dateCreation: detail.dateCreation || nowIso(),
          dateModification: detail.dateModification || detail.dateCreation || nowIso(),
          importedAt: nowIso(),
        });
      });
    });
  });

  return { page1, page2, page3 };
}

async function importData(payload) {
  const normalized = normalizeImportPayload(payload);
  if (!normalized) {
    return false;
  }
  const siteIdMap = new Map();
  const itemIdMap = new Map();
  const addedSites = [];
  const addedItems = [];
  const addedDetails = [];

  for (const site of normalized.page1) {
    const localId = sanitizeText(site.id || uid(), false) || uid();
    const sitePayload = { ...site };
    delete sitePayload.id;
    const createdSite = await addDoc(makePageItemsCollection('page1'), sitePayload);
    const nextSite = { id: createdSite.id, ...sitePayload };
    siteIdMap.set(localId, nextSite.id);
    addedSites.push(nextSite);
  }

  for (const item of normalized.page2) {
    const localId = sanitizeText(item.id || uid(), false) || uid();
    const originalSiteId = sanitizeText(item.siteId || '', false);
    const mappedSiteId = siteIdMap.get(originalSiteId) || originalSiteId;
    if (!mappedSiteId) {
      continue;
    }
    const itemPayload = { ...item, siteId: mappedSiteId };
    delete itemPayload.id;
    const createdItem = await addDoc(makePageItemsCollection('page2'), itemPayload);
    const nextItem = { id: createdItem.id, ...itemPayload };
    itemIdMap.set(localId, nextItem.id);
    addedItems.push(nextItem);
  }

  for (const detail of normalized.page3) {
    const originalSiteId = sanitizeText(detail.siteId || '', false);
    const originalItemId = sanitizeText(detail.itemId || '', false);
    const mappedSiteId = siteIdMap.get(originalSiteId) || originalSiteId;
    const mappedItemId = itemIdMap.get(originalItemId) || originalItemId;
    if (!mappedSiteId || !mappedItemId) {
      continue;
    }
    const detailPayload = { ...detail, siteId: mappedSiteId, itemId: mappedItemId };
    delete detailPayload.id;
    const createdDetail = await addDoc(makePageItemsCollection('page3'), detailPayload);
    addedDetails.push({ id: createdDetail.id, ...detailPayload });
  }

  state.sites.push(...addedSites);

  addedItems.forEach((item) => {
    if (!state.itemsBySite.has(item.siteId)) {
      state.itemsBySite.set(item.siteId, []);
    }
    state.itemsBySite.get(item.siteId).push(item);
  });

  addedDetails.forEach((detail) => {
    const detailsKey = `${detail.siteId}:${detail.itemId}`;
    if (!state.detailsByItem.has(detailsKey)) {
      state.detailsByItem.set(detailsKey, []);
    }
    state.detailsByItem.get(detailsKey).push(detail);
  });

  sortState();
  persistOfflineState();
  emitAll();
  return true;
}

window.StorageService = {
  init,
  getSites,
  getSiteInactivityThresholdDays,
  isSitePendingInactivityDecision,
  refreshSiteInactivityStates,
  listInactiveSitesForCurrentCreator,
  restoreInactiveSite,
  getSite,
  getItem,
  subscribeSites,
  subscribeItems,
  subscribeItemCounts,
  subscribeDetails,
  subscribeDetailCounts,
  subscribeDetailDesignations,
  subscribeDetailRows,
  getDetailRowsBySite,
  getAllDetails,
  createSite,
  updateSiteName,
  updateSiteCreator,
  setSiteLock,
  clearSiteLock,
  getSiteUnlockProtectionState,
  registerSiteUnlockFailure,
  resetSiteUnlockProtection,
  removeSite,
  restoreSite,
  createItem,
  updateItemName,
  removeItem,
  restoreItem,
  createDetail,
  updateDetail,
  removeDetail,
  recordSiteUnlockHistory,
  recordSiteUnlockFailureHistory,
  recordExcelExportHistory,
  exportData,
  importData,
  ensureCurrentUser,
  getCurrentUserProfile,
  saveUsername,
  changeUsername,
  updateAvatarUrl,
  listUsers,
  subscribeUsers,
  listOutCreationPoints,
  subscribeOutCreationPoints,
  updateUserRole,
  updateUserMaintenanceAccess,
  deleteUser,
  cleanupInactiveUsers,
  recordCurrentUserActivity,
  setMaintenanceState,
  subscribeMaintenanceState,
  subscribeCurrentUserProfile,
  computeNextNameChangeDate,
  recordSearchHistory,
  recordFilterHistory,
  recordMaterialsPageOpenHistory,
  listHistoriques,
  subscribeHistoriques,
  getAuthUser: () => clone(state.authUser),
};
