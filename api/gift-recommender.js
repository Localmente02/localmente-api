// api/gift-recommender.js
// IL CERVELLO DELLA RICERCA UNIVERSALE (CON RILEVAMENTO INTENZIONE)

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
    'e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la',
    'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della', 'perche', 'come', 'cosa', 'chi', 'quale', 'dove',
    'ama', 'piacciono', 'qualsiasi', 'regalo', 'vorrei', 'fare', 'regalare', 'cerco', 'cerca', 'trova', 'mostrami',
    'amico', 'amica', 'nipote', 'nonna', 'nonno', 'mamma', 'papa', 'figlio', 'figlia', 'fratello', 'sorella', 'collega', 'partner',
    'nuove', 'vecchie', 'belle', 'brutte', 'buone', 'cattive', 'migliori', 'peggiori', 'di', 'marca', 'comode', 'sportive', 'eleganti',
    'che', 'vende', 'vendono', 'venduta', 'venduto', 'in', 'citta', 'o', 'delle', 'dei', 'della', 'con', 'a', 'b',
    'per', 'da', 'su', 'con', 'tra', 'fra', 'se', 'io', 'lui', 'lei', 'noi', 'voi', 'loro', 'questo', 'questa', 'quelli', 'quelle',
    'devo', 'posso', 'voglio', 'bisogno', 'via', 'piazza', 'corso', 'viale', 'strada' // Aggiunte parole per indirizzi/luoghi
]);

const EXPLANATION_PHRASES = {
    product_brand: "Un classico intramontabile di [TERM].",
    product_sport: "L'ideale per il suo spirito sportivo e dinamico.",
    product_neonato: "Un pensiero speciale per dare il benvenuto al nuovo arrivato.",
    product_bambino: "Per stimolare la sua fantasia e il gioco.",
    product_category: "Un'ottima scelta dalla categoria [TERM].",
    product_default: "Un prodotto di qualità in linea con la tua ricerca.",

    vendor_name: "Il negozio [TERM] ha esattamente ciò che cerchi.",
    vendor_category: "Un'attività specializzata in [TERM] vicino a te.",
    vendor_address: "Abbiamo trovato un'attività in [TERM] che potrebbe interessarti.",
    vendor_default: "Scopri questo negozio: potrebbe avere quello che cerchi.",

    offer_title: "Non perderti l'offerta: [TERM]!",
    offer_default: "Un'opportunità da non perdere, proprio quello che cercavi.",

    default: "Ecco alcuni suggerimenti pertinenti dalla nostra piattaforma."
};


// ==========================================================
//  NUOVE FUNZIONI DI SUPPORTO PER IL RILEVAMENTO INTENZIONE
// ==========================================================

function detectIntent(userQuery, searchTerms) {
    const query = userQuery.toLowerCase();

    // Regole per rilevare l'intenzione
    // Priorità alta: Termini specifici o categorie
    if (searchTerms.includes('farmacia') || searchTerms.includes('farmaci')) return 'pharmacy';
    if (searchTerms.includes('alimentari') || searchTerms.includes('cibo') || searchTerms.includes('kit') || searchTerms.includes('carbonara') || searchTerms.includes('pasta') || searchTerms.includes('pane') || searchTerms.includes('verdura') || searchTerms.includes('frutta')) return 'food_grocery';
    if (searchTerms.includes('artigiano') || searchTerms.includes('creazione') || searchTerms.includes('fattoamano')) return 'artisan';
    if (searchTerms.includes('meccanico') || searchTerms.includes('gommista') || searchTerms.includes('elettrauto')) return 'service_vehicle';
    if (searchTerms.includes('idraulico') || searchTerms.includes('elettricista') || searchTerms.includes('casa')) return 'service_home';
    if (searchTerms.includes('parrucchiere') || searchTerms.includes('estetista') || searchTerms.includes('benessere')) return 'service_wellness';
    if (searchTerms.includes('noleggio')) return 'rental';
    if (searchTerms.includes('bar') || searchTerms.includes('colazione')) return 'bar';

    // Priorità media: Ricerca di un negozio per nome o indirizzo
    const addressKeywords = ['via', 'piazza', 'corso', 'viale', 'strada', 'largo', 'vicolo'];
    if (addressKeywords.some(keyword => query.includes(keyword)) || query.split(' ').length <= 2 && !searchTerms.some(t => ['scarpe', 'orologio', 'zaino'].includes(t))) { // Se la query è corta e sembra un indirizzo o un nome di negozio
        return 'vendor_general';
    }

    // Priorità bassa: Se non rientra in categorie specifiche, è un prodotto generico o un'offerta
    // Se la query include parole come "sconto", "offerta", "promozione"
    if (searchTerms.includes('sconto') || searchTerms.includes('offerta') || searchTerms.includes('promozione')) return 'offer';


    // Default: Prodotto generico
    return 'product_general';
}

// Estrae parole chiave dalla query dell'utente
function extractKeywords(userPreferences) {
    const text = userPreferences.personDescription || '';
    if (!text.trim()) return [];
    
    const cleanedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const rawWords = cleanedText.split(' ');
    
    const uniqueKeywords = new Set();
    
    rawWords.forEach(word => {
        if (word.length > 2 && !STOP_WORDS.has(word)) {
            uniqueKeywords.add(word);
        }
    });

    for (let i = 0; i < rawWords.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, rawWords.length + 1); j++) {
            const phrase = rawWords.slice(i, j).join(' ');
            if (phrase.length > 2 && !STOP_WORDS.has(phrase)) {
                uniqueKeywords.add(phrase);
                uniqueKeywords.add(phrase.replace(/\s/g, ''));
            }
        }
    }
    return Array.from(uniqueKeywords);
}

// Assegna un punteggio a un singolo elemento (prodotto, vendor, offer)
function scoreItem(item, searchTerms, itemType, specificSearchableText = null) {
    let score = 0;
    let bestMatchTerm = '';
    
    const itemFullText = itemType === 'product' && Array.isArray(item.searchableIndex)
        ? item.searchableIndex.join(' ').toLowerCase()
        : (specificSearchableText || JSON.stringify(item)).toLowerCase();

    searchTerms.forEach(term => {
        if (itemFullText.includes(term)) {
            let termScore = 0;
            switch (itemType) {
                case 'product':
                    const pName = (item.productName || '').toLowerCase();
                    const pBrand = (item.brand || '').toLowerCase();
                    const pCategory = (item.productCategory || '').toLowerCase();

                    if (pName.includes(term)) { termScore = 1500; }
                    else if (pBrand.includes(term)) { termScore = 1200; }
                    else if (pCategory.includes(term)) { termScore = 800; }
                    else { termScore = 300; }
                    break;
                case 'vendor':
                    const vStoreName = (item.store_name || '').toLowerCase();
                    const vVendorName = (item.vendor_name || '').toLowerCase();
                    const vCategory = (item.category || '').toLowerCase();
                    const vAddress = (item.address || '').toLowerCase(); // Per indirizzi
                    
                    if (vStoreName.includes(term) || vVendorName.includes(term)) { termScore = 2000; }
                    else if (vCategory.includes(term)) { termScore = 900; }
                    else if (vAddress.includes(term)) { termScore = 1500; } // Indirizzo ha alta priorità per negozi
                    else { termScore = 400; }
                    break;
                case 'offer':
                    const oTitle = (item.title || '').toLowerCase();
                    const oProdName = (item.productName || '').toLowerCase();
                    const oBrand = (item.brand || '').toLowerCase();
                    
                    if (oTitle.includes(term)) { termScore = 1800; }
                    else if (oProdName.includes(term) || oBrand.includes(term)) { termScore = 1000; }
                    else { termScore = 500; }
                    break;
            }
            score += termScore;
            if (termScore > 0 && !bestMatchTerm) bestMatchTerm = term;
        }
    });
    
    return { score, bestMatchTerm };
}

function generateExplanation(itemType, bestMatchTerm, itemData) {
    const term = (bestMatchTerm || '').toLowerCase();
    const brand = (itemData.brand || '').toLowerCase();
    const category = (itemData.productCategory || itemData.category || '').toLowerCase();
    const name = (itemData.productName || itemData.store_name || itemData.vendor_name || itemData.title || '').toLowerCase();

    const getPhrase = (key, placeholderTerm = '') => {
        if (EXPLANATION_PHRASES[key]) {
            return EXPLANATION_PHRASES[key].replace('[TERM]', placeholderTerm);
        }
        return EXPLANATION_PHRASES['default'];
    };

    switch (itemType) {
        case 'product':
            if (EXPLANATION_PHRASES['product_' + term]) return getPhrase('product_' + term, term);
            if (brand && EXPLANATION_PHRASES['product_brand']) return getPhrase('product_brand', itemData.brand);
            if (category && EXPLANATION_PHRASES['product_category']) return getPhrase('product_category', itemData.productCategory);
            return getPhrase('product_default');
        case 'vendor':
            if (EXPLANATION_PHRASES['vendor_name']) return getPhrase('vendor_name', itemData.store_name || itemData.vendor_name);
            if (EXPLANATION_PHRASES['vendor_address'] && itemData.address && (term.includes('via') || term.includes('piazza'))) return getPhrase('vendor_address', itemData.address);
            if (category && EXPLANATION_PHRASES['vendor_category']) return getPhrase('vendor_category', itemData.category);
            return getPhrase('vendor_default');
        case 'offer':
            if (EXPLANATION_PHRASES['offer_title']) return getPhrase('offer_title', itemData.title || itemData.productName);
            return getPhrase('offer_default');
        default:
            return getPhrase('default');
    }
}


// ==========================================================
//  FUNZIONE PRINCIPALE EXPORT (module.exports)
// ==========================================================
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body;
    const userQuery = (userPreferences.personDescription || '').toLowerCase().trim();
    console.log(`Ricerca Universale: Query utente - "${userQuery}"`);
    
    const searchTerms = extractKeywords({ personDescription: userQuery });
    console.log(`Termini di ricerca estratti: [${searchTerms.join(', ')}]`);

    let allResults = [];
    
    // Rileva l'intenzione dell'utente
    const intent = detectIntent(userQuery, searchTerms);
    console.log(`Intenzione rilevata: ${intent}`);

    // === RICERCA CONDIZIONALE BASATA SULL'INTENZIONE ===
    if (intent === 'vendor_general' || intent === 'pharmacy' || intent === 'food_grocery' || intent === 'artisan' || intent === 'service_vehicle' || intent === 'service_home' || intent === 'service_wellness' || intent === 'rental' || intent === 'bar') {
        console.log(`Eseguo ricerca mirata per negozi/attività (${intent})...`);
        let vendorsQuery = db.collection('vendors');
        
        // Filtri per userType specifici se l'intenzione è molto chiara
        if (intent === 'pharmacy') vendorsQuery = vendorsQuery.where('userType', '==', 'farmacia');
        else if (intent === 'food_grocery') vendorsQuery = vendorsQuery.where('userType', '==', 'alimentari');
        else if (intent === 'artisan') vendorsQuery = vendorsQuery.where('userType', '==', 'artigiano');
        else if (intent === 'service_vehicle' || intent === 'service_home' || intent === 'service_wellness' || intent === 'rental' || intent === 'bar') {
            vendorsQuery = vendorsQuery.where('userType', '==', 'multi'); // Tutti i servizi e bar sono 'multi'
        }

        const vendorsSnapshot = await vendorsQuery.limit(50).get(); // Limite più generoso per negozi mirati
        vendorsSnapshot.docs.forEach(doc => {
            try {
                const vendor = doc.data();
                vendor.id = doc.id;
                const vendorSearchableText = [
                    vendor.store_name, vendor.vendor_name, vendor.address, vendor.category, vendor.subCategory,
                    (vendor.tags || []).join(' '), vendor.slogan, vendor.time_info, vendor.userType
                ].filter(Boolean).join(' ').toLowerCase();

                const scoreData = scoreItem(vendor, searchTerms, 'vendor', vendorSearchableText);
                if (scoreData.score > 0) {
                    allResults.push({ type: 'vendor', data: vendor, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
                }
            } catch (e) { console.error(`Errore nel processare documento vendor ${doc.id}: ${e.message}`); }
        });
        console.log(`Risultati vendor mirati: ${allResults.filter(r => r.type === 'vendor').length}`);

        // Se cerchiamo un negozio specifico, potremmo anche voler i suoi prodotti come secondari
        // Questa è una logica complessa, per ora priorità al negozio.
    }

    if (intent === 'product_general' || allResults.length < 5) { // Se l'intenzione è generica o abbiamo pochi risultati
        console.log("Fase: Ricerca prodotti nel catalogo globale (generica o di riempimento)...");
        const productsSnapshot = await db.collection('global_product_catalog').limit(100).get(); // Limite aumentato per più prodotti
        productsSnapshot.docs.forEach(doc => {
            try {
                const product = doc.data();
                product.id = doc.id;
                if (product.productName && product.price != null && product.productImageUrl && Array.isArray(product.searchableIndex) && product.searchableIndex.length > 0) {
                    const scoreData = scoreItem(product, searchTerms, 'product');
                    if (scoreData.score > 0) {
                        allResults.push({ type: 'product', data: product, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
                    }
                }
            } catch (e) { console.error(`Errore nel processare documento prodotto ${doc.id}: ${e.message}`); }
        });
        console.log(`Risultati prodotti generali: ${allResults.filter(r => r.type === 'product').length}`);
    }

    // Le offerte (sezione 'offers' vera e propria) possono essere cercate a prescindere o solo se l'intenzione è 'offer'
    // Per ora le manteniamo fuori, come da nostra ultima decisione.
    // Se avrai una collezione 'special_offers_reali', la cercheremo qui.

    // Rimuovi duplicati (se un prodotto/vendor/offerta appare due volte) e ordina
    const uniqueResults = new Map();
    allResults.forEach(result => {
        // Usa una chiave unica combinata per identificare i duplicati (es. 'product_ID', 'vendor_ID')
        const uniqueKey = `${result.type}_${result.id}`;
        // Sovrascrivi solo se il nuovo elemento ha un punteggio più alto
        if (!uniqueResults.has(uniqueKey) || uniqueResults.get(uniqueKey).score < result.score) {
            uniqueResults.set(uniqueKey, result);
        }
    });

    let finalSortedResults = Array.from(uniqueResults.values()).sort((a, b) => b.score - a.score);

    // Limitiamo a 50 risultati finali per non sovraccaricare l'app
    let finalSuggestions = finalSortedResults.slice(0, 50); 
    
    if (finalSuggestions.length === 0) {
        console.log("Nessun risultato pertinente trovato. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    const responseSuggestions = finalSuggestions.map(item => {
        const explanation = generateExplanation(item.type, item.bestMatchTerm, item.data);
        return {
            id: item.data.id || `unknown-id-${item.type}`,
            type: item.type,
            data: item.data,
            aiExplanation: explanation
        };
    });

    console.log(`Invio ${responseSuggestions.length} risultati finali all'app.`);
    return res.status(200).json(responseSuggestions);

  } catch (error) {
    console.error('ERRORE GRAVE GENERALE NELLA FUNZIONE:', error);
    return res.status(500).json({ error: 'Errore interno del motore di ricerca. Controlla i log di Vercel per i dettagli.' });
  }
};
