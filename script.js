const API_BASE_URL = "https://back-end-serveur.onrender.com";

const API_ROUTES = {
  upload: "/upload",
  excelToJson: "/api/excel-to-json",
  download: (id) => `/download/${encodeURIComponent(id)}`,
};

const isIndexPage = Boolean(document.getElementById("uploadForm"));
const isDownloadPage = Boolean(document.getElementById("downloadInfo"));

if (isIndexPage) {
  setupUploadPage();
}

if (isDownloadPage) {
  setupDownloadPage();
}

function getApiUrl(route) {
  return `${API_BASE_URL}${route}`;
}

function normalizeApiUrl(url) {
  if (!url) return "";

  try {
    return new URL(url, API_BASE_URL).href;
  } catch (error) {
    console.error("URL API invalide :", error);
    return url;
  }
}

async function buildApiError(response, fallbackMessage = "Erreur lors de la communication avec le serveur.") {
  const serverMessage = await readErrorMessage(response);
  const details = serverMessage ? ` Détail : ${serverMessage}` : "";

  const messages = {
    400: `La requête est invalide.${details}`,
    401: `Vous devez être authentifié pour effectuer cette action.${details}`,
    403: `Vous n'êtes pas autorisé à effectuer cette action.${details}`,
    404: `La route API appelée est introuvable.${details}`,
    413: `Le fichier est trop volumineux pour être envoyé.${details}`,
    500: `Erreur interne du serveur.${details}`,
    502: `Le backend Render est temporairement indisponible.${details}`,
    503: `Le backend Render est indisponible ou en cours de démarrage.${details}`,
  };

  const message = messages[response.status] || `${fallbackMessage}${details}`;
  const error = new Error(message);
  error.status = response.status;
  error.statusText = response.statusText;
  return error;
}

async function readErrorMessage(response) {
  try {
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await response.json();
      return data?.message || data?.error || data?.details || "";
    }

    return await response.text();
  } catch (error) {
    console.error("Impossible de lire le détail de l'erreur API :", error);
    return "";
  }
}

function assertExpectedContentType(response, expectedContentType, errorMessage) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes(expectedContentType)) {
    throw new Error(errorMessage);
  }
}

function setupUploadPage() {
  const uploadForm = document.getElementById("uploadForm");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const selectedFile = document.getElementById("selectedFile");
  const uploadBtn = document.getElementById("uploadBtn");
  const statusMessage = document.getElementById("statusMessage");
  const result = document.getElementById("result");
  const downloadLink = document.getElementById("downloadLink");
  const copyBtn = document.getElementById("copyBtn");
  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const excelForm = document.getElementById("excelForm");
  const excelInput = document.getElementById("excelFile");
  const excelSelectedFile = document.getElementById("excelSelectedFile");
  const excelBtn = document.getElementById("excelBtn");
  const excelStatus = document.getElementById("excelStatus");

  let progressTimer = null;

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    selectedFile.textContent = file ? `Fichier sélectionné : ${file.name}` : "Aucun fichier sélectionné";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    selectedFile.textContent = `Fichier sélectionné : ${file.name}`;
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileInput.files?.[0];
    if (!file) {
      showStatus(statusMessage, "error", "Veuillez sélectionner un fichier avant l'envoi.");
      return;
    }

    result.classList.add("hidden");
    showStatus(statusMessage, "info", "Upload en cours...");
    uploadBtn.disabled = true;
    startFakeProgress(progressWrap, progressBar);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(getApiUrl(API_ROUTES.upload), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw await buildApiError(response, "Erreur pendant l'envoi du fichier.");
      }

      assertExpectedContentType(response, "application/json", "Le serveur n'a pas renvoyé une réponse JSON valide.");
      const data = await response.json();

      console.debug("Réponse brute du serveur:", data);

      const finalLink = normalizeApiUrl(data?.download_url || data?.downloadUrl || data?.url);
      if (!finalLink) {
        throw new Error("Le serveur n'a pas renvoyé de lien de téléchargement.");
      }

      showStatus(statusMessage, "success", "Upload terminé.");
      progressBar.style.width = "100%";
      downloadLink.href = finalLink;
      downloadLink.textContent = finalLink;
      result.classList.remove("hidden");
    } catch (error) {
      console.error("Erreur API upload :", error);
      showStatus(statusMessage, "error", error instanceof Error ? error.message : "Erreur inconnue pendant l'envoi.");
    } finally {
      uploadBtn.disabled = false;
      stopFakeProgress(progressWrap, progressBar, progressTimer);
      progressTimer = null;
    }
  });

  copyBtn.addEventListener("click", async () => {
    const link = downloadLink.textContent?.trim();
    if (!link) return;

    try {
      await navigator.clipboard.writeText(link);
      showStatus(statusMessage, "success", "Lien copié dans le presse-papiers.");
    } catch (error) {
      console.error("Erreur presse-papiers :", error);
      showStatus(statusMessage, "error", "Impossible de copier automatiquement le lien.");
    }
  });

  if (excelForm && excelInput && excelSelectedFile && excelBtn && excelStatus) {
    excelInput.addEventListener("change", () => {
      const file = excelInput.files?.[0];
      excelSelectedFile.textContent = file ? `Fichier sélectionné : ${file.name}` : "Aucun fichier sélectionné";
    });

    excelForm.addEventListener("submit", (event) => {
      event.preventDefault();
      convertExcel();
    });
  }

  function startFakeProgress(wrapper, bar) {
    wrapper.style.display = "block";
    bar.style.width = "6%";
    let value = 6;

    progressTimer = setInterval(() => {
      if (value >= 90) return;
      value += Math.random() * 12;
      bar.style.width = `${Math.min(value, 90)}%`;
    }, 300);
  }
}

async function convertExcel() {
  const fileInput = document.getElementById("excelFile");
  const excelBtn = document.getElementById("excelBtn");
  const excelStatus = document.getElementById("excelStatus");

  if (!fileInput || !excelBtn || !excelStatus) {
    return;
  }

  const file = fileInput.files?.[0];

  if (!file) {
    showStatus(excelStatus, "error", "Veuillez sélectionner un fichier Excel.");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  const initialButtonText = "Transformer en JSON";
  excelBtn.disabled = true;
  excelBtn.textContent = "Traitement en cours...";
  showStatus(excelStatus, "info", "Traitement en cours...");

  try {
    const response = await fetch(getApiUrl(API_ROUTES.excelToJson), {
      method: "POST",
      body: formData,
    });

    console.debug("Réponse conversion Excel :", response);

    if (!response.ok) {
      throw await buildApiError(response, "Erreur pendant la conversion Excel en JSON.");
    }

    const blob = await response.blob();
    if (!blob.size) {
      throw new Error("Le serveur a renvoyé un fichier JSON vide.");
    }

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "suggestions.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    showStatus(excelStatus, "success", "Téléchargement du JSON réussi.");
  } catch (error) {
    console.error("Erreur API Excel -> JSON :", error);
    showStatus(excelStatus, "error", error instanceof Error ? error.message : "Erreur inconnue pendant la conversion.");
  } finally {
    excelBtn.disabled = false;
    excelBtn.textContent = initialButtonText;
  }
}

function stopFakeProgress(wrapper, bar, timerRef) {
  if (timerRef) {
    clearInterval(timerRef);
  }

  setTimeout(() => {
    wrapper.style.display = "none";
    bar.style.width = "0";
  }, 600);
}

function showStatus(element, type, text) {
  element.className = "status";
  element.classList.add(type);
  element.textContent = text;
}

async function setupDownloadPage() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  const status = document.getElementById("downloadStatus");
  const info = document.getElementById("downloadInfo");
  const fileName = document.getElementById("fileName");
  const downloadBtn = document.getElementById("downloadBtn");

  if (!id) {
    showStatus(status, "error", "Aucun identifiant de fichier fourni dans l'URL.");
    return;
  }

  showStatus(status, "info", "Chargement des informations du fichier...");

  const endpoint = getApiUrl(API_ROUTES.download(id));

  try {
    const response = await fetch(endpoint, { method: "GET" });

    if (!response.ok) {
      throw await buildApiError(response, "Erreur lors de la récupération du fichier.");
    }

    assertExpectedContentType(response, "application/json", "Le serveur n'a pas renvoyé les informations du fichier au format JSON.");
    const data = await response.json();
    const serverFileName = data.fileName || data.name || `fichier-${id}`;
    const directUrl = normalizeApiUrl(data.url || data.download_url || data.downloadUrl || endpoint);

    fileName.textContent = serverFileName;
    downloadBtn.href = directUrl;
    info.classList.remove("hidden");
    showStatus(status, "success", "Votre fichier est prêt.");
  } catch (error) {
    console.error("Erreur API téléchargement :", error);
    showStatus(status, "error", error instanceof Error ? error.message : "Erreur lors de la récupération du fichier.");
  }
}
