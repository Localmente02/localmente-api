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

// 🔹 Funzione helper: legge una collezione intera (Filtra per isAvailable == true)
const fetchAllFromCollection = async (collectionName, type) => {
  try {
    const snapshot = await db.collection(collectionName)
                               .where('isAvailable', '==', true) // Filtra solo gli elementi disponibili
                               .get();
    if (snapshot.empty) return [];

    return snapshot.docs.map(doc => {
      const data = doc.data();
      const docType = data.type || type; // Se il documento ha un suo type, usalo. Altrimenti usa il type predefinito.

      // <<< NUOVA LOGICA: Adatta i dati del kit per UniversalSearchResultItem/KitRicettaModel >>>
      let adaptedData = { ...data }; // Inizia con tutti i dati originali

      if (docType === 'kit') {
        // Mappa i nomi specifici del kit ai nomi più generici/attesi
        adaptedData.productName = data.kitName; // Per UniversalSearchResult.name
        adaptedData.price = data.basePrice; // Per UniversalSearchResult.price
        adaptedData.productImageUrl = data.imageUrl; // Per UniversalSearchResult.imageUrl
        adaptedData.brand = data.vendorStoreName; // Per UniversalSearchResult.brand

        // Assicurati che i campi di dettaglio siano al top level o facilmente accessibili
        // (KitRicettaModel.fromMap cerca kitName, recipeText, videoUrl direttamente in 'data')
        adaptedData.kitName = data.kitName; // Esplicito per KitRicettaModel.fromMap
        adaptedData.recipeText = data.recipeText; // Esplicito
        adaptedData.videoUrl = data.videoUrl; // Esplicito
        adaptedData.description = data.description; // Esplicito
        adaptedData.difficulty = data.difficulty; // Esplicito
        adaptedData.preparationTime = data.preparationTime; // Esplicito
        adaptedData.galleryImageUrls = data.galleryImageUrls; // Esplicito

        // Se ingredientsList è sotto kitDetails, portalo al top level di adaptedData per KitRicettaModel.fromMap
        if (data.kitDetails && data.kitDetails.ingredientsList) {
          adaptedData.ingredients = data.kitDetails.ingredientsList;
        } else {
          adaptedData.ingredients = data.ingredients; // Fallback se non è annidato
        }
        if (data.kitDetails && data.kitDetails.servingsData) {
          adaptedData.servingsData = data.kitDetails.servingsData;
        } else {
          adaptedData.servingsData = data.servingsData; // Fallback se non è annidato
        }
      }
      // <<< FINE NUOVA LOGICA >>>

      return {
        id: doc.id,
        type: docType,
        data: adaptedData // Restituisce i dati adattati
      };
    });
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
    if (!userQuery) {
      userQuery = "all";
    }

    let translatedQuery = userQuery;
    let aiResponseContent = null;

    if (userQuery !== "all") {
        try {
            const result = await translate(userQuery, { to: 'it' });
            translatedQuery = result.text;
        } catch (err) {
            console.error('[Vercel] Errore traduzione:', err);
        }

        // 🔹 Recupero dati dalle collezioni Firestore (necessario qui per l'AI)
        const [globalCatalogItems, vendors] = await Promise.all([
          fetchAllFromCollection('global_product_catalog', 'product'),
          fetchAllFromCollection('vendors', 'vendor'),
        ]);
        const relevantData = [...globalCatalogItems, ...vendors];


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
        aiResponseContent = completion.choices[0].message.content;
    } else {
        // Se userQuery è "all", recuperiamo i dati qui e li passiamo direttamente
        const [globalCatalogItems, vendors] = await Promise.all([
            fetchAllFromCollection('global_product_catalog', 'product'),
            fetchAllFromCollection('vendors', 'vendor'),
        ]);
        relevantData = [...globalCatalogItems, ...vendors]; // Assegna a relevantData per la risposta
    }


    // 🔹 Risposta finale all’app
    return res.status(200).json({
      query: translatedQuery,
      aiResponse: aiResponseContent,
      results: relevantData,
    });

  } catch (error) {
    console.error('[Vercel] ERRORE GENERALE:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
};
