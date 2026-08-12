import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { arrayUnion, collection, doc, limit, onSnapshot, orderBy, query, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseAuth, firebaseDb } from './firebase-core.js';
import { replaceVariables } from './message-variables.js';

const MAINTENANCE_MODAL_ID = 'globalMaintenanceModal';
const MAINTENANCE_STYLE_ID = 'globalMaintenanceModalStyles';
const MAINTENANCE_DOC_REF = doc(firebaseDb, 'appSettings', 'maintenance');
const PRIMARY_ADMIN_EMAIL = 'andrainaaina@gmail.com';
const BODY_LOCK_CLASS = 'global-maintenance-modal-open';
const USER_MESSAGE_MODAL_ID = 'globalUserMessageModal';
const RECENT_USER_MESSAGES_LIMIT = 3;
const USER_MESSAGES_QUERY = query(collection(firebaseDb, 'adminMessages'), orderBy('createdAt', 'desc'), limit(RECENT_USER_MESSAGES_LIMIT));

let maintenanceEnabled = false;
let authResolved = false;
let currentUserIsAdmin = false;
let unsubscribeUserProfile = null;
let currentUser = null;
let currentUserProfile = null;
let userProfileResolved = false;
let pendingUserMessage = null;
let receivedUserMessages = [];
let modalVisible = false;
let blockedSiblings = [];
let activeModalId = null;

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function isPrimaryAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === PRIMARY_ADMIN_EMAIL;
}

function resolveIsAdmin(profile, authUser) {
  const username = String(profile?.username || profile?.name || '').trim();
  const role = normalizeRole(profile?.role);
  return username === 'Admin' || role === 'admin' || role === 'standard' || role === 'adjoint' || role === 'adjoint admin' || isPrimaryAdminEmail(profile?.email || authUser?.email);
}

function ensureMaintenanceStyles() {
  if (document.getElementById(MAINTENANCE_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = MAINTENANCE_STYLE_ID;
  style.textContent = `
    body.${BODY_LOCK_CLASS} {
      overflow: hidden !important;
      touch-action: none;
    }

    .global-maintenance-modal {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: clamp(1rem, 4vw, 2rem);
      background: rgba(2, 6, 23, 0.68);
      backdrop-filter: blur(2px);
      overscroll-behavior: contain;
      animation: globalMaintenanceOverlayIn 180ms ease-out both;
    }

    .global-maintenance-modal[hidden] {
      display: none !important;
    }

    .global-maintenance-modal__dialog {
      width: min(100%, 30rem);
      border-radius: 1.35rem;
      background: #ffffff;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
      padding: clamp(1.35rem, 5vw, 2.1rem);
      text-align: center;
      color: #0f172a;
      animation: globalMaintenanceDialogIn 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    .global-maintenance-modal__icon {
      display: inline-grid;
      place-items: center;
      width: clamp(3rem, 12vw, 4rem);
      height: clamp(3rem, 12vw, 4rem);
      margin: 0 auto 0.9rem;
      border-radius: 999px;
      background: #fff7ed;
      font-size: clamp(1.65rem, 7vw, 2.2rem);
      line-height: 1;
    }

    .global-maintenance-modal__title {
      margin: 0 0 0.85rem;
      font-size: clamp(1.35rem, 5vw, 1.75rem);
      line-height: 1.2;
      font-weight: 800;
      color: #111827;
    }

    .global-maintenance-modal__message {
      margin: 0;
      color: #374151;
      font-size: clamp(0.98rem, 3.5vw, 1.08rem);
      font-weight: 600;
      line-height: 1.65;
    }

    .global-maintenance-modal__actions {
      display: flex;
      justify-content: center;
      margin-top: 1.35rem;
    }

    .global-maintenance-modal__button {
      min-width: 7rem;
      border: 0;
      border-radius: 999px;
      padding: 0.75rem 1.4rem;
      background: #2563eb;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.25);
      transition: transform 160ms ease, box-shadow 160ms ease;
    }

    .global-maintenance-modal__button:focus-visible {
      outline: 3px solid rgba(37, 99, 235, 0.32);
      outline-offset: 3px;
    }

    .global-maintenance-modal__button:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 28px rgba(37, 99, 235, 0.3);
    }

    .global-maintenance-modal__message--preline {
      white-space: pre-line;
    }

    @keyframes globalMaintenanceOverlayIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes globalMaintenanceDialogIn {
      from {
        opacity: 0;
        transform: scale(0.94) translateY(0.5rem);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureMaintenanceModal() {
  const existingModal = document.getElementById(MAINTENANCE_MODAL_ID);
  if (existingModal) {
    return existingModal;
  }

  ensureMaintenanceStyles();

  const modal = document.createElement('section');
  modal.id = MAINTENANCE_MODAL_ID;
  modal.className = 'global-maintenance-modal';
  modal.hidden = true;
  modal.setAttribute('aria-labelledby', 'globalMaintenanceTitle');
  modal.setAttribute('aria-describedby', 'globalMaintenanceDescription');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('tabindex', '-1');
  modal.innerHTML = `
    <article class="global-maintenance-modal__dialog">
      <div class="global-maintenance-modal__icon" aria-hidden="true">🔧</div>
      <h2 id="globalMaintenanceTitle" class="global-maintenance-modal__title">🔧 Maintenance en cours</h2>
      <p id="globalMaintenanceDescription" class="global-maintenance-modal__message">
        La plateforme est actuellement en cours de maintenance.<br />
        Certaines fonctionnalités sont temporairement indisponibles.<br />
        Veuillez patienter quelques instants.<br />
        Nous vous remercions de votre compréhension.
      </p>
    </article>
  `;

  modal.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
  modal.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
  document.body.appendChild(modal);
  return modal;
}

function ensureUserMessageModal() {
  const existingModal = document.getElementById(USER_MESSAGE_MODAL_ID);
  if (existingModal) {
    return existingModal;
  }

  ensureMaintenanceStyles();

  const modal = document.createElement('section');
  modal.id = USER_MESSAGE_MODAL_ID;
  modal.className = 'global-maintenance-modal';
  modal.hidden = true;
  modal.setAttribute('aria-labelledby', 'globalUserMessageTitle');
  modal.setAttribute('aria-describedby', 'globalUserMessageBody');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('tabindex', '-1');
  modal.innerHTML = `
    <article class="global-maintenance-modal__dialog">
      <div class="global-maintenance-modal__icon" aria-hidden="true">📢</div>
      <h2 id="globalUserMessageTitle" class="global-maintenance-modal__title"></h2>
      <p id="globalUserMessageBody" class="global-maintenance-modal__message global-maintenance-modal__message--preline"></p>
      <div class="global-maintenance-modal__actions">
        <button id="globalUserMessageOk" class="global-maintenance-modal__button" type="button">OK</button>
      </div>
    </article>
  `;

  modal.querySelector('#globalUserMessageOk')?.addEventListener('click', acknowledgeCurrentUserMessage);
  modal.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
  modal.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
  document.body.appendChild(modal);
  return modal;
}

function setPageBlocked(modal, shouldBlock) {
  if (!shouldBlock && activeModalId !== modal.id) {
    return;
  }

  if (modalVisible === shouldBlock && activeModalId === modal.id) {
    return;
  }

  modalVisible = shouldBlock;
  activeModalId = shouldBlock ? modal.id : null;
  document.body.classList.toggle(BODY_LOCK_CLASS, shouldBlock);

  if (shouldBlock) {
    blockedSiblings.forEach((child) => {
      child.removeAttribute('aria-hidden');
      if ('inert' in child) {
        child.inert = false;
      }
    });
    blockedSiblings = Array.from(document.body.children).filter((child) => child !== modal);
    blockedSiblings.forEach((child) => {
      child.setAttribute('aria-hidden', 'true');
      if ('inert' in child) {
        child.inert = true;
      }
    });
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    modal.focus({ preventScroll: true });
    return;
  }

  blockedSiblings.forEach((child) => {
    child.removeAttribute('aria-hidden');
    if ('inert' in child) {
      child.inert = false;
    }
  });
  blockedSiblings = [];
}

function renderMaintenanceModal() {
  const modal = ensureMaintenanceModal();
  const shouldShow = authResolved && maintenanceEnabled && !currentUserIsAdmin;
  modal.hidden = !shouldShow;
  setPageBlocked(modal, shouldShow);
}

function getReadMessages(profile) {
  return Array.isArray(profile?.readMessages) ? profile.readMessages.map((id) => String(id)) : [];
}

function isMessageForCurrentUser(message) {
  if (!currentUser?.uid) {
    return false;
  }
  const recipientIds = Array.isArray(message?.recipientIds) ? message.recipientIds.map((id) => String(id)) : [];
  if (message?.recipientMode === 'selected' || recipientIds.length > 0) {
    return recipientIds.includes(currentUser.uid);
  }
  return true;
}

function renderUserMessageModal() {
  const modal = ensureUserMessageModal();
  const shouldShow = authResolved && currentUser && userProfileResolved && !currentUserIsAdmin && pendingUserMessage;
  modal.hidden = !shouldShow;

  if (shouldShow) {
    const recipient = {
      ...(currentUserProfile || {}),
      id: currentUser.uid,
      uid: currentUser.uid,
      email: currentUserProfile?.email || currentUser.email,
      displayName: currentUserProfile?.displayName || currentUser.displayName,
    };
    modal.querySelector('#globalUserMessageTitle').textContent = replaceVariables(pendingUserMessage.title || 'Message', recipient);
    modal.querySelector('#globalUserMessageBody').textContent = replaceVariables(pendingUserMessage.body || '', recipient);
    setPageBlocked(modal, true);
  } else {
    setPageBlocked(modal, false);
  }
}

function choosePendingUserMessage(messages) {
  receivedUserMessages = messages.slice(0, RECENT_USER_MESSAGES_LIMIT);
  if (!currentUser || !userProfileResolved || currentUserIsAdmin) {
    pendingUserMessage = null;
    renderUserMessageModal();
    return;
  }

  const readMessages = getReadMessages(currentUserProfile);
  pendingUserMessage = receivedUserMessages.find((message) => isMessageForCurrentUser(message) && !readMessages.includes(message.id)) || null;
  renderUserMessageModal();
}

async function acknowledgeCurrentUserMessage() {
  if (!currentUser || !pendingUserMessage?.id) {
    pendingUserMessage = null;
    renderUserMessageModal();
    return;
  }

  const messageId = pendingUserMessage.id;
  pendingUserMessage = null;
  renderUserMessageModal();
  currentUserProfile = { ...(currentUserProfile || {}), readMessages: [...new Set([...getReadMessages(currentUserProfile), messageId])] };
  choosePendingUserMessage(receivedUserMessages);

  try {
    await setDoc(doc(firebaseDb, 'users', currentUser.uid), { readMessages: arrayUnion(messageId) }, { merge: true });
  } catch (_error) {
    // Keep the local dismissal for this session even if Firestore is temporarily unavailable.
  }
}

function clearUserProfileSubscription() {
  if (typeof unsubscribeUserProfile === 'function') {
    unsubscribeUserProfile();
  }
  unsubscribeUserProfile = null;
}

function subscribeToCurrentUserRole(user) {
  clearUserProfileSubscription();
  currentUser = user || null;
  currentUserProfile = null;
  userProfileResolved = false;
  pendingUserMessage = null;
  if (!user) {
    authResolved = true;
    currentUser = null;
    currentUserProfile = null;
    userProfileResolved = false;
    pendingUserMessage = null;
    currentUserIsAdmin = false;
    receivedUserMessages = [];
    renderMaintenanceModal();
    renderUserMessageModal();
    return;
  }

  currentUserIsAdmin = isPrimaryAdminEmail(user.email);
  authResolved = true;
  renderMaintenanceModal();
  choosePendingUserMessage(receivedUserMessages);

  unsubscribeUserProfile = onSnapshot(
    doc(firebaseDb, 'users', user.uid),
    (snapshot) => {
      currentUserProfile = snapshot.exists() ? snapshot.data() : null;
      userProfileResolved = true;
      currentUserIsAdmin = resolveIsAdmin(currentUserProfile, user);
      renderMaintenanceModal();
      choosePendingUserMessage(receivedUserMessages);
    },
    () => {
      userProfileResolved = true;
      currentUserIsAdmin = isPrimaryAdminEmail(user.email);
      renderMaintenanceModal();
      renderUserMessageModal();
    },
  );
}

function blockPageInteraction(event) {
  if (!modalVisible) {
    return;
  }

  const modal = document.getElementById(activeModalId || MAINTENANCE_MODAL_ID);
  if (event.type === 'keydown' || !modal?.contains(event.target)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function initGlobalMaintenanceModal() {
  ensureMaintenanceModal();
  ensureUserMessageModal();

  document.addEventListener('click', blockPageInteraction, true);
  document.addEventListener('keydown', blockPageInteraction, true);
  document.addEventListener('submit', blockPageInteraction, true);

  const unsubscribeMaintenance = onSnapshot(
    MAINTENANCE_DOC_REF,
    (snapshot) => {
      maintenanceEnabled = Boolean(snapshot.exists() && snapshot.data()?.enabled);
      renderMaintenanceModal();
    },
    () => {
      maintenanceEnabled = false;
      renderMaintenanceModal();
    },
  );

  const unsubscribeUserMessages = onSnapshot(
    USER_MESSAGES_QUERY,
    (snapshot) => {
      choosePendingUserMessage(snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() || {}) })));
    },
    () => {
      pendingUserMessage = null;
      renderUserMessageModal();
    },
  );

  const unsubscribeAuth = onAuthStateChanged(firebaseAuth, subscribeToCurrentUserRole, () => {
    clearUserProfileSubscription();
    authResolved = true;
    currentUser = null;
    currentUserProfile = null;
    userProfileResolved = false;
    pendingUserMessage = null;
    currentUserIsAdmin = false;
    receivedUserMessages = [];
    renderMaintenanceModal();
    renderUserMessageModal();
  });

  window.addEventListener('pagehide', () => {
    unsubscribeMaintenance();
    unsubscribeUserMessages();
    unsubscribeAuth();
    clearUserProfileSubscription();
  }, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGlobalMaintenanceModal, { once: true });
} else {
  initGlobalMaintenanceModal();
}
