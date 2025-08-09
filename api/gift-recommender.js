// api/gift-recommender.js

const admin = require('firebase-admin');

// Non ci serve più l'AI di Google
// const { GoogleGenerativeAI } = require('@google/generative-ai');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

// Non ci serve più l'AI di Google
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

const STOP_WORDS = new Set(['e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', 'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della', 'ama', 'piacciono', 'qualsiasi', 'regalo', 'vorrei', 'fare', 'regalare']);

// Dizionario per le frasi magiche
const MAGIC_PHRASES = {
    // Priorità alta: basate su parole chiave specifiche
    brand: "Per chi ama lo stile inconfondibile di [TERM].",
    sport: "L'ideale per il suo spirito sportivo e dinamico.",
    running: "Perfetto per macinare chilometri con stile.",
    calcio: "Per veri tifosi e amanti del gioco di squadra.",
    trekking: "Per le sue avventure all'aria aperta.",
    neonato: "Un pensiero speciale per dare il benvenuto al nuovo arrivato.",
    bambino: "Per stimolare la sua fantasia e il gioco.",
    nonna: "Un regalo che unisce comfort e un tocco di eleganza.",
    mamma: "Un pensiero speciale per ringraziarla di tutto.",
    // Priorità media: basate sulle categorie
    default_category: "Un'ottima scelta dalla categoria [TERM].",
    Scarpe: "Per chi non rinuncia mai allo stile, passo dopo passo.",
    Zaini: "Il compagno perfetto per ogni avventura quotidiana.",
    Abbigliamento: "Per rinnovare il suo look con un tocco di stile.",
    Orologi: "Per scandire il tempo con eleganza e precisione.",
    // Frase di default se non troviamo nulla di specifico
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
    
    console.log("Carico prodotti dei 'negozianti'...");
    const productsSnapshot = await db.collection('global_product_catalog')
        .where('vendorUserType', '==', 'negoziante')
        .limit(500)
        .get();
    
    if (productsSnapshot.empty) { 
        console.log("Nessun prodotto 'negoziante' trovato.");
        return res.status(200).json([]); 
    }
    
    const allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl); 

    const searchTerms = extractKeywords(userPreferences);
    console.log(`Termini di ricerca estratti: ${searchTerms.join(', ')}`);
    
    // --- IL NUOVO CERVELLO A PUNTI ---
    let scoredProducts = [];

    allProducts.forEach(product => {
        let score = 0;
        let matchReason = null; // Per capire perché ha vinto

        const productText = [
            product.productName, product.brand, product.productDescription,
            product.shortDescription, product.productCategory, product.subCategory,
            (product.keywords || []).join(' '), (product.searchKeywords || []).join(' '),
            (product.productTags || []).join(' '), (product.tags || []).join(' '),
            (product.productColors || []).join(' ')
        ].filter(Boolean).join(' ').toLowerCase();

        if (searchTerms.length > 0) {
            searchTerms.forEach(term => {
                if (productText.includes(term)) {
                    // Diamo più punti se la parola è nel nome o nel brand
                    if ((product.productName || '').toLowerCase().includes(term) || (product.brand || '').toLowerCase().includes(term)) {
                        score += 5;
                        if (!matchReason) matchReason = product.brand ? 'brand' : 'productName'; // La ragione più importante
                    } else {
                        score += 1;
                        if (!matchReason) matchReason = 'keyword';
                    }
                }
            });
        }
        
        if (score > 0) {
            scoredProducts.push({ product, score, matchReason });
        }
    });

    // Ordiniamo i prodotti per punteggio
    scoredProducts.sort((a, b) => b.score - a.score);

    // Prendiamo i migliori 6
    const topProducts = scoredProducts.slice(0, 6);
    
    // Se non abbiamo trovato nulla, prendiamo 6 prodotti a caso (PIANO B)
    if (topProducts.length === 0 && allProducts.length > 0) {
        console.log("Nessun match trovato, attivo il Piano B con prodotti casuali.");
        const randomProducts = getRandomProducts(allProducts, 6);
        return res.status(200).json(randomProducts);
    }
    
    // --- CREIAMO LA RISPOSTA CON LE FRASI MAGICHE ---
    const suggestions = topProducts.map(item => {
        const product = item.product;
        
        // Cerca la parola chiave che ha fatto scattare il match per la frase
        const winningTerm = searchTerms.find(term => 
            (product.brand || '').toLowerCase().includes(term) || 
            (product.productCategory || '').toLowerCase().includes(term) ||
            term === item.matchReason
        );

        const aiExplanation = generateMagicPhrase(winningTerm, product.brand, product.productCategory);

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
    if (term && MAGIC_PHRASES[term]) {
        return MAGIC_PHRASES[term];
    }
    if (brand && MAGIC_PHRASES['brand']) {
        return MAGIC_PHRASES['brand'].replace('[TERM]', brand);
    }
    if (category && MAGIC_PHRASES[category]) {
        return MAGIC_PHRASES[category];
    }
    if (category && MAGIC_PHRASES['default_category']) {
        return MAGIC_PHRASES['default_category'].replace('[TERM]', category);
    }
    return MAGIC_PHRASES['default'];
}

function getRandomProducts(products, count) {
    const shuffled = [...products].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(count, products.length));
    
    return selected.map(p => ({
        id: p.id,
        name: p.productName,
        price: p.price,
        imageUrl: p.productImageUrl,
        aiExplanation: "Un suggerimento speciale, scelto per te dal nostro catalogo."
    }));
}
