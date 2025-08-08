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

module.exports = async (req, res) => {
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
      return res.status(400).json({ error: 'Dati mancanti.' });
    }

    const userCap = userCurrentLocation.cap;

    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isAvailable', '==', true)
      .where('isMarketplaceActive', '==', true)
      .where('vendorCap', '==', userCap)
      .where('isPiazzaVendor', '==', true)
      .limit(500)
      .get();

    if (productsSnapshot.empty) {
      return res.status(200).json([]);
    }

    const availableProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.productName,
        descrizione: data.description || '',
        prezzo: data.price,
        unita: data.unit || '',
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
      };
    });

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const promptText = `Sei un esperto di regali. Suggerisci 3 prodotti dal catalogo, basandoti sulle preferenze. Per ogni suggerimento, includi "id", "nome", "prezzo", e una "spiegazione" breve. Rispondi SOLO con un array JSON di 3 oggetti.
    Preferenze Utente: ${JSON.stringify(userPreferences)}
    Catalogo Prodotti: ${JSON.stringify(availableProducts)}
    Rispondi SOLO con l'array JSON.`;

    const result = await model.generateContent(promptText);
    const response = await result.response;
    let aiResponseText = response.text().replace(/```json\n|```/g, '').trim();

    let parsedSuggestions;
    try {
      parsedSuggestions = JSON.parse(aiResponseText);
    } catch (e) {
      return res.status(200).json([]);
    }

    const finalSuggestions = parsedSuggestions.map(suggestion => {
      const product = availableProducts.find(p => p.id === suggestion.id);
      return product ? { ...suggestion, imageUrl: product.imageUrl, unit: product.unita } : null;
    }).filter(Boolean);

    return res.status(200).json(finalSuggestions);

  } catch (error) {
    console.error('Errore funzione gift-recommender:', error);
    return res.status(500).json({ error: 'Errore interno del server.' });
  }
};
