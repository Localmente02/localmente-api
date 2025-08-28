const admin = require('firebase-admin');
const OpenAI = require('openai');
const translate = require('@iamtraction/google-translate');

// 🔹 Inizializzazione Firebase Admin
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
      ),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error', e.stack);
}
const db = admin.firestore();

// 🔹 Configurazione OpenRouter AI
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// 🔹 Funzione helper: legge una collezione intera
const fetchAllFromCollection = async (collectionName, type) => {
  try {
    // console.log(`[Vercel] Inizio fetch da collezione: ${collectionName} con tipo predefinito: ${type}`); // <<< NUOVO LOG
    const snapshot = await db.collection(collectionName)
                               .where('isAvailable', '==', true) // Filtra solo i kit disponibili
                               .get();
    if (snapshot.empty) {
      // console.log(`[Vercel] Nessun documento trovato in ${collectionName}.`); // <<< NUOVO LOG
      return [];
    }

    const items = snapshot.docs.map(doc => {
      const data = doc.data();
      const docType = data.type || type;
      // console.log(`[Vercel] Trovato documento ID: ${doc.id}, Type: ${docType}, isAvailable: ${data.isAvailable}`); // <<< NUOVO LOG
      return {
        id: doc.id,
        type: docType,
        data: data
      };
    });
    // console.log(`[Vercel] Finito fetch da ${collectionName}. Trovati ${items.length} elementi.`); // <<< NUOVO LOG
    return items;
  } catch (error) {
    console.error(`[Vercel] Errore fetch collezione '${collectionName}':`, error);
    return [];
  }
};

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });

  try {
    let { userQuery } = req.body;
    // userQuery non è più usato qui per il fetch 'all', quindi possiamo rimuovere la traduzione o usarla per l'AI
    // Se userQuery è 'all', lo trattiamo come una richiesta per tutti i dati senza AI.
    const isAllDataRequest = userQuery === 'all';

    // Se non è una richiesta per tutti i dati, facciamo la traduzione e la AI
    let translatedQuery = userQuery;
    let aiResponse = null;

    if (!isAllDataRequest) {
        try {
            const result = await translate(userQuery, { to: 'it' });
            translatedQuery = result.text;
        } catch (err) {
            console.error('[Vercel] Errore traduzione:', err);
        }
    }


    // 🔹 Recupero dati dalle collezioni Firestore
    // MODIFICATO: Includiamo i kit dal global_product_catalog con type: 'kit'
    const [globalCatalogItems, vendors] = await Promise.all([
      fetchAllFromCollection('global_product_catalog', 'product'), 
      fetchAllFromCollection('vendors', 'vendor'),
    ]);
    const relevantData = [...globalCatalogItems, ...vendors];

    // console.log(`[Vercel] Dati totali da Firestore prima dell'AI: ${relevantData.length} elementi.`); // <<< NUOVO LOG
    // relevantData.forEach(item => {
    //   if (item.type === 'kit') { // <<< NUOVO LOG: Metti questo tra commenti una volta risolto il problema >>>
    //     console.log(`[Vercel - KIT DETTAGLIO] ID: ${item.id}, Name: ${item.data.kitName}, Type: ${item.type}, isAvailable: ${item.data.isAvailable}, SearchableIndex: ${item.data.searchableIndex}`);
    //   }
    // });
    // console.log(`[Vercel] Richiesta query AI: ${userQuery}`); // <<< NUOVO LOG

    if (!isAllDataRequest) { // Solo se non è una richiesta per tutti i dati (cioè, c'è una query utente specifica)
        const systemPrompt = `Sei un assistente di ricerca molto amichevole per una piattaforma e-commerce locale chiamata "Localmente".
Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività nel database che ti passo.
Rispondi SEMPRE in italiano, con tono positivo e utile, come un commesso esperto che consiglia.
Non inventare nulla: usa solo i dati che ti vengono forniti.`;

        const userMessage = `Ecco la query dell'utente: "${translatedQuery}".
Ecco i dati disponibili (JSON): ${JSON.stringify(relevantData)}.
Genera una risposta naturale e utile, usando solo questi dati.`;

        const completion = await openai.chat.completions.create({
            model: "mistralai/mistral-7b-instruct",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            temperature: 0.7,
            max_tokens: 300,
        });
        aiResponse = completion.choices[0].message.content;
    }


    // 🔹 Risposta finale all’app
    return res.status(200).json(relevantData); // <<< MODIFICATO: Restituisce direttamente i dati rilevanti, senza aiResponse se query è 'all'
    // Se vuoi la AI Response solo per query specifiche:
    // return res.status(200).json({
    //   query: translatedQuery,
    //   aiResponse: aiResponse,
    //   results: relevantData, // Ora relevantData sono i veri risultati
    // });

  } catch (error) {
    console.error('[Vercel] ERRORE GENERALE:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
};
