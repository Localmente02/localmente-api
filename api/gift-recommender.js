// api/gift-recommender.js
// IL CERVELLO DELLA RICERCA UNIVERSALE (FLESSIBILE CON GLI SPAZI)

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
    'devo', 'posso', 'voglio', 'bisogno'
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
    vendor_default: "Scopri questo negozio: potrebbe avere quello che cerchi.",

    offer_title: "Non perderti l'offerta: [TERM]!",
    offer_default: "Un'opportunità da non perdere, proprio quello che cercavi.",

    default: "Ecco alcuni suggerimenti pertinenti dalla nostra piattaforma."
};


// ==========================================================
//  FUNZIONI DI SUPPORTO (POSIZIONATE IN CIMA)
// ==========================================================

// Estrae parole chiave dalla query dell'utente (MODIFICATA)
function extractKeywords(userPreferences) {
    const text = userPreferences.personDescription || '';
    if (!text.trim()) return [];
    
    // Pulisce il testo e lo divide in parole separate da spazio singolo
    const cleanedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const rawWords = cleanedText.split(' ');
    
    const uniqueKeywords = new Set();
    
    // Aggiungi le parole singole (filtrando le stop words)
    rawWords.forEach(word => {
        if (word.length > 2 && !STOP_WORDS.has(word)) {
            uniqueKeywords.add(word);
        }
    });

    // Aggiungi le frasi multi-parola e le loro versioni compattate (senza spazi)
    for (let i = 0; i < rawWords.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, rawWords.length + 1); j++) { // Considera frasi fino a 3 parole
            const phrase = rawWords.slice(i, j).join(' ');
            if (phrase.length > 2 && !STOP_WORDS.has(phrase)) { // Filtra anche le frasi stop words
                uniqueKeywords.add(phrase); // Esempio: "barsi sport"
                uniqueKeywords.add(phrase.replace(/\s/g, '')); // Esempio: "barsisport"
            }
        }
    }

    return Array.from(uniqueKeywords);
}


// Assegna un punteggio a un singolo elemento (prodotto, vendor, offer)
function scoreItem(item, searchTerms, itemType, specificSearchableText = null) {
    let score = 0;
    let bestMatchTerm = '';
    
    // Combina tutte le parole del searchableIndex o il testo specifico in una singola stringa per la ricerca
    const itemFullText = itemType === 'product' && Array.isArray(item.searchableIndex)
        ? item.searchableIndex.join(' ').toLowerCase() // searchIndex è già un array di parole pulite
        : (specificSearchableText || JSON.stringify(item)).toLowerCase();

    searchTerms.forEach(term => {
        // Usa includes() per la flessibilità (mela vs mele, nike vs niike, barsisport vs barsi sport)
        if (itemFullText.includes(term)) {
            let termScore = 0;
            // Punteggi pesati in base al tipo di elemento e dove si trova il match
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

                    if (vStoreName.includes(term) || vVendorName.includes(term)) { termScore = 2000; }
                    else if (vCategory.includes(term)) { termScore = 900; }
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


// Genera la spiegazione basata sul tipo di elemento e sul match
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
    
    // --- RICERCA PRODOTTI ---
    console.log("Fase: Ricerca prodotti nel catalogo globale...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(500).get();
    productsSnapshot.docs.forEach(doc => {
        try {
            const product = doc.data();
            if (product.productName && product.price != null && product.productImageUrl && Array.isArray(product.searchableIndex) && product.searchableIndex.length > 0) {
                const scoreData = scoreItem(product, searchTerms, 'product');
                if (scoreData.score > 0) {
                    allResults.push({ type: 'product', data: product, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
                }
            }
        } catch (e) {
            console.error(`Errore nel processare documento prodotto ${doc.id}: ${e.message}`);
        }
    });
    console.log(`Risultati prodotti iniziali: ${allResults.filter(r => r.type === 'product').length}`);


    // --- RICERCA VENDORS (Negozi/Attività) ---
    console.log("Fase: Ricerca negozi/attività...");
    const vendorsSnapshot = await db.collection('vendors').limit(200).get();
    vendorsSnapshot.docs.forEach(doc => {
        try {
            const vendor = doc.data();
            const vendorSearchableText = [
                vendor.store_name, vendor.vendor_name, vendor.address, vendor.category, vendor.subCategory,
                (vendor.tags || []).join(' '), vendor.slogan, vendor.time_info, vendor.userType
            ].filter(Boolean).join(' ').toLowerCase();

            const scoreData = scoreItem(vendor, searchTerms, 'vendor', vendorSearchableText);
            if (scoreData.score > 0) {
                allResults.push({ type: 'vendor', data: vendor, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
            }
        } catch (e) {
            console.error(`Errore nel processare documento vendor ${doc.id}: ${e.message}`);
        }
    });
    console.log(`Risultati vendor iniziali: ${allResults.filter(r => r.type === 'vendor').length}`);

    // Ordina tutti i risultati combinati per punteggio
    allResults.sort((a, b) => b.score - a.score);

    let finalSuggestions = allResults.slice(0, 50);
    
    if (finalSuggestions.length === 0) {
        console.log("Nessun risultato pertinente trovato. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    // Genera le spiegazioni per i risultati finali
    const responseSuggestions = finalSuggestions.map(item => {
        const explanation = generateExplanation(item.type, item.bestMatchTerm, item.data);
        return {
            id: item.data.id || item.id || `unknown-id-${item.type}`,
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
