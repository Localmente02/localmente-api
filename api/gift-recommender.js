// api/gift-recommender.js
// IL CERVELLO DELLA RICERCA UNIVERSALE (ORDINE CORRETTO)

const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

// Parole comuni da ignorare nella ricerca, ampliate per essere più efficaci
const STOP_WORDS = new Set([
    'e', 'un', 'una', 'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'gli', 'le', 'i', 'il', 'lo', 'la', // Articoli e preposizioni
    'mio', 'tuo', 'suo', 'un\'', 'degli', 'del', 'della', 'perche', 'come', 'cosa', 'chi', 'quale', 'dove', // Pronomi e interrogativi
    'ama', 'piacciono', 'qualsiasi', 'regalo', 'vorrei', 'fare', 'regalare', 'cerco', 'cerca', 'trova', 'mostrami', // Verbi e richieste comuni
    'amico', 'amica', 'nipote', 'nonna', 'nonno', 'mamma', 'papa', 'figlio', 'figlia', 'fratello', 'sorella', 'collega', 'partner', // Relazioni
    'nuove', 'vecchie', 'belle', 'brutte', 'buone', 'cattive', 'migliori', 'peggiori', 'di', 'marca', 'comode', 'sportive', 'eleganti', // Aggettivi generici
    'che', 'vende', 'vendono', 'venduta', 'venduto', 'in', 'citta', 'o', 'delle', 'dei', 'della', 'con', 'a', 'b' // Parole aggiuntive rilevate nei test
]);

// Frasi predefinite per la spiegazione dei risultati (ora più generiche/specifiche per tipo)
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
//  FUNZIONI DI SUPPORTO (ORA POSIZIONATE IN CIMA)
// ==========================================================

// Estrae parole chiave dalla query dell'utente
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

// Assegna un punteggio a un singolo elemento (prodotto, vendor, offer)
function scoreItem(item, searchTerms, itemType, specificSearchableText = null) {
    let score = 0;
    let bestMatchTerm = '';
    
    let itemSearchableWords = [];
    if (itemType === 'product' && Array.isArray(item.searchableIndex)) {
        itemSearchableWords = item.searchableIndex.map(w => (w || '').toLowerCase());
    } else {
        const text = (specificSearchableText || JSON.stringify(item)).toLowerCase();
        itemSearchableWords = text.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').split(' ').filter(word => word.length > 2);
    }
    const itemSearchableSet = new Set(itemSearchableWords);

    searchTerms.forEach(term => {
        if (itemSearchableSet.has(term)) {
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
    const productsSnapshot = await db.collection('global_product_catalog').limit(500).get(); // Limite a 500 per i prodotti
    productsSnapshot.docs.forEach(doc => {
        try {
            const product = doc.data();
            if (product.productName && product.price != null && product.productImageUrl && Array.isArray(product.searchableIndex)) {
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
    const vendorsSnapshot = await db.collection('vendors').limit(200).get(); // Limite a 200 per i negozi
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


    // --- RICERCA OFFERS (Offerte speciali) ---
    console.log("Fase: Ricerca offerte speciali...");
    const offersSnapshot = await db.collection('offers').limit(100).get(); // Limite a 100 per le offerte
    offersSnapshot.docs.forEach(doc => {
        try {
            const offer = doc.data();
            const offerSearchableText = [
                offer.title, offer.description, offer.promotionMessage,
                offer.productName, offer.brand, offer.productCategory
            ].filter(Boolean).join(' ').toLowerCase();

            const scoreData = scoreItem(offer, searchTerms, 'offer', offerSearchableText);
            if (scoreData.score > 0) {
                allResults.push({ type: 'offer', data: offer, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
            }
        } catch (e) {
            console.error(`Errore nel processare documento offerta ${doc.id}: ${e.message}`);
        }
    });
    console.log(`Risultati offerta iniziali: ${allResults.filter(r => r.type === 'offer').length}`);

    
    // Ordina tutti i risultati combinati per punteggio
    allResults.sort((a, b) => b.score - a.score);

    let finalSuggestions = allResults.slice(0, 50); // Limite ragionevole per la UI dell'app
    
    if (finalSuggestions.length === 0) {
        console.log("Nessun risultato pertinente trovato. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    // Genera le spiegazi
