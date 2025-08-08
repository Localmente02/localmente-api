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

// Parole comuni da ignorare nella ricerca
const STOP_WORDS = new Set(['e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', 'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della']);

module.exports = async (req, res) => {
  // LA CORREZIONE ERA QUI
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // OPTIONS era fuori dalle virgolette
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;

    const searchTerms = extractKeywords(userPreferences);
    
    let products = [];
    if (searchTerms.length > 0) {
        console.log(`Ricerca mirata con i termini: ${searchTerms.join(', ')}`);
        const targetedSnapshot = await db.collection('global_product_catalog')
            .where('searchKeywords', 'array-contains-any', searchTerms.slice(0, 10))
            .limit(50)
            .get();
        products = targetedSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    
    if (products.length < 50) {
        const randomSnapshot = await db.collection('global_product_catalog').limit(100).get();
        const randomProducts = randomSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const productMap = new Map();
        [...products, ...randomProducts].forEach(p => productMap.set(p.id, p));
        products = Array.from(productMap.values());
    }
    
    const allProducts = products.filter(p => p.productName && p.price != null && p.productImageUrl);

    if (allProducts.length === 0) {
      return res.status(200).json([]);
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
        console.log("ATTIVAZIONE PIANO B: L'AI non ha dato risultati. Restituisco 3 prodotti casuali.");
        suggestions = getRandomProducts(allProducts, 3);
    }
    
    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    // Se l'errore è quello dell'indice, Vercel lo stamperà nei log e ci darà il link
    if (error.message && error.message.includes('The query requires an index')) {
        console.error('ERRORE DI INDICE FIREBASE! Crea l\'indice usando il link che trovi in questo log.');
    }
    return res.status(500).json({ error: 'Errore interno del nostro assistente. Riprova più tardi.' });
  }
};

function extractKeywords(prefs) {
    const text = `${prefs.personDescription || ''} ${prefs.hobbies.join(' ')}`;
    if (!text.trim()) return [];
    const keywords = text.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"").split(/\s+/);
    const uniqueKeywords = new Set(keywords);
    STOP_WORDS.forEach(word => uniqueKeywords.delete(word));
    return Array.from(uniqueKeywords).filter(k => k.length > 2);
}

function createPrompt(prefs, products) {
  const productListForAI = products.map(({ id, productName, productDescription, price, productCategory, keywords }) => 
    ({ id, name: productName, description: productDescription, price, category: productCategory, keywords: keywords || [] })
  );

  return `
    Sei un assistente regali geniale. Il tuo compito è trovare i 3 migliori regali da una lista di prodotti.
    
    **Regole:**
    1.  Analizza le preferenze.
    2.  Sii flessibile: Se l'utente chiede "scarpe Nike" ma tu hai solo "scarpe Adidas", suggerisci quelle!
    3.  Scegli i 3 prodotti MIGLIORI dalla lista. Se non ne trovi, restituisci un array vuoto [].
    4.  Per ogni prodotto, crea una chiave "aiExplanation" con una frase breve (massimo 15 parole), brillante e convincente.

    **Preferenze utente:**
    - Descrizione: "${prefs.personDescription || 'Non specificata'}"
    - Relazione: ${prefs.relationship}
    - Interessi: ${prefs.hobbies.join(', ') || 'Non specificati'}
    - Budget massimo: ${prefs.budget.max} euro

    **Lista prodotti disponibili (analizza nome, descrizione, categoria e keywords):**
    ${JSON.stringify(productListForAI.slice(0, 70))} 

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
