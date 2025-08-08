// api/gift-recommender.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    
    // ==========================================================
    //  LA TUA VISIONE: Prendiamo solo prodotti dei "negozianti"
    // ==========================================================
    console.log("Eseguo la query per prendere solo i prodotti dei 'negozianti'...");
    const productsSnapshot = await db.collection('global_product_catalog')
        .where('vendorUserType', '==', 'negoziante')
        .limit(500) // Prendiamo un bel po' di prodotti di negozianti
        .get();
    
    if (productsSnapshot.empty) { 
        console.log("Nessun prodotto trovato con vendorUserType == 'negoziante'.");
        return res.status(200).json([]); 
    }
    
    let allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl); 

    console.log(`Trovati ${allProducts.length} prodotti validi di negozianti. Ora li passo all'AI.`);
    
    if (allProducts.length === 0) { return res.status(200).json([]); }

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
    } catch (aiError) { console.error("ERRORE DALL'AI, attivando il Piano B:", aiError); }

    if (suggestions.length === 0) {
        console.log("ATTIVAZIONE PIANO B: L'AI non ha dato risultati validi. Restituisco 3 prodotti casuali dalla lista dei negozianti.");
        suggestions = getRandomProducts(allProducts, 3);
    }
    
    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    if (error.message && error.message.includes('The query requires an index')) {
        console.error('ERRORE DI INDICE FIREBASE! La query per "negoziante" richiede un indice. Crealo usando il link che trovi in questo log.');
    }
    return res.status(500).json({ error: 'Errore interno. Potrebbe essere necessario un indice su "vendorUserType". Controlla i log di Vercel.' });
  }
};

// Le funzioni di supporto (createPrompt, getRandomProducts) restano identiche
function createPrompt(prefs, products) {
  const productListForAI = products.map(p => ({
    id: p.id,
    name: p.productName,
    description: p.productDescription || p.shortDescription,
    category: p.productCategory,
    subCategory: p.subCategory,
    brand: p.brand,
    keywords: [...(p.keywords || []), ...(p.tags || []), ...(p.productTags || [])],
    attributes: [ p.condition, p.isUnique ? 'pezzo unico' : null, p.isCustomizable ? 'personalizzabile' : null ].filter(Boolean).join(', ')
  }));

  return `
    Sei un assistente regali geniale. Il tuo compito è trovare i 3 migliori regali da una lista di prodotti che provengono esclusivamente da negozi di abbigliamento, elettronica, sport, ecc. (NON alimentari).

    **Regole d'Oro:**
    1.  **Immedesimati:** Leggi le preferenze dell'utente.
    2.  **Pensa come un umano:** Se l'utente chiede "scarpe Nike" e tu vedi "sneakers Adidas", è un ottimo suggerimento alternativo.
    3.  **Scegli i 3 prodotti MIGLIORI dalla lista.** Se non trovi nulla di buono, restituisci un array vuoto [].
    4.  **Scrivi una motivazione da venditore** (massimo 15 parole).

    **Preferenze utente:**
    - Descrizione: "${prefs.personDescription || 'Non specificata'}"
    - Interessi: ${prefs.hobbies.join(', ') || 'Non specificati'}

    **Catalogo Prodotti a disposizione:**
    ${JSON.stringify(productListForAI.slice(0, 150))} 

    **Il tuo output DEVE essere solo un array JSON. Formato:**
    [
      { "id": "id_prodotto_1", "aiExplanation": "La tua motivazione geniale qui." }
    ]
  `;
}

function getRandomProducts(products, count) {
    const shuffled = [...products].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(count, products.length));
    
    return selected.map(p => ({
        id: p.id,
        name: p.productName,
        price: p.price,
        imageUrl: p.productImageUrl,
        aiExplanation: "L'AI non ha trovato un match perfetto, ma questo potrebbe essere un'ottima sorpresa!"
    }));
}
