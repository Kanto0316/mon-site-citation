const API_BASE = "https://back-end-serveur-1.onrender.com";

const isIndexPage = Boolean(document.getElementById("uploadForm"));
const isDownloadPage = Boolean(document.getElementById("downloadInfo"));

if (isIndexPage) {
  setupUploadPage();
}

if (isDownloadPage) {
  setupDownloadPage();
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

      const response = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Le serveur a retourné une erreur.");
      }

      const data = await response.json();
      const urlFromApi = data.url || data.downloadUrl || data.link;
      const idFromApi = data.id;

      const finalLink =
        urlFromApi ||
        (idFromApi ? `${window.location.origin}/download.html?id=${encodeURIComponent(idFromApi)}` : "");

      if (!finalLink) {
        throw new Error("Réponse inattendue du backend: lien introuvable.");
      }

      showStatus(statusMessage, "success", "Upload terminé.");
      progressBar.style.width = "100%";
      downloadLink.href = finalLink;
      downloadLink.textContent = finalLink;
      result.classList.remove("hidden");
    } catch (error) {
      showStatus(statusMessage, "error", error.message || "Échec de l'envoi du fichier.");
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
    } catch {
      showStatus(statusMessage, "error", "Impossible de copier automatiquement le lien.");
    }
  });

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

  const endpoint = `${API_BASE}/download/${encodeURIComponent(id)}`;

  try {
    const response = await fetch(endpoint, { method: "GET" });

    if (!response.ok) {
      throw new Error("Fichier introuvable ou indisponible.");
    }

    const data = await response.json();
    const serverFileName = data.fileName || data.name || `fichier-${id}`;
    const directUrl = data.url || endpoint;

    fileName.textContent = serverFileName;
    downloadBtn.href = directUrl;
    info.classList.remove("hidden");
    showStatus(status, "success", "Votre fichier est prêt.");
  } catch (error) {
    showStatus(status, "error", error.message || "Erreur lors de la récupération du fichier.");
  }
}
