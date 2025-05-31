const citations = [
  "La vie est un mystère qu'il faut vivre, et non un problème à résoudre.",
  "Le succès, c’est d’aller d’échec en échec sans perdre son enthousiasme.",
  "Chaque jour est une nouvelle chance de changer ta vie.",
   "kanto kely."
];

function nouvelleCitation() {
  const index = Math.floor(Math.random() * citations.length);
  const citation = citations[index];
  document.getElementById("citation").textContent = citation;

  // Sauvegarder dans localStorage
  localStorage.setItem("citationDuJour", citation);
}

window.onload = function() {
  // Vérifier s'il y a déjà une citation sauvegardée
  const citationSauvegardee = localStorage.getItem("citationDuJour");
  if (citationSauvegardee) {
    document.getElementById("citation").textContent = citationSauvegardee;
  } else {
    nouvelleCitation();
  }
}
