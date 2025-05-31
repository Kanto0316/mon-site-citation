const textarea = document.getElementById("note");

// Charger la note si elle existe
window.onload = () => {
  const noteSauvegardee = localStorage.getItem("maNote");
  if (noteSauvegardee) {
    textarea.value = noteSauvegardee;
  }
};

// Sauvegarder à chaque changement
textarea.addEventListener("input", () => {
  localStorage.setItem("maNote", textarea.value);
});
