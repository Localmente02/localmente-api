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

const STOP_WORDS = new Set(['e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', 'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della', 'ama', 'piacciono', 'qualsiasi']);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();
    
    if (productsSnapshot.empty) { return res.status(200).json([]); }
    
    let allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl); 

    const searchTerms = extractKeywords(userPreferences);
    let prioritizedProducts = [];

    if (searchTerms.length > 0) {
      console.log(`Termini di ricerca estratti: ${searchTerms.join(', ')}`);
      allProducts.forEach(product => {
        let score = 0;
        
        // ==========================================================
        //  MODIFICA CHIAVE: Cerchiamo in TUTTI i campi di testo possibili
        // ==========================================================
        const productText = [
            product.productName,
            product.brand,
            product.productDescription,
            product.shortDescription,
            product.productCategory,
            product.subCategory,
            (product.keywords || []).join(' '),
            (product.searchKeywords || []).join(' '),
            (product.productTags || []).join(' '), // Dati Artigiano/Negoziante
            (product.tags || []).join(' '), // Dati Artigiano
            (product.productColors || []).join(' '), // Dati Negoziante
            (product.materials || []).join(' '), // Dati Artigiano (se presente)
            product.condition
        ].filter(Boolean).join(' ').toLowerCase();
        
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
      allProducts = [...bestMatches, ...otherProducts];
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
  // ==========================================================
  //  MODIFICA CHIAVE: Passiamo un dossier COMPLETO all'AI
  // ==========================================================
  const productListForAI = products.map(p => ({
    id: p.id,
    name: p.productName,
    description: p.productDescription || p.shortDescription,
    category: p.productCategory,
    subCategory: p.subCategory,
    brand: p.brand,
    keywords: [...(p.keywords || []), ...(p.tags || []), ...(p.productTags || [])],
    // Aggiungiamo attributi speciali che l'AI può capire
    attributes: [
        p.condition,
        p.isUnique ? 'pezzo unico' : null,
        p.isCustomizable ? 'personalizzabile' : null
    ].filter(Boolean).join(', ')
  }));

  return `
    Sei un assistente regali geniale, un vero intenditore. Il tuo compito è trovare i 3 migliori regali da una lista di prodotti, come farebbe un personal shopper esperto.

    **Regole d'Oro:**
    1.  **Immedesimati:** Leggi le preferenze dell'utente e crea un'immagine mentale della persona che riceverà il regalo.
    2.  **Pensa come un umano, non come un computer:** Se l'utente chiede "scarpe Nike" e tu vedi "sneakers Adidas" o "scarpe da running Asics", sono ottimi suggerimenti alternativi! L'importante è cogliere l'intento.
    3.  **Valuta TUTTO:** Per ogni prodotto, considera il nome, la descrizione, la categoria, la marca e gli attributi speciali (es. 'pezzo unico', 'personalizzabile').
    4.  **Qualità > Quantità:** Scegli solo i 3 prodotti che sono VERAMENTE perfetti. Se ne trovi solo uno o due, va benissimo. Se non c'è nulla di buono, restituisci un array vuoto [].
    5.  **Scrivi una motivazione da venditore:** Per ogni prodotto scelto, crea una chiave "aiExplanation" con una frase breve (massimo 15 parole), brillante e convincente che tocchi le corde giuste.

    **Preferenze utente:**
    - Descrizione: "${prefs.personDescription || 'Non specificata'}"
    - Relazione: ${prefs.relationship}
    - Interessi: ${prefs.hobbies.join(', ') || 'Non specificati'}
    - Budget massimo: ${prefs.budget.max} euro

    **Catalogo Prodotti a disposizione (i primi sono i più pertinenti, ma analizzali tutti):**
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
