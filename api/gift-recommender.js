// api/gift-recommender.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inizializzazione Firebase Admin
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error', e.stack);
}

const db = admin.firestore();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

// Parole chiave da escludere
const excludedKeywords = [
  'frutta', 'verdura', 'mela', 'banana', 'pera', 'uva', 'ortaggio',
  'bambino', 'bambina', 'giocattolo', 'neonato', 'passeggino'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });

  try {
    const userPreferences = req.body;

    // Carichiamo prodotti
    console.log("Carico un ampio set di prodotti dal catalogo...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();

    if (productsSnapshot.empty) {
      console.log("Il catalogo globale è vuoto.");
      return res.status(200).json([]);
    }

    let allProductsRaw = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // FILTRO SEVERO
    const allProducts = allProductsRaw.filter(p => {
      const isNegoziante = p.vendorUserType === 'negoziante' || p.userType === 'negoziante';
      const hasRequiredFields = p.productName && p.price != null && p.productImageUrl;
      const nameLower = (p.productName || '').toLowerCase();
      const categoryLower = (p.productCategory || '').toLowerCase();
      const isExcluded = excludedKeywords.some(kw => nameLower.includes(kw) || categoryLower.includes(kw));
      return isNegoziante && hasRequiredFields && !isExcluded;
    });

    console.log(`Filtrati ${allProducts.length} prodotti validi di 'negozianti' (senza categorie escluse).`);

    if (allProducts.length === 0) {
      console.log("Nessun prodotto valido trovato. Attivo Piano B sul catalogo grezzo.");
      const fallbackProducts = getRandomProducts(allProductsRaw, 6);
      return res.status(200).json(fallbackProducts);
    }

    let suggestions = [];

    try {
      const prompt = createPrompt(userPreferences, allProducts);
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const cleanJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      const aiSuggestions = JSON.parse(cleanJsonString);

      if (aiSuggestions && Array.isArray(aiSuggestions) && aiSuggestions.length > 0) {
        suggestions = aiSuggestions.map(aiSugg => {
          const fullProduct = allProducts.find(p => p.id === aiSugg.id);
          if (!fullProduct) return null;
          return {
            id: fullProduct.id,
            name: fullProduct.productName,
            price: fullProduct.price,
            imageUrl: fullProduct.productImageUrl,
            aiExplanation: aiSugg.aiExplanation || "Una scelta eccellente e pertinente."
          };
        }).filter(p => p !== null);
      }
    } catch (aiError) {
      console.error("ERRORE DALL'AI, attivando il Piano B:", aiError);
    }

    if (suggestions.length === 0) {
      console.log("ATTIVAZIONE PIANO B: L'AI non ha dato risultati. Restituisco 6 prodotti casuali coerenti.");
      suggestions = getRandomProducts(allProducts, 6);
    }

    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    return res.status(500).json({ error: 'Errore interno del nostro assistente.' });
  }
};

function createPrompt(prefs, products) {
  const productListForAI = products.map(p => ({
    id: p.id,
    name: p.productName,
    description: p.productDescription || p.shortDescription,
    category: p.productCategory,
    brand: p.brand,
    attributes: [
      p.condition,
      p.isUnique ? 'pezzo unico' : null,
      p.isCustomizable ? 'personalizzabile' : null
    ].filter(Boolean).join(', ')
  }));

  return `
    Sei un personal shopper eccezionale e DEVI rispettare le regole senza eccezioni.

    **REGOLE OBBLIGATORIE:**
    1. NON includere mai prodotti di tipo alimentare, frutta, verdura, prodotti per bambini o giocattoli.
    2. Scegli massimo 6 regali dalla lista fornita.
    3. Devono essere il più possibile pertinenti alle preferenze dell’utente.
    4. Se non trovi nulla di adatto, restituisci un array JSON vuoto.
    5. Per ogni prodotto, fornisci una aiExplanation breve (max 15 parole).

    **Preferenze utente:**
    - Descrizione: "${prefs.personDescription || 'Non specificata'}"

    **Catalogo Prodotti a disposizione:**
    ${JSON.stringify(productListForAI.slice(0, 150))}

    **Output obbligatorio (solo array JSON, niente testo extra):**
    [
      { "id": "id_prodotto_1", "aiExplanation": "Perfette per il suo stile casual e sportivo." }
    ]
  `;
}

function getRandomProducts(products, count) {
  const validProducts = products.filter(p => {
    const nameLower = (p.productName || '').toLowerCase();
    const categoryLower = (p.productCategory || '').toLowerCase();
    return p.productName && p.price != null && p.productImageUrl &&
           !excludedKeywords.some(kw => nameLower.includes(kw) || categoryLower.includes(kw));
  });
  const shuffled = [...validProducts].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, Math.min(count, validProducts.length));

  return selected.map(p => ({
    id: p.id,
    name: p.productName,
    price: p.price,
    imageUrl: p.productImageUrl,
    aiExplanation: "Scelto tra i prodotti più adatti disponibili."
  }));
}
