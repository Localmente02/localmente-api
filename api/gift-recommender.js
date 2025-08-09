// api/gift-recommender.js
// Questa è la versione FINALE del CERVELLO per la Ricerca Totale.

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
    'nuove', 'vecchie', 'belle', 'brutte', 'buone', 'cattive', 'migliori', 'peggiori', 'di', 'marca', 'comode', 'sportive', 'eleganti' // Aggettivi generici
]);

// Frasi predefinite per la spiegazione dei risultati
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
    Farmaci: "Per la tua salute e benessere quotidiano.", // Esempio per Farmacia
    default: "Un suggerimento in linea con la tua ricerca."
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Metodo non consentito' }); }

  try {
    const userPreferences = req.body; // userPreferences.personDescription contiene la query dell'utente
    
    console.log("Ricerca Totale: Carico fino a 1000 prodotti da tutto il catalogo...");
    const productsSnapshot = await db.collection('global_product_catalog').limit(1000).get();
    
    if (productsSnapshot.empty) { 
        console.log("Il catalogo globale è vuoto.");
        return res.status(200).json([]); 
    }
    
    // Filtro di base per validità: deve avere nome, prezzo e immagine
    const allProducts = productsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => p.productName && p.price != null && p.productImageUrl && p.searchableIndex && Array.isArray(p.searchableIndex)); 
      // Aggiunto controllo su searchableIndex perché ora è vitale

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
        let bestMatchTerm = ''; // Termine che ha dato il punteggio più alto, per la frase magica
        
        // Convertiamo in un Set per ricerche veloci
        const productSearchIndexSet = new Set(product.searchableIndex || []);

        searchTerms.forEach(term => {
            if (productSearchIndexSet.has(term)) {
                // Aggiungiamo punti pesati in base al campo originario (se riesco a ricavarlo)
                // Questa logica assume che searchableIndex contenga tutte le parole.
                // Per un punteggio più raffinato, ri-controlliamo i campi originali.
                const pName = (product.productName || '').toLowerCase();
                const pBrand = (product.brand || '').toLowerCase();
                const pCategory = (product.productCategory || '').toLowerCase();

                if (pName.includes(term) || pBrand.includes(term)) {
                    score += 100; // Punteggio altissimo per match nel nome o brand
                    if (!bestMatchTerm) bestMatchTerm = product.brand || term;
                } else if (pCategory.includes(term)) {
                    score += 50; // Punteggio alto per match nella categoria
                    if (!bestMatchTerm) bestMatchTerm = product.productCategory || term;
                } else {
                    score += 10; // Punteggio base per match in altri campi (descrizione, keywords)
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

    // Prendiamo i 6 prodotti con il punteggio più alto
    const topProducts = scoredProducts.slice(0, 6);
    
    if (topProducts.length === 0) {
        console.log("Nessun prodotto pertinente trovato dopo il sistema a punti. Restituisco lista vuota.");
        return res.status(200).json([]);
    }
    
    // Costruiamo le risposte finali per l'app
    const suggestions = topProducts.map(item => {
        const product = item.product;
        // La frase magica è generata basandosi sul termine che ha dato il miglior match
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

// Funzione per estrarre parole chiave dalla query dell'utente
function extractKeywords(userPreferences) {
    const text = userPreferences.personDescription || '';
    if (!text.trim()) return [];
    // Pulizia del testo: solo caratteri alfanumerici e spazi, poi split per parole
    const cleanedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
    const rawKeywords = cleanedText.split(' ');
    
    // Filtra le stop words e i duplicati
    const uniqueKeywords = new Set();
    rawKeywords.forEach(word => {
        if (word.length > 2 && !STOP_WORDS.has(word)) { // Solo parole di almeno 3 caratteri e non stop words
            uniqueKeywords.add(word);
        }
    });
    return Array.from(uniqueKeywords);
}

// Funzione per generare la frase magica
function generateMagicPhrase(term, brand, category) {
    const searchTerm = (term || '').toLowerCase();
    const brandTerm = (brand || '').toLowerCase();
    const categoryTerm = (category || '').toLowerCase();
    
    // Priorità alta per match esatti nei termini predefiniti
    if (MAGIC_PHRASES[searchTerm]) return MAGIC_PHRASES[searchTerm];
    
    // Frase basata sul brand
    if (brand && MAGIC_PHRASES['brand']) return MAGIC_PHRASES['brand'].replace('[TERM]', brand);
    
    // Frase basata sulla categoria esatta
    if (MAGIC_PHRASES[categoryTerm]) return MAGIC_PHRASES[categoryTerm];
    
    // Frase generica per categoria
    if (category && MAGIC_PHRASES['default_category']) return MAGIC_PHRASES['default_category'].replace('[TERM]', category);
    
    return MAGIC_PHRASES['default'];
}

// La funzione getRandomProducts non è più necessaria qui perché restituiamo una lista vuota se non ci sono match pertinenti.
// Se mai volessi un "Piano B" che restituisce casuali se non trova *nulla* di pertinente, dovresti re-implementarla.
