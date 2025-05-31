const citations = [
    "Le succès est la somme de petits efforts répétés jour après jour.",
    "Crois en toi, chaque jour est une nouvelle chance.",
    "Fais de ton mieux, le reste suivra.",
    "Reste fort, les grandes choses prennent du temps.",
    "Ta seule limite, c’est toi-même.",
    "Commence petit, rêve grand, agis maintenant."
];

function nouvelleCitation() {
    const index = Math.floor(Math.random() * citations.length);
    document.getElementById("citation").innerText = citations[index];
}
