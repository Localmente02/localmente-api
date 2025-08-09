// api/gift-recommender.js

const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

const STOP_WORDS = new Set(['e','un','una','di','a','da','in','con','su','per','tra','fra','gli','le','i','il','lo','la','mio','tuo','suo','un\'','degli','del','della','ama','piacciono','qualsiasi','regalo','vorrei','fare','regalare','amico','amica','nipote','nonna','nonno','mamma','papà']);

const MAGIC_PHRASES = {
    brand: "Per chi ama lo stile inconfondibile di [TERM].",
    sport: "L'ideale per il suo spirito sportivo e dinamico.",
    running: "Perfetto per macinare chilometri con stile.",
    calcio: "Per veri tifosi e amanti del gioco di squadra.",
    trekking: "Per le sue avventure all'aria aperta.",
    neonato: "Un pensiero speciale per dare il benvenuto.",
    bambino: "Per stimolare la sua fantasia e il gioco.",
    donna: "Un tocco di stile pensato apposta per lei.",
    uomo: "Un regalo pratico e di stile per lui.",
    default_category: "Un'ottima scelta dalla categoria [TERM].",
    Scarpe: "Per chi non rinuncia mai allo stile, passo dopo passo.",
    Zaini: "Il compagno perfetto per ogni avventura.",
    Abbigliamento: "Per rinnovare il suo look con un tocco di stile.",
    Orologi: "Per scandire il tempo con eleganza e precisione.",
    default: "Un suggerimento pensato apposta per te."
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    
    console.log("Carico fino a 1000 prodotti dal catalogo globale (senza filtri)...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();
    
    if (productsSnapshot.empty) { 
        console.log("Il catalogo globale è vuoto.");
        return res.status(200).json([]); 
    }
    
    let allProductsRaw = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filtriamo "in casa" per essere sicuri al 100%
    const allProducts = allProductsRaw.filter(p => 
        (p.vendorUserType === 'negoziante' || p.userType === 'negoziante') &&
        p.productName && p.price != null && p.productImageUrl
    );

    console.log(`Trovati ${allProducts.length} prodotti validi di 'negozianti' dopo il filtro interno.`);
    
    if (allProducts.length === 0) {
        console.log("Nessun prodotto di 'negozianti' trovato. Attivo Piano B sul catalogo grezzo.");
        return res.status(200).json(getRandomProducts(allProductsRaw, 6));
    }

    const searchTerms = extractKeywords(userPreferences);
    console.log(`Termini di ricerca estratti: ${searchTerms.join(', ')}`);
    
    let scoredProducts = [];
    allProducts.forEach(product => {
        let score = 0;
        let bestMatchTerm = '';

        const pName = (product.productName || '').toLowerCase();
        const pBrand = (product.brand || '').toLowerCase();
        const pCategory = (product.productCategory || '').toLowerCase();
        const pSubCategory = (product.subCategory || '').toLowerCase();
        const pKeywords = ((product.keywords || []).join(' ') + ' ' + (product.searchKeywords || []).join(' ')).toLowerCase();
        
        searchTerms.forEach(term => {
            if (pName.includes(term) || pBrand.includes(term)) {
                score += 10;
                if (!bestMatchTerm) bestMatchTerm = term;
            }
            if (pCategory.includes(term) || pSubCategory.includes(term)) {
                score += 5;
                if (!bestMatchTerm) bestMatchTerm = product.productCategory || term;
            }
            if (pKeywords.includes(term)) {
                score += 2;
                if (!bestMatchTerm) bestMatchTerm = term;
            }
        });
        
        if (score > 0) {
            scoredProducts.push({ product, score, bestMatchTerm });
        }
    });

    scoredProducts.sort((a, b) => b.score - a.score);

    let topProducts = scoredProducts.slice(0, 6);
    
    if (topProducts.length === 0) {
        console.log("Nessun match con punteggio. Attivo Piano B sulla lista dei negozianti.");
        topProducts = getRandomProducts(allProducts, 6, true); // true indica che sono già oggetti prodotto
    }
    
    const suggestions = topProducts.map(item => {
        // Se item è già un prodotto (dal Piano B), usalo direttamente.
        const product = item.product || item; 
        const aiExplanation = item.score ? generateMagicPhrase(item.bestMatchTerm, product.brand, product.productCategory) : "Un suggerimento speciale, scelto per te.";
        return {
            id: product.id,
            name: product.productName,
            price: product.price,
            imageUrl: product.productImageUrl,
            aiExplanation: aiExplanation
        };
    });

    return res.status(200).json(suggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    return res.status(500).json({ error: 'Errore interno del nostro assistente.' });
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

function generateMagicPhrase(term, brand, category) {
    const searchTerm = (term || '').toLowerCase();
    const categoryTerm = (category || '').toLowerCase();
    
    if (MAGIC_PHRASES[searchTerm]) return MAGIC_PHRASES[searchTerm];
    if (brand && MAGIC_PHRASES['brand']) return MAGIC_PHRASES['brand'].replace('[TERM]', brand);
    if (MAGIC_PHRASES[categoryTerm]) return MAGIC_PHRASES[categoryTerm];
    if (category && MAGIC_PHRASES['default_category']) return MAGIC_PHRASES['default_category'].replace('[TERM]', category);
    
    return MAGIC_PHRASES['default'];
}

function getRandomProducts(products, count, isAlreadyProduct = false) {
    const validProducts = isAlreadyProduct ? products : products.filter(p => p.productName && p.price != null && p.productImageUrl);
    const shuffled = [...validProducts].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, validProducts.length));
}
