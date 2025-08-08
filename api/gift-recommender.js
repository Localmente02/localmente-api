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
db.settings({ preferRest: true }); // Aggiunta di sicurezza per la connessione

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Test "Brutale": ignora tutto e restituisce 3 prodotti a caso
    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isPiazzaVendor', '==', true)
      .limit(20)
      .get();

    if (productsSnapshot.empty) {
      return res.status(200).json([]);
    }

    const allPiazzaProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.productName,
        prezzo: data.price,
        spiegazione: "Prodotto di test casuale dal catalogo Piazza.",
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
        unit: data.unit || '',
      };
    });

    const shuffled = allPiazzaProducts.sort(() => 0.5 - Math.random());
    const randomSuggestions = shuffled.slice(0, 3);
    
    return res.status(200).json(randomSuggestions);

  } catch (error) {
    console.error('Errore durante il test brutale:', error);
    return res.status(500).json({ error: 'Errore interno.' });
  }
};
