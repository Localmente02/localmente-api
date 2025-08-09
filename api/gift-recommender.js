// api/gift-recommender.js
// IL CERVELLO DELLA RICERCA UNIVERSALE (TROVA NEGOZI, PRODOTTI, OFFERTE)

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
    'che', 'vende', 'vendono', 'venduta', 'venduto', 'in', 'citta', 'o', 'delle', 'dei', 'della', 'con' // Parole aggiuntive rilevate nei test
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userQuery = (req.body.personDescription || '').toLowerCase().trim(); // La query dell'utente
    console.log(`Ricerca Universale: Query utente - "${userQuery}"`);
    
    const searchTerms = extractKeywords({ personDescription: userQuery });
    console.log(`Termini di ricerca estratti: [${searchTerms.join(', ')}]`);

    let allResults = []; // Contiene prodotti, negozi, offerte
    
    // --- RICERCA PRODOTTI ---
    console.log("Ricerca prodotti nel catalogo globale...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(500).get(); // Limite a 500 per i prodotti
    productsSnapshot.docs.forEach(doc => {
        const product = doc.data();
        if (product.productName && product.price != null && product.productImageUrl && product.searchableIndex && Array.isArray(product.searchableIndex)) {
            const scoreData = scoreItem(product, searchTerms, 'product');
            if (scoreData.score > 0) {
                allResults.push({ type: 'product', data: product, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
            }
        }
    });

    // --- RICERCA VENDORS (Negozi/Attività) ---
    console.log("Ricerca negozi/attività...");
    const vendorsSnapshot = await db.collection('vendors').limit(200).get(); // Limite a 200 per i negozi
    vendorsSnapshot.docs.forEach(doc => {
        const vendor = doc.data();
        // Concatena tutti i campi testuali rilevanti per la ricerca di un negozio
        const vendorSearchableText = [
            vendor.store_name, vendor.vendor_name, vendor.address, vendor.category, vendor.subCategory,
            (vendor.tags || []).join(' '), vendor.slogan, vendor.time_info, vendor.userType
        ].filter(Boolean).join(' ').toLowerCase();

        const scoreData = scoreItem(vendor, searchTerms, 'vendor', vendorSearchableText);
        if (scoreData.score > 0) {
            allResults.push({ type: 'vendor', data: vendor, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
        }
    });

    // --- RICERCA OFFERS (Offerte speciali) ---
    console.log("Ricerca offerte speciali...");
    const offersSnapshot = await db.collection('offers').limit(100).get(); // Limite a 100 per le offerte
    offersSnapshot.docs.forEach(doc => {
        const offer = doc.data();
        // Concatena tutti i campi testuali rilevanti per la ricerca di un'offerta
        const offerSearchableText = [
            offer.title, offer.description, offer.promotionMessage,
            offer.productName, offer.brand, offer.productCategory
        ].filter(Boolean).join(' ').toLowerCase();

        const scoreData = scoreItem(offer, searchTerms, 'offer', offerSearchableText);
        if (scoreData.score > 0) {
            allResults.push({ type: 'offer', data: offer, score: scoreData.score, bestMatchTerm: scoreData.bestMatchTerm });
        }
    });
    
    // Ordina tutti i risultati combinati per punteggio
    allResults.sort((a, b) => b.score - a.score);

    // Prendiamo un numero ragionevole di risultati (es. top 50)
    let finalSuggestions = allResults.slice(0, 50); 
    
    if (finalSuggestions.length === 0) {
        console.log("Nessun risultato pertinente trovato dopo tutte le ricerche. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    // Genera le spiegazioni per i risultati finali
    const responseSuggestions = finalSuggestions.map(item => {
        const explanation = generateExplanation(item.type, item.bestMatchTerm, item.data);
        return {
            id: item.data.id,
            type: item.type,
            data: item.data, // Invia tutti i dati originali dell'elemento
            aiExplanation: explanation
        };
    });

    return res.status(200).json(responseSuggestions);

  } catch (error) {
    console.error('ERRORE GRAVE NELLA FUNZIONE:', error);
    return res.status(500).json({ error: 'Errore interno del nostro motore di ricerca. Dettagli nel log di Vercel.' });
  }
};

// --- FUNZIONI DI SUPPORTO ---

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
    
    let itemSearchableText = specificSearchableText;
    if (!itemSearchableText) { // Se non è stato fornito un testo specifico, lo costruiamo
        if (itemType === 'product') {
            itemSearchableText = (item.searchableIndex || []).join(' ');
        } else {
            // Fallback generico se non è prodotto e non ha specificSearchableText
            itemSearchableText = JSON.stringify(item).toLowerCase(); 
        }
    }

    const itemSearchableSet = new Set(itemSearchableText.split(' ').filter(word => word.length > 2));

    searchTerms.forEach(term => {
        if (itemSearchableSet.has(term)) {
            // Punteggi pesati in base al tipo di elemento e dove si trova il match
            switch (itemType) {
                case 'product':
                    const pName = (item.productName || '').toLowerCase();
                    const pBrand = (item.brand || '').toLowerCase();
                    const pCategory = (item.productCategory || '').toLowerCase();

                    if (pName.includes(term) || pBrand.includes(term)) { score += 1000; } // Altissima priorità per nome/brand prodotto
                    else if (pCategory.includes(term)) { score += 500; } // Alta priorità per categoria prodotto
                    else { score += 100; } // Media priorità per altri campi (descrizione, keywords)
                    break;
                case 'vendor':
                    const vName = (item.store_name || '').toLowerCase();
                    const vBrand = (item.vendor_name || '').toLowerCase(); // Consideriamo il nome del venditore come un "brand"
                    const vCategory = (item.category || '').toLowerCase();

                    if (vName.includes(term) || vBrand.includes(term)) { score += 2000; } // Priorità MASSIMA per nome/vendor
                    else if (vCategory.includes(term)) { score += 800; } // Alta priorità per categoria negozio
                    else { score += 200; } // Media priorità per slogan, tags, etc.
                    break;
                case 'offer':
                    const oTitle = (item.title || '').toLowerCase();
                    const oProdName = (item.productName || '').toLowerCase(); // Offerta su un prodotto
                    const oCategory = (item.productCategory || '').toLowerCase();

                    if (oTitle.includes(term) || oProdName.includes(term)) { score += 1500; } // Alta priorità per titolo offerta/nome prodotto
                    else if (oCategory.includes(term)) { score += 600; } // Media priorità per categoria offerta
                    else { score += 150; } // Bassa priorità per descrizione offerta
                    break;
            }
            if (!bestMatchTerm) bestMatchTerm = term; // Salva il primo termine che ha dato un match
        }
    });
    
    return { score, bestMatchTerm };
}


// Genera la spiegazione basata sul tipo di elemento e sul match
function generateExplanation(itemType, bestMatchTerm, itemData) {
    const term = (bestMatchTerm || '').toLowerCase();
    const brand = (itemData.brand || '').toLowerCase();
    const category = (itemData.productCategory || itemData.category || '').toLowerCase();
    const title = (itemData.title || itemData.productName || '').toLowerCase();

    // Frasi specifiche per il tipo
    if (itemType === 'product') {
        if (EXPLANATION_PHRASES['product_' + term]) return EXPLANATION_PHRASES['product_' + term].replace('[TERM]', term);
        if (brand && EXPLANATION_PHRASES['product_brand']) return EXPLANATION_PHRASES['product_brand'].replace('[TERM]', itemData.brand);
        if (category && EXPLANATION_PHRASES['product_category']) return EXPLANATION_PHRASES['product_category'].replace('[TERM]', itemData.productCategory);
        return EXPLANATION_PHRASES['product_default'];
    } else if (itemType === 'vendor') {
        if (EXPLANATION_PHRASES['vendor_name']) return EXPLANATION_PHRASES['vendor_name'].replace('[TERM]', itemData.store_name || itemData.vendor_name);
        if (category && EXPLANATION_PHRASES['vendor_category']) return EXPLANATION_PHRASES['vendor_category'].replace('[TERM]', itemData.category);
        return EXPLANATION_PHRASES['vendor_default'];
    } else if (itemType === 'offer') {
        if (EXPLANATION_PHRASES['offer_title']) return EXPLANATION_PHRASES['offer_title'].replace('[TERM]', itemData.title || itemData.productName);
        return EXPLANATION_PHRASES['offer_default'];
    }
    
    return EXPLANATION_PHRASES['default'];
}
