// api/gift-recommender.js
// Questa è la versione FINALE del CERVELLO per la Ricerca Totale con PIÙ RISULTATI.

const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

const STOP_WORDS = new Set([
    'e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', // Articoli e preposizioni
    'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della', 'perche', 'come', 'cosa', 'chi', 'quale', 'dove', // Pronomi e interrogativi
    'ama', 'piacciono', 'qualsiasi', 'regalo', 'vorrei', 'fare', 'regalare', 'cerco', 'cerca', 'trova', 'mostrami', // Verbi e richieste comuni
    'amico', 'amica', 'nipote', 'nonna', 'nonno', 'mamma', 'papa', 'figlio', 'figlia', 'fratello', 'sorella', 'collega', 'partner', // Relazioni
    'nuove', 'vecchie', 'belle', 'brutte', 'buone', 'cattive', 'migliori', 'peggiori', 'di', 'marca', 'comode', 'sportive', 'eleganti', // Aggettivi generici
    'che', 'vende', 'vendono', 'venduta', 'venduto', 'in', 'citta', 'o' // Parole aggiuntive rilevate nei test
]);

const MAGIC_PHRASES = {
    brand: "Un classico intramontabile di [TERM].",
    sport: "L'ideale per il suo spirito sportivo e dinamico.",
    running: "Perfetto per macinare chilometri con stile.",
    calcio: "Per veri tifosi e amanti del gioco di squadra.",
    trekking: "Per le sue avventure all'aria aperta.",
    neonato: "Un pensiero speciale per dare il benvenuto al nuovo arrivato.",
    bambino: "Per stimolare la sua fantasia e il gioco.",
    donna: "Un tocco di stile pensato apposta per lei.",
    uomo: "Un regalo pratico e di stile per lui.",
    default_category: "Un'ottima scelta dalla categoria [TERM].",
    Scarpe: "Per chi non rinuncia mai allo stile, passo dopo passo.",
    Zaini: "Il compagno perfetto per ogni avventura.",
    Abbigliamento: "Per rinnovare il suo look con un tocco di stile.",
    Orologi: "Per scandire il tempo con eleganza e precisione.",
    Frutta: "La freschezza della natura, direttamente a casa tua.",
    Verdura: "Ingredienti sani per le tue ricette migliori.",
    Carne: "La qualità in tavola, per i sapori autentici.",
    Pesce: "Il gusto del mare, fresco e genuino.",
    Farmaci: "Per la tua salute e benessere quotidiano.",
    default: "Un suggerimento in linea con la tua ricerca."
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    
    console.log("Ricerca Totale: Carico fino a 1000 prodotti da tutto il catalogo...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();
    
    if (productsSnapshot.empty) { 
        console.log("Il catalogo globale è vuoto.");
        return res.status(200).json([]); 
    }
    
    const allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl && p.searchableIndex && Array.isArray(p.searchableIndex)); 
      
    console.log(`Trovati ${allProducts.length} prodotti validi in totale nel DB.`);
    
    if (allProducts.length === 0) {
        console.log("Nessun prodotto valido nel catalogo dopo il filtro iniziale.");
        return res.status(200).json([]);
    }

    const searchTerms = extractKeywords(userPreferences);
    console.log(`Termini di ricerca estratti dall'utente: [${searchTerms.join(', ')}]`);
    
    let scoredProducts = [];
    allProducts.forEach(product => {
        let score = 0;
        let bestMatchTerm = '';
        
        const productSearchIndexSet = new Set(product.searchableIndex || []);

        searchTerms.forEach(term => {
            if (productSearchIndexSet.has(term)) {
                const pName = (product.productName || '').toLowerCase();
                const pBrand = (product.brand || '').toLowerCase();
                const pCategory = (product.productCategory || '').toLowerCase();

                if (pName.includes(term) || pBrand.includes(term)) {
                    score += 100; 
                    if (!bestMatchTerm) bestMatchTerm = product.brand || term;
                } else if (pCategory.includes(term)) {
                    score += 50;
                    if (!bestMatchTerm) bestMatchTerm = product.productCategory || term;
                } else {
                    score += 10;
                    if (!bestMatchTerm) bestMatchTerm = term;
                }
            }
        });
        
        if (score > 0) {
            scoredProducts.push({ product, score, bestMatchTerm });
        }
    });

    // Ordiniamo i prodotti per punteggio (dal più alto al più basso)
    scoredProducts.sort((a, b) => b.score - a.score);

    // ==========================================================
    //  ADESSO PRENDIAMO TUTTI I PRODOTTI PERTINENTI (fino a un massimo di 50 per praticità)
    // ==========================================================
    let finalSuggestions = scoredProducts.slice(0, 50); // Limite ragionevole per la UI dell'app
    
    if (finalSuggestions.length === 0) {
        console.log("Nessun prodotto pertinente trovato con il sistema a punti. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    // Costruiamo le risposte finali per l'app
    const suggestions = finalSuggestions.map(item => {
        const product = item.product;
        const aiExplanation = generateMagicPhrase(item.bestMatchTerm, product.brand, product.productCategory);
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
    return res.status(500).json({ error: 'Errore interno del nostro assistente di ricerca.' });
  }
};

function extractKeywords(userPreferences) {
    const text = userPreferences.personDescription || '';
    if (!text.trim()) return [];
    const cleanedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
    const rawKeywords = cleanedText.split(' ');
    
    const uniqueKeywords = new Set();
    rawKeywords.forEach(word => {
        if (word.length > 2 && !STOP_WORDS.has(word)) { 
            uniqueKeywords.add(word);
        }
    });
    return Array.from(uniqueKeywords);
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
