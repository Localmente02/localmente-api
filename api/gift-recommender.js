const admin = require('firebase-admin');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
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
        spiegazione: "Prodotto di test.",
        imageUrl: data.imageUrls ? data.imageUrls[0] : null,
        unit: data.unit || '',
      };
    });

    const shuffled = allPiazzaProducts.sort(() => 0.5 - Math.random());
    const randomSuggestions = shuffled.slice(0, 3);
    
    return res.status(200).json(randomSuggestions);

  } catch (error) {
    console.error('Errore durante il test:', error);
    return res.status(500).json({ error: 'Errore interno.' });
  }
};
