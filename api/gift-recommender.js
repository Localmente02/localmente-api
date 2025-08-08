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

const STOP_WORDS = new Set(['e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', 'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    
    // ==========================================================
    //  CAMBIO CHIAVE: Carichiamo fino a 1000 prodotti (tutto il catalogo per i test)
    // ==========================================================
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();
    
    if (productsSnapshot.empty) {
      return res.status(200).json([]);
    }
    
    let allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl); 

    const searchTerms = extractKeywords(userPreferences);
    let prioritizedProducts = [];

    if (searchTerms.length > 0) {
      console.log(`Termini di ricerca estratti: ${searchTerms.join(', ')}`);
      allProducts.forEach(product => {
        let score = 0;
        const productText = `${product.productName || ''} ${product.productDescription || ''} ${(product.keywords || []).join(' ')} ${(product.searchKeywords || []).join(' ')}`.toLowerCase();
        
        searchTerms.forEach(term => {
          if (productText.includes(term)) {
            score++;
          }
        });
        
        if (score > 0) {
          prioritizedProducts.push({ product, score });
        }
      });

      prioritizedProducts.sort((a, b) => b.score - a.score);
      
      const bestMatches = prioritizedProducts.map(item => item.product);
      const otherProducts = allProducts.filter(p => !bestMatches.some(best => best.id === p.id));
      allProducts = [...bestMatches, ...otherProducts]; // Ora usiamo tutti i match trovati
      console.log(`Trovati ${bestMatches.length} prodotti pertinenti. Catalogo finale per AI: ${allProducts.length} prodotti.`);
    }
    
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
        console.log("ATTIVAZIONE PIANO B: L'AI non ha dato risultati validi. Restituisco 3 prodotti casuali.");
        suggestions = getRandomProducts(allProducts, 3);
    }
    
    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
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
    3.  Scegli i 3 prodotti MIGLIORI dalla lista. Se non trovi nulla di attinente, restituisci un array vuoto [].
    4.  Per ogni prodotto, crea una chiave "aiExplanation" con una frase breve (massimo 15 parole), brillante e convincente.

    **Preferenze utente:**
    - Descrizione: "${prefs.personDescription || 'Non specificata'}"
    - Relazione: ${prefs.relationship}
    - Interessi: ${prefs.hobbies.join(', ') || 'Non specificati'}
    - Budget massimo: ${prefs.budget.max} euro

    **Lista prodotti disponibili (I primi sono i più pertinenti, analizza nome, descrizione, categoria e keywords):**
    ${JSON.stringify(productListForAI.slice(0, 100))} 

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
