import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAdditionalUserInfo,
  fetchSignInMethodsForEmail,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { firebaseAuth } from './firebase-core.js';

const auth = firebaseAuth;
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const STORAGE_KEY = 'suiviMateriel.loginMemo.v1';
const GOOGLE_WELCOME_KEY = 'suiviMateriel.googleWelcome.v1';
let googleSignInPending = false;

function isInAppBrowser() {
  return /FBAN|FBAV|Instagram|Messenger|WhatsApp/i.test(navigator.userAgent);
}

function showInAppBrowserWarning() {
  if (!isInAppBrowser()) {
    return '';
  }

  return 'Pour une connexion Google plus fiable, ouvrez cette page dans votre navigateur principal (Chrome, Safari, etc.).';
}

const authReadyPromise = setPersistence(auth, browserLocalPersistence)
  .then(() => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        const authPayload = {
          uid: user.uid || '',
          displayName: user.displayName || '',
          email: user.email || '',
          photoURL: user.photoURL || '',
        };
        localStorage.setItem('suiviMateriel.authUser.v1', JSON.stringify(authPayload));
        if (!googleSignInPending) {
          window.location.replace('index.html');
        }
      }
    });
  })
  .catch(() => {
    globalError.textContent = 'Une erreur est survenue lors de la préparation de la connexion. Veuillez réessayer.';
  });

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('loginEmail');
const passwordInput = document.getElementById('loginPassword');
const togglePasswordButton = document.getElementById('togglePasswordButton');
const togglePasswordIcon = document.getElementById('togglePasswordIcon');
const emailError = document.getElementById('emailError');
const passwordError = document.getElementById('passwordError');
const globalError = document.getElementById('globalError');
const emailLoginButton = document.getElementById('emailLoginButton');
const googleLoginButton = document.getElementById('googleLoginButton');

const inAppBrowserWarning = showInAppBrowserWarning();
if (inAppBrowserWarning) {
  globalError.textContent = inAppBrowserWarning;
}

let lastEmailCheckId = 0;
let isAuthInProgress = false;
const fieldErrorTimers = new Map();
const fieldStateTimers = new Map();

function redirectToHome() {
  window.location.replace('index.html');
}

function mapGoogleAuthError(error) {
  const code = String(error?.code || '');

  if (code.includes('auth/popup-blocked')) {
    return 'Le navigateur a bloqué la fenêtre de connexion Google. Réessayez dans Chrome ou autorisez les popups.';
  }
  if (code.includes('auth/popup-closed-by-user')) {
    return 'Connexion Google annulée : la popup a été fermée avant la validation.';
  }
  if (code.includes('auth/cancelled-popup-request')) {
    return 'Une autre tentative de connexion popup est déjà en cours.';
  }
  if (code.includes('auth/network-request-failed')) {
    return 'Connexion réseau impossible. Vérifiez Internet puis réessayez.';
  }

  return 'Connexion Google impossible pour le moment. Réessayez.';
}

function setLoading(isLoading, sourceButton = emailLoginButton) {
  emailLoginButton.disabled = isLoading;
  googleLoginButton.disabled = isLoading;
  emailLoginButton.setAttribute('aria-busy', String(isLoading));
  googleLoginButton.setAttribute('aria-busy', String(isLoading));
  sourceButton?.classList.toggle('is-loading', isLoading);
  if (sourceButton) {
    const labelElement = sourceButton.querySelector('.btn__label');
    if (labelElement) {
      const defaultLabel = sourceButton.dataset.defaultLabel || labelElement.textContent || '';
      sourceButton.dataset.defaultLabel = defaultLabel;
      if (isLoading && sourceButton === emailLoginButton) {
        labelElement.textContent = 'Connexion…';
      } else {
        labelElement.textContent = defaultLabel;
      }
    }
  }
}

function saveGoogleWelcomePayload(result) {
  const user = result?.user;
  if (!user) {
    return;
  }

  const additionalUserInfo = getAdditionalUserInfo(result);
  const payload = {
    source: 'google',
    uid: user.uid || '',
    displayName: user.displayName || '',
    email: user.email || '',
    isNewUser: Boolean(additionalUserInfo?.isNewUser),
    createdAt: Date.now(),
  };
  sessionStorage.setItem(GOOGLE_WELCOME_KEY, JSON.stringify(payload));
}

async function startGoogleSignIn() {
  await authReadyPromise;
  // signInWithRedirect est évité ici car le projet est hébergé sur GitHub Pages et non sur Firebase Hosting.
  googleSignInPending = true;
  try {
    const result = await signInWithPopup(auth, provider);
    saveGoogleWelcomePayload(result);
    window.location.replace('index.html');
  } catch (error) {
    googleSignInPending = false;
    throw error;
  }
}

function encodeMemo(email, password) {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ email, password }))));
}

function decodeMemo(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(escape(atob(raw))));
  } catch (_error) {
    return null;
  }
}

function saveCredentials(email, password) {
  localStorage.setItem(STORAGE_KEY, encodeMemo(email, password));
}

function applyMemoIfAny() {
  const memo = decodeMemo(localStorage.getItem(STORAGE_KEY));
  if (!memo) {
    return;
  }
  if (!emailInput.value) {
    emailInput.value = memo.email || '';
  }
  if (!passwordInput.value) {
    passwordInput.value = memo.password || '';
  }
}

function isEmailFormatValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function validateEmailRealtime() {
  const email = emailInput.value.trim();

  if (!email) {
    showFieldError(emailInput, emailError, 'Email requis.');
    return false;
  }
  if (!isEmailFormatValid(email)) {
    showFieldError(emailInput, emailError, 'Format email invalide.');
    return false;
  }

  const requestId = ++lastEmailCheckId;
  try {
    const methods = await fetchSignInMethodsForEmail(auth, email);
    if (requestId !== lastEmailCheckId) {
      return false;
    }
    if (!methods.length) {
      showFieldError(emailInput, emailError, 'Email inexistant.');
      return false;
    }
  } catch (_error) {
    showFieldError(emailInput, emailError, 'Vérification email indisponible.');
    return false;
  }
  return true;
}

function validatePasswordRealtime() {
  const password = passwordInput.value;
  if (!password) {
    showFieldError(passwordInput, passwordError, 'Mot de passe requis.');
    return false;
  }
  if (password.length < 6) {
    showFieldError(passwordInput, passwordError, 'Mot de passe trop court (minimum 6 caractères).');
    return false;
  }
  return true;
}

function clearFieldError(errorElement) {
  const timer = fieldErrorTimers.get(errorElement);
  if (timer) {
    window.clearTimeout(timer);
    fieldErrorTimers.delete(errorElement);
  }
  errorElement.textContent = '';
}

function clearFieldState(inputElement, errorElement) {
  clearFieldError(errorElement);
  const timer = fieldStateTimers.get(inputElement);
  if (timer) {
    window.clearTimeout(timer);
    fieldStateTimers.delete(inputElement);
  }
  inputElement.classList.remove('is-error', 'is-shaking');
}

function showFieldError(inputElement, errorElement, message, durationMs = 2300) {
  clearFieldState(inputElement, errorElement);
  errorElement.textContent = message;
  const errorTimer = window.setTimeout(() => {
    errorElement.textContent = '';
    fieldErrorTimers.delete(errorElement);
  }, durationMs);
  fieldErrorTimers.set(errorElement, errorTimer);

  inputElement.classList.remove('is-shaking');
  void inputElement.offsetWidth;
  inputElement.classList.add('is-error', 'is-shaking');
  const stateTimer = window.setTimeout(() => {
    inputElement.classList.remove('is-error', 'is-shaking');
    fieldStateTimers.delete(inputElement);
  }, durationMs);
  fieldStateTimers.set(inputElement, stateTimer);
}

emailInput.addEventListener('focus', applyMemoIfAny);
passwordInput.addEventListener('focus', applyMemoIfAny);
emailInput.addEventListener('input', () => {
  globalError.textContent = '';
  clearFieldState(emailInput, emailError);
});
passwordInput.addEventListener('input', () => {
  globalError.textContent = '';
  clearFieldState(passwordInput, passwordError);
});

togglePasswordButton.addEventListener('click', () => {
  const nextIsVisible = passwordInput.type === 'password';
  passwordInput.type = nextIsVisible ? 'text' : 'password';
  togglePasswordIcon.src = nextIsVisible ? 'Icon/Eye_ON.png' : 'Icon/Eye_OFF.png';
  togglePasswordButton.setAttribute('aria-label', nextIsVisible ? 'Cacher le mot de passe' : 'Afficher le mot de passe');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isAuthInProgress) {
    return;
  }
  isAuthInProgress = true;
  globalError.textContent = '';

  const isEmailValid = await validateEmailRealtime();
  const isPasswordValid = validatePasswordRealtime();
  if (!isEmailValid || !isPasswordValid) {
    isAuthInProgress = false;
    return;
  }

  setLoading(true, emailLoginButton);
  try {
    await authReadyPromise;
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
    saveCredentials(emailInput.value.trim(), passwordInput.value);
  } catch (error) {
    const code = String(error?.code || '');
    if (code.includes('wrong-password') || code.includes('invalid-credential')) {
      showFieldError(passwordInput, passwordError, 'Mot de passe incorrect.');
    } else if (code.includes('user-not-found')) {
      showFieldError(emailInput, emailError, 'Email inexistant.');
    } else {
      globalError.textContent = 'Connexion impossible. Veuillez réessayer.';
    }
  } finally {
    isAuthInProgress = false;
    setLoading(false, emailLoginButton);
  }
});

googleLoginButton.addEventListener('click', async () => {
  if (isAuthInProgress) {
    return;
  }

  isAuthInProgress = true;
  globalError.textContent = '';
  setLoading(true, googleLoginButton);
  try {
    await startGoogleSignIn();
  } catch (error) {
    globalError.textContent = mapGoogleAuthError(error);
    isAuthInProgress = false;
    setLoading(false, googleLoginButton);
    return;
  }

  isAuthInProgress = false;
  setLoading(false, googleLoginButton);
});
