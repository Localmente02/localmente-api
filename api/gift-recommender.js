const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
  } catch (e) {
    console.error("Firebase Admin Init Error:", e);
  }
}
const db = admin.firestore();
db.settings({ preferRest: true });

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { userPreferences } = req.body;

    if (!userPreferences) {
      return res.status(400).json({ error: 'Dati mancanti.' });
    }

    // ###############################################################
    // NESSUN FILTRO. NIENTE. PRENDE I PRODOTTI CHE CI SONO E BASTA.
    // ###############################################################
    const productsSnapshot = await db.collection('global_product_catalog')
      .limit(100) // Prende i primi 100 prodotti che trova
      .get();

    if (productsSnapshot.empty) {
      return res.status(200).json([]);
    }

    const availableProducts = productsSnapshot.docs.map(doc => {
        const data = doc.data();
        return {
            id: doc.id,
            nome: data.productName,
            prezzo: data.price,
            descrizione: data.description,
            imageUrl: data.imageUrls ? data.imageUrls[0] : null,
            unit: data.unit || '',
        };
    });

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Suggerisci 3 regali dal catalogo in base alle preferenze. Rispondi SOLO con un array JSON con campi "id", "nome", "prezzo", "spiegazione".
      Preferenze: ${JSON.stringify(userPreferences)}
      Catalogo: ${JSON.stringify(availableProducts.map(p => ({id: p.id, nome: p.nome, prezzo: p.prezzo, descrizione: p.descrizione})))}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let aiResponseText = response.text().replace(/```json\n|```/g, '').trim();

    let finalSuggestions = [];
    try {
      const parsedSuggestions = JSON.parse(aiResponseText);
      if (Array.isArray(parsedSuggestions)) {
        finalSuggestions = parsedSuggestions.map(suggestion => {
          const product = availableProducts.find(p => p.id === suggestion.id);
          return product ? { ...suggestion, spiegazione: suggestion.spiegazione || "Un'ottima idea regalo!", imageUrl: product.imageUrl, unit: product.unit } : null;
        }).filter(Boolean);
      }
    } catch (e) {
      console.log("AI non ha risposto con JSON valido, attivo fallback.");
    }

    if (finalSuggestions.length === 0 && availableProducts.length > 0) {
      const shuffledProducts = shuffleArray(availableProducts);
      const randomSuggestions = shuffledProducts.slice(0, 3).map(product => ({
        id: product.id,
        nome: product.nome,
        prezzo: product.prezzo,
        spiegazione: "Te lo suggeriamo perché è un prodotto di qualità!",
        imageUrl: product.imageUrl,
        unit: product.unit,
      }));
      finalSuggestions = randomSuggestions;
    }

    return res.status(200).json(finalSuggestions);

  } catch (error) {
    console.error('Errore funzione regalo:', error.message);
    return res.status(500).json({ error: 'Errore interno.' });
  }
};
