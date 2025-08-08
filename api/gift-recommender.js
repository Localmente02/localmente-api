// Funzione di test ultra-semplice. Non usa Firebase. Non usa AI.
module.exports = async (req, res) => {
  // Impostazioni CORS per permettere all'app di parlare
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Creiamo una lista finta di suggerimenti
  const fakeSuggestions = [
    {
      id: "test_01",
      nome: "Test Prodotto 1",
      prezzo: 19.99,
      spiegazione: "Questo è un test. Se lo vedi, il collegamento App -> Vercel funziona.",
      imageUrl: "https://via.placeholder.com/150/FF0000/FFFFFF?Text=Test1",
      unit: "pz"
    },
    {
      id: "test_02",
      nome: "Test Prodotto 2",
      prezzo: 49.50,
      spiegazione: "Il sistema di base sta comunicando correttamente.",
      imageUrl: "https://via.placeholder.com/150/00FF00/FFFFFF?Text=Test2",
      unit: "kg"
    },
    {
      id: "test_03",
      nome: "Test Prodotto 3",
      prezzo: 100.00,
      spiegazione: "Il prossimo passo sarà ricollegare Firebase.",
      imageUrl: "https://via.placeholder.com/150/0000FF/FFFFFF?Text=Test3",
      unit: "pz"
    }
  ];

  // Restituiamo la lista finta, sempre
  return res.status(200).json(fakeSuggestions);
};
