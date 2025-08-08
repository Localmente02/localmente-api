const admin = require('firebase-admin');

// Inizializzazione di Firebase
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

// ******************** MODIFICA CHIAVE QUI ********************
// Questa riga forza l'uso di un'implementazione diversa per le chiamate di rete,
// che a volte risolve bug di compatibilità come quello che stiamo vedendo.
db.settings({ preferRest: true });
// *************************************************************

// Funzione handler principale
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log("Inizio test brutale con fix preferRest.");

  try {
    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isPiazzaVendor', '==', true)
      .limit(20)
      .get();

    if (productsSnapshot.empty) {
      console.log("Nessun prodotto 'isPiazzaVendor: true' trovato.");
      return res.status(200).json([]);
    }

    const allPiazzaProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.productName,
        prezzo: data.price,
        spiegazione: "Questo è un prodotto di test casuale dal catalogo Piazza.",
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
        unit: data.unit || '',
      };
    });

    const shuffled = allPiazzaProducts.sort(() => 0.5 - Math.random());
    const randomSuggestions = shuffled.slice(0, 3);

    console.log(`Test brutale completato. Restituisco ${randomSuggestions.length} prodotti.`);
    
    return res.status(200).json(randomSuggestions);

  } catch (error) {
    console.error('Errore grave durante il test brutale (con fix):', error);
    return res.status(500).json({ error: 'Errore interno durante il recupero dei prodotti di test.' });
  }
};
