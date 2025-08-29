// Importiamo gli strumenti che ci servono. Ora c'è anche Fuse!
const admin = require('firebase-admin');
const Fuse = require('fuse.js');

// Inizializzazione di Firebase. Questo non cambia.
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) { console.error('Firebase Admin Initialization Error', e.stack); }
const db = admin.firestore();

// Funzione per prendere i dati da Firestore. Non cambia.
const fetchAllFromCollection = async (collectionName) => {
  try {
    const snapshot = await db.collection(collectionName).where('isAvailable', '==', true).get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`Errore nel caricare la collezione '${collectionName}':`, error);
    return [];
  }
};

// Questa è la funzione principale che risponde alla tua app
module.exports = async (req, res) => {
  // Gestione CORS e del metodo POST. Non cambia.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });

  try {
    // Prendiamo la parola cercata dall'utente
    const { userQuery } = req.body;
    if (!userQuery) {
      return res.status(400).json({ error: 'Query mancante' });
    }

    // 1. CARICHIAMO TUTTI I DATI DA FIRESTORE
    //    Usiamo Promise.all per caricarli in parallelo, è un po' più veloce.
    const [products, vendors] = await Promise.all([
      fetchAllFromCollection('global_product_catalog'),
      fetchAllFromCollection('vendors')
    ]);
    const allDataToSearch = [...products, ...vendors]; // Uniamo tutto in un'unica lista

    // Se non ci sono dati, restituiamo una lista vuota
    if (allDataToSearch.length === 0) {
      return res.status(200).json({ query: userQuery, results: [] });
    }

    // 2. CONFIGURIAMO IL NOSTRO MOTORE DI RICERCA INTERNO (Fuse.js)
    const options = {
      // Diciamo a Fuse dove deve guardare per trovare le parole.
      // Aggiungi qui altri nomi di campi se necessario (es. 'tags', 'ingredients', ecc.)
      keys: ['productName', 'kitName', 'description', 'brand', 'vendorStoreName', 'name', 'category'],
      
      // La "magia" della tolleranza agli errori. 0.4 è un buon punto di partenza.
      threshold: 0.4, 
      
      // Altre opzioni utili
      includeScore: true,       // Ci aiuta a ordinare i risultati per rilevanza
      minMatchCharLength: 2,    // Non cerca parole di una sola lettera
      ignoreLocation: true,     // Cerca la parola in qualsiasi punto del testo
    };

    // 3. CREIAMO LA RICERCA CON I NOSTRI DATI E LE NOSTRE REGOLE
    const fuse = new Fuse(allDataToSearch, options);

    // 4. ESEGUIAMO LA RICERCA INTELLIGENTE!
    const searchResults = fuse.search(userQuery);

    // 5. PULIAMO I RISULTATI
    //    Prendiamo solo l'oggetto del prodotto, scartando i dati extra di Fuse
    const finalResults = searchResults.map(result => result.item);

    // 6. INVIAMO I RISULTATI GIUSTI ALL'APP
    return res.status(200).json({
      query: userQuery,
      // Abbiamo rimosso la chiamata all'AI per la ricerca. È più veloce e più affidabile.
      // Se vuoi, puoi togliere 'aiResponse' anche dalla risposta che mandi all'app.
      aiResponse: `Risultati per la ricerca: "${userQuery}"`, 
      results: finalResults,
    });

  } catch (error) {
    console.error('[Vercel] ERRORE GRAVE:', error);
    return res.status(500).json({ error: 'Qualcosa è andato storto sul server.' });
  }
};
