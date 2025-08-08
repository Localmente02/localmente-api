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

// Funzione handler principale
module.exports = async (req, res) => {
  // Impostazioni CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log("Inizio test brutale: recupero 3 prodotti Piazza a caso.");

  try {
    // IGNORA IL CAP, IGNORA LE PREFERENZE.
    // Prende semplicemente i prodotti che sono "Piazza Vendor".
    const productsSnapshot = await db.collection('global_product_catalog')
      .where('isPiazzaVendor', '==', true)
      .limit(20) // Prendiamo 20 prodotti per avere un po' di scelta
      .get();

    if (productsSnapshot.empty) {
      console.log("Nessun prodotto 'isPiazzaVendor: true' trovato in tutto il database.");
      return res.status(200).json([]);
    }

    const allPiazzaProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        nome: data.productName,
        prezzo: data.price,
        spiegazione: "Questo è un prodotto di test casuale dal catalogo Piazza.", // Spiegazione fissa per il test
        imageUrl: data.imageUrls && data.imageUrls.length > 0 ? data.imageUrls[0] : null,
        unit: data.unit || '',
      };
    });

    // Mescoliamo i risultati per assicurarci che siano casuali
    const shuffled = allPiazzaProducts.sort(() => 0.5 - Math.random());
    
    // Selezioniamo i primi 3
    const randomSuggestions = shuffled.slice(0, 3);

    console.log(`Test brutale completato. Restituisco ${randomSuggestions.length} prodotti a caso.`);
    
    return res.status(200).json(randomSuggestions);

  } catch (error) {
    console.error('Errore grave durante il test brutale:', error);
    return res.status(500).json({ error: 'Errore interno durante il recupero dei prodotti di test.' });
  }
};
