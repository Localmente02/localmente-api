// Stile CommonJS per massima compatibilità con le altre funzioni
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inizializza Firebase Admin SDK solo una volta
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}
const db = admin.firestore();

// Funzione handler principale
module.exports = async (req, res) => {
  // Configurazione CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non permesso.' });
  }

  try {
    const { userPreferences, userCurrentLocation } = req.body;

    if (!userPreferences || !userCurrentLocation || !userCurrentLocation.cap) {
      return res.status(400).json({ error: 'Mancano dati essenziali.' });
    }

    const {
      interessi,
      eta,
      genere,
      budget,
      personalita,
      relazione,
      occasione,
      noteAggiuntive,
    } = userPreferences;

    const userCap = userCurrentLocation.cap;

    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isAvailable', '==', true)
      .where('isMarketplaceActive', '==', true)
      .where('vendorCap', '==', userCap)
      .where('isPiazzaVendor', '==', true)
      .limit(500)
      .get();

    const availableProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.productName,
        descrizione: data.description || '',
        prezzo: data.price,
        unita: data.unit || 'pezzo',
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
      };
    }).filter(p => p.prezzo > 0 && p.nome);

    if (availableProducts.length === 0) {
      return res.status(404).json([]);
    }

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const promptText = `Sei un esperto selezionatore di regali. Suggerisci 3 prodotti dal catalogo fornito basandoti sulle preferenze. Per ogni suggerimento, includi "id", "nome", "prezzo", e "spiegazione". Rispondi SOLO con un array JSON di 3 oggetti.

Preferenze:
- Interessi: ${interessi ? interessi.join(', ') : 'N/A'}
- Età: ${eta || 'N/A'}
- Genere: ${genere || 'N/A'}
- Budget: ${budget || 'N/A'}
- Personalità: ${personalita || 'N/A'}
- Relazione: ${relazione || 'N/A'}
- Occasione: ${occasione || 'N/A'}
- Note: ${noteAggiuntive || 'N/A'}

Catalogo (${availableProducts.length} prodotti):
${JSON.stringify(availableProducts, null, 2)}

Rispondi SOLO con l'array JSON.`;

    const result = await model.generateContent(promptText);
    const response = await result.response;
    let aiResponseText = response.text();
    aiResponseText = aiResponseText.replace(/```json\n|```/g, '').trim();

    let parsedSuggestions;
    try {
      parsedSuggestions = JSON.parse(aiResponseText);
    } catch (e) {
      console.error("Errore parsing AI:", aiResponseText);
      return res.status(500).json([]);
    }

    const finalSuggestions = parsedSuggestions.map(suggestion => {
      const product = availableProducts.find(p => p.id === suggestion.id);
      return product ? { ...suggestion, imageUrl: product.imageUrl, unit: product.unita } : null;
    }).filter(Boolean);

    return res.status(200).json(finalSuggestions);

  } catch (error) {
    console.error('Errore funzione gift-recommender:', error);
    return res.status(500).json([]);
  }
};
