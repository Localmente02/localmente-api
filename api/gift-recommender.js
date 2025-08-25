// api/gift-recommender.js
// VERSIONE 2.0 - FORNITORE DI DATI PER LA CACHE UNIVERSALE
// Questo cervello non fa più calcoli. Il suo unico scopo è scaricare
// TUTTI i documenti rilevanti da Firebase e passarli all'app.

const admin = require('firebase-admin');

// Inizializzazione sicura di Firebase Admin
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error', e.stack);
}
const db = admin.firestore();


// La funzione helper ora recupera un'intera collezione senza limiti.
const fetchAllFromCollection = async (collectionName, type) => {
  try {
    console.log(`Inizio recupero di TUTTI i documenti da '${collectionName}'...`);
    const snapshot = await db.collection(collectionName).get();
    
    if (snapshot.empty) {
      console.log(`Nessun documento trovato in '${collectionName}'.`);
      return [];
    }
    
    const results = snapshot.docs.map(doc => {
      return {
        id: doc.id,   // L'ID del documento è la cosa più importante
        type: type,   // Il tipo (product, vendor, offer)
        data: doc.data() // Tutti i dati del documento
      };
    });

    console.log(`Recuperati ${results.length} documenti da '${collectionName}'.`);
    return results;
  } catch (error) {
    console.error(`Errore durante il recupero dalla collezione '${collectionName}':`, error);
    // In caso di errore per una collezione, restituiamo un array vuoto per non bloccare tutto.
    return [];
  }
};


module.exports = async (req, res) => {
  // Impostazioni CORS per permettere all'app di chiamare l'API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  try {
    // La query non viene più usata per filtrare, ma solo per avviare il processo.
    console.log("Richiesta ricevuta per popolare la cache universale.");

    // Eseguiamo tutte le chiamate a Firebase in parallelo per massima velocità
    const [products, vendors /*, offers*/] = await Promise.all([
      fetchAllFromCollection('global_product_catalog', 'product'),
      fetchAllFromCollection('vendors', 'vendor'),
      // Se avrai una collezione 'special_offers', decommenta questa riga
      // fetchAllFromCollection('special_offers', 'offer'), 
    ]);

    // Combiniamo tutti i risultati in un unico grande array
    const allResults = [
        ...products, 
        ...vendors
        /*, ...offers*/
    ];
    
    console.log(`Totale risultati combinati: ${allResults.length}. Invio all'app...`);

    // Inviamo l'array completo all'app. L'app si occuperà di salvarlo in cache.
    // Il formato è stato semplificato: non c'è più `aiExplanation`, verrà generato nell'app.
    return res.status(200).json(allResults);

  } catch (error) {
    console.error('ERRORE GRAVE GENERALE NELLA FUNZIONE DI FETCH:', error);
    return res.status(500).json({ error: 'Errore interno del fornitore di dati. Controlla i log di Vercel.' });
  }
};
