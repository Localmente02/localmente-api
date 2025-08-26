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
    const snapshot = await db.collection(collectionName).get();
    if (snapshot.empty) return [];

    return snapshot.docs.map(doc => ({
      id: doc.id,
      type,
      data: doc.data()
    }));
  } catch (error) {
    console.error(`Errore fetch collezione '${collectionName}':`, error);
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
    // 🔹 Estraggo la query dell’utente
    let { userQuery } = req.body;
    if (!userQuery) {
      return res.status(400).json({ error: 'Manca userQuery nel body.' });
    }

    // 🔹 Traduco la query in italiano (per sicurezza)
    let translatedQuery = userQuery;
    try {
      const result = await translate(userQuery, { to: 'it' });
      translatedQuery = result.text;
    } catch (err) {
      console.error('Errore traduzione:', err);
    }

    // 🔹 Recupero dati dalle collezioni Firestore
    const [products, vendors] = await Promise.all([
      fetchAllFromCollection('global_product_catalog', 'product'),
      fetchAllFromCollection('vendors', 'vendor'),
    ]);
    const relevantData = [...products, ...vendors];

    // 🔹 Prompt di sistema per l’AI
    const systemPrompt = `Sei un assistente di ricerca molto amichevole per una piattaforma e-commerce locale chiamata "Localmente".
Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività nel database che ti passo.
Rispondi SEMPRE in italiano, con tono positivo e utile, come un commesso esperto che consiglia.
Non inventare nulla: usa solo i dati che ti vengono forniti.`;

    // 🔹 Creo il messaggio utente per l’AI
    const userMessage = `Ecco la query dell'utente: "${translatedQuery}".
Ecco i dati disponibili (JSON): ${JSON.stringify(relevantData)}.
Genera una risposta naturale e utile, usando solo questi dati.`;

    // 🔹 Chiamo l’AI
    const completion = await openai.chat.completions.create({
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 300,
    });

    const aiResponse = completion.choices[0].message.content;

    // 🔹 Risposta finale all’app
    return res.status(200).json({
      query: translatedQuery,
      aiResponse,
      rawData: relevantData, // opzionale: se vuoi anche i dati grezzi
    });

  } catch (error) {
    console.error('ERRORE GENERALE:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
};
